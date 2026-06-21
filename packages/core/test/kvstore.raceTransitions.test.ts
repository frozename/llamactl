import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type KvEntry, KvRegistry, openKvStorage } from "../src/kvstore/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

function makeTempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-kvstore-race-"));
  return {
    root,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function baseEntry(overrides: Partial<KvEntry> = {}): KvEntry {
  return {
    sha: "sha-base",
    workload: "foo",
    model: null,
    upstreamSlotFile: "/tmp/slot.bin",
    quantBits: 4,
    tokens: 128,
    ctxSize: 32768,
    hits: 0,
    createdAt: 1716576000,
    lastUsed: 1716576000,
    payloadBytes: 1024,
    textBytes: 512,
    reason: "cold",
    prefixByteLength: 16,
    workloadEpoch: "epoch-1",
    quarantined: 0,
    state: "idle",
    firstResponseToken: null,
    extFlags: 0,
    ...overrides,
  };
}

test("reserve succeeds only for idle entries", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slot.bin");
    writeFileSync(slotFile, "payload");
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: "entry", upstreamSlotFile: slotFile, state: "idle" }));

    expect(registry.reserve("entry")).toBe(true);
    expect(registry.reserve("entry")).toBe(false);
    expect(registry.get("entry")?.state).toBe("reserved");
    expect(registry.activate("entry")).toBe(true);
    expect(registry.reserve("entry")).toBe(false);
    expect(registry.get("entry")?.state).toBe("active");
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("activate requires reserved state", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slot.bin");
    writeFileSync(slotFile, "payload");
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: "entry", upstreamSlotFile: slotFile, state: "idle" }));

    expect(registry.activate("entry")).toBe(false);
    expect(registry.reserve("entry")).toBe(true);
    expect(registry.activate("entry")).toBe(true);
    expect(registry.activate("entry")).toBe(false);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("release transitions reserved or active back to idle", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slot.bin");
    writeFileSync(slotFile, "payload");
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: "entry", upstreamSlotFile: slotFile, state: "idle" }));

    expect(registry.release("entry")).toBe(false);
    expect(registry.reserve("entry")).toBe(true);
    expect(registry.release("entry")).toBe(true);
    expect(registry.get("entry")?.state).toBe("idle");
    expect(registry.reserve("entry")).toBe(true);
    expect(registry.activate("entry")).toBe(true);
    expect(registry.release("entry")).toBe(true);
    expect(registry.get("entry")?.state).toBe("idle");
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("tryDelete only removes idle entries", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slot.bin");
    writeFileSync(slotFile, "payload");
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: "idle", upstreamSlotFile: slotFile, state: "idle" }));
    registry.insert(baseEntry({ sha: "reserved", upstreamSlotFile: slotFile, state: "reserved" }));
    registry.insert(baseEntry({ sha: "active", upstreamSlotFile: slotFile, state: "active" }));

    expect(registry.tryDelete("idle")).toBe(true);
    expect(registry.get("idle")).toBeNull();
    expect(registry.tryDelete("reserved")).toBe(false);
    expect(registry.tryDelete("active")).toBe(false);
    expect(registry.get("reserved")?.sha).toBe("reserved");
    expect(registry.get("active")?.sha).toBe("active");
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("concurrent reserve calls allow exactly one winner", async () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slot.bin");
    writeFileSync(slotFile, "payload");

    const storageA = openKvStorage(t.root);
    const storageB = openKvStorage(t.root);
    const registryA = new KvRegistry(storageA);
    const registryB = new KvRegistry(storageB);
    registryA.insert(baseEntry({ sha: "shared", upstreamSlotFile: slotFile, state: "idle" }));

    const [a, b] = await Promise.all([
      Promise.resolve().then(() => registryA.reserve("shared")),
      Promise.resolve().then(() => registryB.reserve("shared")),
    ]);

    expect(Number(a) + Number(b)).toBe(1);
    const winnerState = registryA.get("shared")?.state;
    expect(winnerState).toBe("reserved");
    storageA.close();
    storageB.close();
  } finally {
    t.cleanup();
  }
});
