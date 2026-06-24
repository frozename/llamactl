import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type KvEntry,
  KvRegistry,
  openKvStorage,
  sweepOrphanSlotFiles,
} from "../src/kvstore/index.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "../src/safe-fs.js";

function makeTempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-kvstore-orphans-"));
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

test("old orphan slot file is deleted", () => {
  const t = makeTempRoot();
  try {
    const slotDir = join(t.root, "slots");
    mkdirSync(slotDir, { recursive: true });
    const orphanPath = join(slotDir, "orphan-sha.kvslot");
    writeFileSync(orphanPath, "old-orphan");
    const now = Date.now();
    utimesSync(orphanPath, new Date(now - 20_000), new Date(now - 20_000));

    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    const result = sweepOrphanSlotFiles({ slotDir, registry, ttlMs: 10_000, now });
    expect(result).toEqual({ orphansFound: 1, orphansDeleted: 1 });
    expect(existsSync(orphanPath)).toBe(false);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("slot file with registry entry is preserved", () => {
  const t = makeTempRoot();
  try {
    const slotDir = join(t.root, "slots");
    mkdirSync(slotDir, { recursive: true });
    const slotPath = join(slotDir, "keep-sha.kvslot");
    writeFileSync(slotPath, "in-registry");
    const now = Date.now();
    utimesSync(slotPath, new Date(now - 20_000), new Date(now - 20_000));

    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry({ sha: "keep-sha", upstreamSlotFile: slotPath }));

    const result = sweepOrphanSlotFiles({ slotDir, registry, ttlMs: 10_000, now });
    expect(result).toEqual({ orphansFound: 0, orphansDeleted: 0 });
    expect(existsSync(slotPath)).toBe(true);
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("recent orphan slot file is not deleted", () => {
  const t = makeTempRoot();
  try {
    const slotDir = join(t.root, "slots");
    mkdirSync(slotDir, { recursive: true });
    const orphanPath = join(slotDir, "recent-orphan.kvslot");
    writeFileSync(orphanPath, "recent");
    const now = Date.now();
    utimesSync(orphanPath, new Date(now - 1_000), new Date(now - 1_000));

    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    const result = sweepOrphanSlotFiles({ slotDir, registry, ttlMs: 10_000, now });
    expect(result).toEqual({ orphansFound: 1, orphansDeleted: 0 });
    expect(existsSync(orphanPath)).toBe(true);
    storage.close();
  } finally {
    t.cleanup();
  }
});

/**
 * A KvRegistry that counts how many times the sweep reaches into the DB so we
 * can pin the query shape: O(1) `listAll` instead of O(n) `findBySha`. It
 * delegates to a real registry so correctness still flows through SQLite.
 */
class CountingRegistry extends KvRegistry {
  findByShaCalls = 0;
  listAllCalls = 0;

  override findBySha(sha: string): KvEntry | null {
    this.findByShaCalls += 1;
    return super.findBySha(sha);
  }

  override listAll(): KvEntry[] {
    this.listAllCalls += 1;
    return super.listAll();
  }
}

test("sweep issues one batched DB read regardless of slot-file count", () => {
  const t = makeTempRoot();
  try {
    const slotDir = join(t.root, "slots");
    mkdirSync(slotDir, { recursive: true });
    const now = Date.now();
    const slotCount = 5;
    for (let i = 0; i < slotCount; i += 1) {
      const slotPath = join(slotDir, `orphan-${String(i)}.kvslot`);
      writeFileSync(slotPath, `orphan-${String(i)}`);
      utimesSync(slotPath, new Date(now - 20_000), new Date(now - 20_000));
    }

    const storage = openKvStorage(t.root);
    const registry = new CountingRegistry(storage);
    sweepOrphanSlotFiles({ slotDir, registry, ttlMs: 10_000, now });

    expect(registry.listAllCalls).toBe(1);
    expect(registry.findByShaCalls).toBe(0);
    storage.close();
  } finally {
    t.cleanup();
  }
});
