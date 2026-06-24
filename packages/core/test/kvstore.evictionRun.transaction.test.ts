import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type KvEntry,
  KvRegistry,
  openKvStorage,
  runEvictionIfOverBudget,
} from "../src/kvstore/index.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

function makeTempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-kvstore-evictionrun-tx-"));
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

test("over-budget eviction opens exactly one transaction and evicts the same rows", () => {
  const t = makeTempRoot();
  try {
    const slotA = join(t.root, "slot-a.bin");
    const slotB = join(t.root, "slot-b.bin");
    const slotC = join(t.root, "slot-c.bin");
    for (const f of [slotA, slotB, slotC]) writeFileSync(f, "payload");
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry(slotA, { sha: "a", payloadBytes: 1000, lastUsed: 1 }));
    registry.insert(baseEntry(slotB, { sha: "b", payloadBytes: 2000, lastUsed: 2 }));
    registry.insert(baseEntry(slotC, { sha: "c", payloadBytes: 3000, lastUsed: 3 }));

    let txCalls = 0;
    const original = registry.transaction.bind(registry);
    registry.transaction = <T>(fn: () => T): T => {
      txCalls += 1;
      return original(fn);
    };

    const initialTotal = 1000 + 2000 + 3000;
    const result = runEvictionIfOverBudget(registry, "wl", 1500, 1716576000 + 60_000);

    // Delete loop runs inside exactly one write transaction.
    expect(txCalls).toBe(1);
    // Same eviction outcome as the pre-transaction implementation.
    expect(result.deleted.length).toBeGreaterThan(0);
    expect(result.totalPayloadBytesBefore).toBe(initialTotal);
    expect(result.totalPayloadBytesAfter).toBeLessThanOrEqual(1500);
    // Rows are actually gone from the registry.
    for (const sha of result.deleted) {
      expect(registry.findBySha(sha)).toBeNull();
    }
    // Slot artifacts for evicted entries are unlinked (file I/O still happens,
    // just after the transaction commits).
    const fileForSha: Record<string, string> = { a: slotA, b: slotB, c: slotC };
    for (const sha of result.deleted) {
      expect(existsSync(fileForSha[sha] ?? "")).toBe(false);
    }
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("under-budget early return opens no transaction", () => {
  const t = makeTempRoot();
  try {
    const slotFile = join(t.root, "slot.bin");
    writeFileSync(slotFile, "payload");
    const storage = openKvStorage(t.root);
    const registry = new KvRegistry(storage);
    registry.insert(baseEntry(slotFile, { sha: "a", payloadBytes: 1000 }));
    registry.insert(baseEntry(slotFile, { sha: "b", payloadBytes: 2000 }));

    let txCalls = 0;
    const original = registry.transaction.bind(registry);
    registry.transaction = <T>(fn: () => T): T => {
      txCalls += 1;
      return original(fn);
    };

    const initialTotal = 1000 + 2000;
    const result = runEvictionIfOverBudget(registry, "wl", initialTotal + 1, 1716576000 + 60_000);

    expect(txCalls).toBe(0);
    expect(result.deleted).toEqual([]);
    expect(result.totalPayloadBytesBefore).toBe(initialTotal);
    expect(result.totalPayloadBytesAfter).toBe(initialTotal);
    // Slot file untouched.
    expect(existsSync(slotFile)).toBe(true);
    storage.close();
  } finally {
    t.cleanup();
  }
});
