import { expect, test } from "bun:test";
import {
  ResponseCacheRegistry,
  openResponseCacheStorage,
  responseEvictionScore,
  runResponseCacheEvictionIfOverBudget,
  type ResponseCacheEntry,
} from "../../src/responsecache/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "llamactl-responsecache-policy-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
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

function defaultLookup(sha: string) {
  return {
    sha,
    model: "model-a",
    workload: "",
    workloadEpoch: "",
    protocolVariant: "openai" as const,
  };
}

test("hits decay with a 6h half-life", () => {
  const now = 1716576000 + 60_000;
  const recent = responseEvictionScore(baseEntry({ hits: 10, lastUsed: now - 60_000 }), now);
  const stale = responseEvictionScore(
    baseEntry({ hits: 10, lastUsed: now - 6 * 3600 * 1000 }),
    now,
  );
  expect(stale).toBeGreaterThan(recent);
});

test("larger entries score higher than smaller ones at equal recency and hits", () => {
  const now = 1716576000 + 60_000;
  const small = responseEvictionScore(
    baseEntry({
      requestBodyBytes: 10_000,
      responseBodyBytes: 10_000,
      hits: 2,
      lastUsed: now - 1_000,
    }),
    now,
  );
  const large = responseEvictionScore(
    baseEntry({
      requestBodyBytes: 1_000_000,
      responseBodyBytes: 1_000_000,
      hits: 2,
      lastUsed: now - 1_000,
    }),
    now,
  );
  expect(large).toBeGreaterThan(small);
});

test("eviction ordering drops highest-score rows first when over budget", () => {
  const t = makeTempRoot();
  try {
    const storage = openResponseCacheStorage(t.root);
    const registry = new ResponseCacheRegistry(storage);
    const now = Date.now();
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

    const result = runResponseCacheEvictionIfOverBudget(registry, 700_000, now);
    expect(result.totalBytesBefore).toBeGreaterThan(700_000);
    expect(result.totalBytesAfter).toBeLessThanOrEqual(700_000);
    expect(result.deleted.length).toBeGreaterThan(0);
    expect(registry.findBySha(defaultLookup("keep-hot"))).not.toBeNull();
    storage.close();
  } finally {
    t.cleanup();
  }
});
