import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openResponseCacheStorage,
  type ResponseCacheEntry,
  type ResponseCacheLookup,
  ResponseCacheRegistry,
} from "../../src/responsecache/index.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

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

function lookupOf(entry: ResponseCacheEntry): ResponseCacheLookup {
  return {
    sha: entry.sha,
    model: entry.model,
    workload: entry.workload,
    workloadEpoch: entry.workloadEpoch,
    protocolVariant: entry.protocolVariant,
  };
}

function withRegistry(
  fn: (
    registry: ResponseCacheRegistry,
    storage: ReturnType<typeof openResponseCacheStorage>,
  ) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "llamactl-responsecache-registry-"));
  const storage = openResponseCacheStorage(root);
  try {
    fn(new ResponseCacheRegistry(storage), storage);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("round trip: insert and findBySha returns every field unchanged", (): void => {
  withRegistry((registry, storage) => {
    const entry: ResponseCacheEntry = baseEntry({
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "anthropic",
      contentType: "text/event-stream",
      statusCode: 203,
      requestBodyBytes: 11,
      responseBodyBytes: 22,
      createdAt: 100,
      lastUsed: 200,
      hits: 3,
      responseBody: new TextEncoder().encode("hello"),
    });

    registry.insert(entry);

    const found = registry.findBySha(lookupOf(entry));
    expect(found).not.toBeNull();
    expect(found!.sha).toBe(entry.sha);
    expect(found!.model).toBe(entry.model);
    expect(found!.workload).toBe(entry.workload);
    expect(found!.workloadEpoch).toBe(entry.workloadEpoch);
    expect(found!.protocolVariant).toBe(entry.protocolVariant);
    expect(found!.contentType).toBe(entry.contentType);
    expect(found!.statusCode).toBe(entry.statusCode);
    expect(found!.requestBodyBytes).toBe(entry.requestBodyBytes);
    expect(found!.responseBodyBytes).toBe(entry.responseBodyBytes);
    expect(found!.createdAt).toBe(entry.createdAt);
    expect(found!.lastUsed).toBe(entry.lastUsed);
    expect(found!.hits).toBe(entry.hits);
    expect(new TextDecoder().decode(found!.responseBody)).toBe("hello");
  });
});

test("miss: findBySha on empty db returns null", (): void => {
  withRegistry((registry) => {
    const lookup: ResponseCacheLookup = {
      sha: "nonexistent",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
    };

    expect(registry.findBySha(lookup)).toBeNull();
  });
});

test("key isolation: lookup differing in one key column returns null", (): void => {
  withRegistry((registry) => {
    const entry: ResponseCacheEntry = baseEntry({
      sha: "sha-iso",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
    });

    registry.insert(entry);

    const exact = lookupOf(entry);
    expect(registry.findBySha(exact)).not.toBeNull();

    const lookupSha: ResponseCacheLookup = { ...exact, sha: "other" };
    expect(registry.findBySha(lookupSha)).toBeNull();

    const lookupModel: ResponseCacheLookup = { ...exact, model: "model-b" };
    expect(registry.findBySha(lookupModel)).toBeNull();

    const lookupWorkload: ResponseCacheLookup = { ...exact, workload: "wl-b" };
    expect(registry.findBySha(lookupWorkload)).toBeNull();

    const lookupEpoch: ResponseCacheLookup = { ...exact, workloadEpoch: "e2" };
    expect(registry.findBySha(lookupEpoch)).toBeNull();

    const lookupVariant: ResponseCacheLookup = { ...exact, protocolVariant: "anthropic" };
    expect(registry.findBySha(lookupVariant)).toBeNull();
  });
});

test("upsert: second insert with same key updates fields, listAll has length 1", (): void => {
  withRegistry((registry) => {
    const entry: ResponseCacheEntry = baseEntry({
      sha: "sha-upsert",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
      responseBody: new TextEncoder().encode("v1"),
      statusCode: 200,
      hits: 1,
      lastUsed: 100,
      createdAt: 500,
      contentType: "application/json",
      requestBodyBytes: 100,
      responseBodyBytes: 200,
    });

    registry.insert(entry);

    const updated: ResponseCacheEntry = baseEntry({
      sha: "sha-upsert",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
      responseBody: new TextEncoder().encode("v2"),
      statusCode: 500,
      hits: 7,
      lastUsed: 900,
      createdAt: 800,
      contentType: "text/event-stream",
      requestBodyBytes: 300,
      responseBodyBytes: 400,
    });

    registry.insert(updated);

    const all = registry.listAll();
    expect(all.length).toBe(1);

    const found = registry.findBySha(lookupOf(updated));
    expect(found).not.toBeNull();
    expect(found!.statusCode).toBe(500);
    expect(new TextDecoder().decode(found!.responseBody)).toBe("v2");
    expect(found!.hits).toBe(7);
    expect(found!.lastUsed).toBe(900);
    expect(found!.createdAt).toBe(800);
    expect(found!.contentType).toBe("text/event-stream");
    expect(found!.requestBodyBytes).toBe(300);
    expect(found!.responseBodyBytes).toBe(400);
  });
});

test("same sha, distinct scope coexists: two rows with different protocolVariant", (): void => {
  withRegistry((registry) => {
    const entryOpenai: ResponseCacheEntry = baseEntry({
      sha: "sha-scoped",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
      responseBody: new TextEncoder().encode("openai-body"),
    });

    const entryResponses: ResponseCacheEntry = baseEntry({
      sha: "sha-scoped",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "responses",
      responseBody: new TextEncoder().encode("responses-body"),
    });

    registry.insert(entryOpenai);
    registry.insert(entryResponses);

    const all = registry.listAll();
    expect(all.length).toBe(2);

    const lookupOpenai: ResponseCacheLookup = lookupOf(entryOpenai);
    const lookupResponses: ResponseCacheLookup = lookupOf(entryResponses);

    const foundOpenai = registry.findBySha(lookupOpenai);
    expect(foundOpenai).not.toBeNull();
    expect(new TextDecoder().decode(foundOpenai!.responseBody)).toBe("openai-body");

    const foundResponses = registry.findBySha(lookupResponses);
    expect(foundResponses).not.toBeNull();
    expect(new TextDecoder().decode(foundResponses!.responseBody)).toBe("responses-body");
  });
});

test("bumpHit scoping: only bumps the matched row", (): void => {
  withRegistry((registry) => {
    const entryA: ResponseCacheEntry = baseEntry({
      sha: "sha-bump",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
      hits: 0,
      lastUsed: 1,
    });

    const entryB: ResponseCacheEntry = baseEntry({
      sha: "sha-bump",
      model: "model-a",
      workload: "wl-b",
      workloadEpoch: "e1",
      protocolVariant: "openai",
      hits: 0,
      lastUsed: 1,
    });

    registry.insert(entryA);
    registry.insert(entryB);

    const lookupA = lookupOf(entryA);
    const lookupB = lookupOf(entryB);

    registry.bumpHit(lookupA, 500);
    registry.bumpHit(lookupA, 500);

    const foundA = registry.findBySha(lookupA);
    expect(foundA).not.toBeNull();
    expect(foundA!.hits).toBe(2);
    expect(foundA!.lastUsed).toBe(500);

    const foundB = registry.findBySha(lookupB);
    expect(foundB).not.toBeNull();
    expect(foundB!.hits).toBe(0);
    expect(foundB!.lastUsed).toBe(1);
  });
});

test("bumpHit pins all five key columns: differing in one column leaves siblings untouched", (): void => {
  withRegistry((registry) => {
    const base: ResponseCacheEntry = baseEntry({
      sha: "sha-bump5",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
      hits: 0,
      lastUsed: 100,
    });

    const shaDiff: ResponseCacheEntry = baseEntry({
      ...base,
      sha: "sha-bump5-other",
    });
    const modelDiff: ResponseCacheEntry = baseEntry({
      ...base,
      model: "model-b",
    });
    const wlDiff: ResponseCacheEntry = baseEntry({
      ...base,
      workload: "wl-b",
    });
    const epochDiff: ResponseCacheEntry = baseEntry({
      ...base,
      workloadEpoch: "e2",
    });
    const variantDiff: ResponseCacheEntry = baseEntry({
      ...base,
      protocolVariant: "anthropic",
    });

    registry.insert(base);
    registry.insert(shaDiff);
    registry.insert(modelDiff);
    registry.insert(wlDiff);
    registry.insert(epochDiff);
    registry.insert(variantDiff);

    registry.bumpHit(lookupOf(base), 999);

    const foundBase = registry.findBySha(lookupOf(base));
    expect(foundBase).not.toBeNull();
    expect(foundBase!.hits).toBe(1);
    expect(foundBase!.lastUsed).toBe(999);

    const foundSha = registry.findBySha(lookupOf(shaDiff));
    expect(foundSha).not.toBeNull();
    expect(foundSha!.hits).toBe(0);
    expect(foundSha!.lastUsed).toBe(100);

    const foundModel = registry.findBySha(lookupOf(modelDiff));
    expect(foundModel).not.toBeNull();
    expect(foundModel!.hits).toBe(0);
    expect(foundModel!.lastUsed).toBe(100);

    const foundWl = registry.findBySha(lookupOf(wlDiff));
    expect(foundWl).not.toBeNull();
    expect(foundWl!.hits).toBe(0);
    expect(foundWl!.lastUsed).toBe(100);

    const foundEpoch = registry.findBySha(lookupOf(epochDiff));
    expect(foundEpoch).not.toBeNull();
    expect(foundEpoch!.hits).toBe(0);
    expect(foundEpoch!.lastUsed).toBe(100);

    const foundVariant = registry.findBySha(lookupOf(variantDiff));
    expect(foundVariant).not.toBeNull();
    expect(foundVariant!.hits).toBe(0);
    expect(foundVariant!.lastUsed).toBe(100);
  });
});

test("tryDelete: returns false on missing, true on existing, sibling survives", (): void => {
  withRegistry((registry) => {
    const lookupMissing: ResponseCacheLookup = {
      sha: "sha-missing",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
    };

    expect(registry.tryDelete(lookupMissing)).toBe(false);

    const entry: ResponseCacheEntry = baseEntry({
      sha: "sha-delete",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
    });

    const sibling: ResponseCacheEntry = baseEntry({
      sha: "sha-delete",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e2",
      protocolVariant: "openai",
    });

    registry.insert(entry);
    registry.insert(sibling);

    const lookup = lookupOf(entry);
    expect(registry.tryDelete(lookup)).toBe(true);
    expect(registry.findBySha(lookup)).toBeNull();

    const siblingLookup = lookupOf(sibling);
    expect(registry.findBySha(siblingLookup)).not.toBeNull();
  });
});

test("tryDelete pins all five key columns: deleting one leaves siblings with different single column", (): void => {
  withRegistry((registry) => {
    const base: ResponseCacheEntry = baseEntry({
      sha: "sha-del5",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
    });

    const shaDiff: ResponseCacheEntry = baseEntry({
      ...base,
      sha: "sha-del5-other",
    });
    const modelDiff: ResponseCacheEntry = baseEntry({
      ...base,
      model: "model-b",
    });
    const wlDiff: ResponseCacheEntry = baseEntry({
      ...base,
      workload: "wl-b",
    });
    const epochDiff: ResponseCacheEntry = baseEntry({
      ...base,
      workloadEpoch: "e2",
    });
    const variantDiff: ResponseCacheEntry = baseEntry({
      ...base,
      protocolVariant: "anthropic",
    });

    registry.insert(base);
    registry.insert(shaDiff);
    registry.insert(modelDiff);
    registry.insert(wlDiff);
    registry.insert(epochDiff);
    registry.insert(variantDiff);

    registry.tryDelete(lookupOf(base));

    expect(registry.findBySha(lookupOf(base))).toBeNull();

    const entries = [shaDiff, modelDiff, wlDiff, epochDiff, variantDiff];
    for (const entry of entries) {
      expect(registry.findBySha(lookupOf(entry))).not.toBeNull();
    }
  });
});

test("listForModel / listAll: ordered by sha ascending, filtered by model", (): void => {
  withRegistry((registry) => {
    const entryC: ResponseCacheEntry = baseEntry({
      sha: "c",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
    });

    const entryA: ResponseCacheEntry = baseEntry({
      sha: "a",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
    });

    const entryB: ResponseCacheEntry = baseEntry({
      sha: "b",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
    });

    const entryZ: ResponseCacheEntry = baseEntry({
      sha: "z",
      model: "model-b",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
    });

    registry.insert(entryC);
    registry.insert(entryA);
    registry.insert(entryB);
    registry.insert(entryZ);

    const modelA = registry.listForModel("model-a");
    expect(modelA.map((e) => e.sha)).toEqual(["a", "b", "c"]);

    const all = registry.listAll();
    expect(all.map((e) => e.sha)).toEqual(["a", "b", "c", "z"]);
  });
});

test("transaction: rollback on error, commit on success", (): void => {
  withRegistry((registry) => {
    const entry: ResponseCacheEntry = baseEntry({
      sha: "sha-txn",
      model: "model-a",
      workload: "wl-a",
      workloadEpoch: "e1",
      protocolVariant: "openai",
    });

    const lookup = lookupOf(entry);

    expect(() =>
      registry.transaction(() => {
        registry.insert(entry);
        throw new Error("boom");
      }),
    ).toThrow(/boom/);
    expect(registry.findBySha(lookup)).toBeNull();

    const result = registry.transaction((): number => 42);
    expect(result).toBe(42);
  });
});
