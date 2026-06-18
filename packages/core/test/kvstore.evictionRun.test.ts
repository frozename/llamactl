import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type KvEntry,
  KvRegistry,
  openKvStorage,
  runEvictionIfOverBudget,
} from "../src/kvstore/index.js";

function makeTempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-kvstore-evictionrun-"));
  return {
    root,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function baseEntry(slotFile: string, overrides: Partial<KvEntry> = {}): KvEntry {
  return {
    sha: "sha-base",
    workload: "wl",
    model: null,
    upstreamSlotFile: slotFile,
    quantBits: 8,
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

test("under-budget early return reports Before == initial total (== After)", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slot.bin");
    writeFileSync(slotFile, "payload");
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry(slotFile, { sha: "a", payloadBytes: 1000 }));
    registry.insert(baseEntry(slotFile, { sha: "b", payloadBytes: 2000 }));

    const initialTotal = 1000 + 2000;
    // byteBudget above the initial total -> early-return path, no deletions.
    const result = runEvictionIfOverBudget(registry, "wl", initialTotal + 1, 1716576000 + 60_000);

    expect(result.deleted).toEqual([]);
    expect(result.totalPayloadBytesBefore).toBe(initialTotal);
    expect(result.totalPayloadBytesAfter).toBe(initialTotal);
  } finally {
    t.cleanup();
  }
});

test("over-budget eviction reports Before == initial total even after After decrements", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slot.bin");
    writeFileSync(slotFile, "payload");
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry(slotFile, { sha: "a", payloadBytes: 1000, lastUsed: 1 }));
    registry.insert(baseEntry(slotFile, { sha: "b", payloadBytes: 2000, lastUsed: 2 }));
    registry.insert(baseEntry(slotFile, { sha: "c", payloadBytes: 3000, lastUsed: 3 }));

    const initialTotal = 1000 + 2000 + 3000;
    // byteBudget below the initial total -> eviction loop runs and decrements
    // the running after-total; Before must still equal the captured initial total.
    const result = runEvictionIfOverBudget(registry, "wl", 1500, 1716576000 + 60_000);

    expect(result.deleted.length).toBeGreaterThan(0);
    expect(result.totalPayloadBytesBefore).toBe(initialTotal);
    expect(result.totalPayloadBytesAfter).toBeLessThan(initialTotal);
    expect(result.totalPayloadBytesAfter).toBeLessThanOrEqual(1500);
  } finally {
    t.cleanup();
  }
});
