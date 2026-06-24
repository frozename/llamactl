import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openResponseCacheStorage,
  type ResponseCacheEntry,
  ResponseCacheRegistry,
  runResponseCacheEvictionIfOverBudget,
} from "../../src/responsecache/index.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

function makeTempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-responsecache-policy-tx-"));
  return {
    root,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function baseEntry(overrides: Partial<ResponseCacheEntry> = {}): ResponseCacheEntry {
  return {
    sha: "sha",
    model: "model-a",
    workload: "",
    workloadEpoch: "",
    protocolVariant: "openai",
    contentType: "application/json",
    statusCode: 200,
    responseBody: new TextEncoder().encode('{"ok":true}'),
    requestBodyBytes: 1024,
    responseBodyBytes: 1024,
    createdAt: 1,
    lastUsed: 1,
    hits: 0,
    ...overrides,
  };
}

function defaultLookup(sha: string): {
  sha: string;
  model: string;
  workload: string;
  workloadEpoch: string;
  protocolVariant: "openai";
} {
  return {
    sha,
    model: "model-a",
    workload: "",
    workloadEpoch: "",
    protocolVariant: "openai" as const,
  };
}

function seedThreeOverBudget(registry: ResponseCacheRegistry, now: number): void {
  registry.insert(
    baseEntry({
      sha: "keep-hot",
      hits: 20,
      lastUsed: now - 5_000,
      requestBodyBytes: 100_000,
      responseBodyBytes: 100_000,
    }),
  );
  registry.insert(
    baseEntry({
      sha: "drop-old",
      hits: 0,
      lastUsed: now - 20_000_000,
      requestBodyBytes: 300_000,
      responseBodyBytes: 300_000,
    }),
  );
  registry.insert(
    baseEntry({
      sha: "drop-big",
      hits: 1,
      lastUsed: now - 10_000_000,
      requestBodyBytes: 350_000,
      responseBodyBytes: 350_000,
    }),
  );
}

test("over-budget eviction opens exactly one transaction and evicts the same rows", () => {
  const t = makeTempRoot();
  try {
    const storage = openResponseCacheStorage(t.root);
    const registry = new ResponseCacheRegistry(storage);
    const now = Date.now();
    seedThreeOverBudget(registry, now);

    let txCalls = 0;
    const original = registry.transaction.bind(registry);
    registry.transaction = <T>(fn: () => T): T => {
      txCalls += 1;
      return original(fn);
    };

    const result = runResponseCacheEvictionIfOverBudget(registry, 700_000, now);

    // The delete loop runs inside exactly one write transaction (one lock hold).
    expect(txCalls).toBe(1);
    // Eviction outcome is transparent: same rows evicted, hot row survives.
    expect(result.totalBytesBefore).toBeGreaterThan(700_000);
    expect(result.totalBytesAfter).toBeLessThanOrEqual(700_000);
    expect(result.deleted.length).toBeGreaterThan(0);
    expect(registry.findBySha(defaultLookup("keep-hot"))).not.toBeNull();
    expect(registry.findBySha(defaultLookup("drop-old"))).toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});

test("under-budget early return opens no transaction", () => {
  const t = makeTempRoot();
  try {
    const storage = openResponseCacheStorage(t.root);
    const registry = new ResponseCacheRegistry(storage);
    const now = Date.now();
    registry.insert(
      baseEntry({ sha: "a", requestBodyBytes: 1000, responseBodyBytes: 0, lastUsed: now }),
    );
    registry.insert(
      baseEntry({ sha: "b", requestBodyBytes: 2000, responseBodyBytes: 0, lastUsed: now }),
    );

    let txCalls = 0;
    const original = registry.transaction.bind(registry);
    registry.transaction = <T>(fn: () => T): T => {
      txCalls += 1;
      return original(fn);
    };

    const result = runResponseCacheEvictionIfOverBudget(registry, 1_000_000, now);

    expect(txCalls).toBe(0);
    expect(result.deleted).toEqual([]);
    expect(result.totalBytesBefore).toBe(3000);
    expect(result.totalBytesAfter).toBe(3000);
    storage.close();
  } finally {
    t.cleanup();
  }
});
