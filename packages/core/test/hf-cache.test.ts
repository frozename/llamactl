import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";

import {
  cacheTtlSeconds,
  discoveryCacheFile,
  fetchDiscoveryFeed,
  fetchModelInfo,
  fetchRepoTree,
  modelInfoCacheFile,
  repoForRelOrRepo,
  repoTreeCacheFile,
} from "../src/hf.js";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "../src/safe-fs.js";

type FetchStub = (url: string) => Promise<Response>;

let resolved: ResolvedEnv;
let dir: string;
let realFetch: typeof globalThis.fetch;
let stderrChunks: string[];
let restoreStderr: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hf-cache-"));
  resolved = {
    LOCAL_AI_RUNTIME_DIR: dir,
    LOCAL_AI_DISCOVERY_AUTHOR: "unsloth",
    LOCAL_AI_DISCOVERY_LIMIT: "24",
    LOCAL_AI_DISCOVERY_SEARCH: "GGUF",
  } as unknown as ResolvedEnv;
  realFetch = globalThis.fetch;
  stderrChunks = [];
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  restoreStderr = (): void => {
    stderrSpy.mockRestore();
  };
});

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    value: realFetch,
    writable: true,
    configurable: true,
  });
  restoreStderr();
  rmSync(dir, { recursive: true, force: true });
});

function writeCache(file: string, body: string, mtimeSec: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  const mtime = new Date(mtimeSec * 1000);
  utimesSync(file, mtime, mtime);
}

function readCache(file: string): string {
  return readFileSync(file, "utf8");
}

function setFetchStub(fn: FetchStub): void {
  Object.defineProperty(globalThis, "fetch", { value: fn, writable: true, configurable: true });
}

describe("cacheTtlSeconds", () => {
  test("unset returns 43200", () => {
    expect(cacheTtlSeconds({})).toBe(43200);
  });
  test("empty string returns 43200", () => {
    expect(cacheTtlSeconds({ LOCAL_AI_HF_CACHE_TTL_SECONDS: "" })).toBe(43200);
  });
  test('"60" returns 60', () => {
    expect(cacheTtlSeconds({ LOCAL_AI_HF_CACHE_TTL_SECONDS: "60" })).toBe(60);
  });
  test('"60s" returns 60 (parseInt strips prefix)', () => {
    expect(cacheTtlSeconds({ LOCAL_AI_HF_CACHE_TTL_SECONDS: "60s" })).toBe(60);
  });
  test('"0" returns 43200', () => {
    expect(cacheTtlSeconds({ LOCAL_AI_HF_CACHE_TTL_SECONDS: "0" })).toBe(43200);
  });
  test('"-5" returns 43200', () => {
    expect(cacheTtlSeconds({ LOCAL_AI_HF_CACHE_TTL_SECONDS: "-5" })).toBe(43200);
  });
  test('"abc" returns 43200', () => {
    expect(cacheTtlSeconds({ LOCAL_AI_HF_CACHE_TTL_SECONDS: "abc" })).toBe(43200);
  });
});

describe("HF disabled", () => {
  test("fetchModelInfo returns null with no fetch call", async () => {
    const calls: string[] = [];
    setFetchStub((url: string) => {
      calls.push(url);
      return Promise.reject(new Error("no network"));
    });
    const result = await fetchModelInfo("org/a", resolved, {
      LOCAL_AI_RECOMMENDATIONS_SOURCE: "off",
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
    const cacheFile = modelInfoCacheFile(resolved.LOCAL_AI_RUNTIME_DIR, "org/a");
    expect(() => readFileSync(cacheFile, "utf8")).toThrow();
  });

  test("fetchRepoTree returns null with no fetch call", async () => {
    const calls: string[] = [];
    setFetchStub((url: string) => {
      calls.push(url);
      return Promise.reject(new Error("no network"));
    });
    const result = await fetchRepoTree("org/a", resolved, {
      LOCAL_AI_RECOMMENDATIONS_SOURCE: "off",
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("fetchDiscoveryFeed returns null with no fetch call", async () => {
    const calls: string[] = [];
    setFetchStub((url: string) => {
      calls.push(url);
      return Promise.reject(new Error("no network"));
    });
    const result = await fetchDiscoveryFeed({}, resolved, {
      LOCAL_AI_RECOMMENDATIONS_SOURCE: "off",
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("fresh cache", () => {
  test("fresh cache wins — parsed object returned, no fetch", async () => {
    const cacheFile = modelInfoCacheFile(resolved.LOCAL_AI_RUNTIME_DIR, "org/a");
    writeCache(
      cacheFile,
      JSON.stringify({ id: "org/a", downloads: 7 }),
      Math.floor(Date.now() / 1000),
    );
    const calls: string[] = [];
    setFetchStub((url: string) => {
      calls.push(url);
      return Promise.reject(new Error("should not be called"));
    });
    const result = await fetchModelInfo("org/a", resolved, {});
    expect(result).toEqual({ id: "org/a", downloads: 7 });
    expect(calls).toHaveLength(0);
  });
});

describe("fresh but empty cache", () => {
  test("whitespace-only cache falls through to network", async () => {
    const cacheFile = modelInfoCacheFile(resolved.LOCAL_AI_RUNTIME_DIR, "org/a");
    writeCache(cacheFile, "   \n  ", Math.floor(Date.now() / 1000));
    setFetchStub(() =>
      Promise.resolve(new Response(JSON.stringify({ id: "org/a", likes: 3 }), { status: 200 })),
    );
    const result = await fetchModelInfo("org/a", resolved, {});
    expect(result).toEqual({ id: "org/a", likes: 3 });
    expect(readCache(cacheFile)).toBe(JSON.stringify({ id: "org/a", likes: 3 }));
  });
});

describe("stale cache plus 200", () => {
  test("stale cache is replaced by new body", async () => {
    const cacheFile = modelInfoCacheFile(resolved.LOCAL_AI_RUNTIME_DIR, "org/a");
    writeCache(cacheFile, JSON.stringify({ id: "org/a", downloads: 1 }), 0);
    setFetchStub(() =>
      Promise.resolve(new Response(JSON.stringify({ id: "org/a", likes: 99 }), { status: 200 })),
    );
    const result = await fetchModelInfo("org/a", resolved, {});
    expect(result).toEqual({ id: "org/a", likes: 99 });
    expect(readCache(cacheFile)).toBe(JSON.stringify({ id: "org/a", likes: 99 }));
  });
});

describe("stale cache plus fetch throws", () => {
  test("stale cache content is returned, stderr includes 'HF fetch failed for'", async () => {
    const cacheFile = modelInfoCacheFile(resolved.LOCAL_AI_RUNTIME_DIR, "org/a");
    writeCache(cacheFile, JSON.stringify({ id: "org/a", downloads: 5 }), 0);
    setFetchStub(() => Promise.reject(new Error("ECONNRESET")));
    const result = await fetchModelInfo("org/a", resolved, {});
    expect(result).toEqual({ id: "org/a", downloads: 5 });
    expect(stderrChunks.join("")).toContain("HF fetch failed for");
  });
});

describe("stale cache plus non-2xx", () => {
  test("stale content returned, cache unchanged, stderr includes status", async () => {
    const cacheFile = modelInfoCacheFile(resolved.LOCAL_AI_RUNTIME_DIR, "org/a");
    const original = JSON.stringify({ id: "org/a", downloads: 10 });
    writeCache(cacheFile, original, 0);
    setFetchStub(() => Promise.resolve(new Response("service unavailable", { status: 503 })));
    const result = await fetchModelInfo("org/a", resolved, {});
    expect(result).toEqual({ id: "org/a", downloads: 10 });
    expect(readCache(cacheFile)).toBe(original);
    expect(stderrChunks.join("")).toContain("HF returned status 503");
  });
});

describe("no cache plus fetch throws", () => {
  test("returns null", async () => {
    setFetchStub(() => Promise.reject(new Error("ENOTFOUND")));
    const result = await fetchModelInfo("org/a", resolved, {});
    expect(result).toBeNull();
  });
});

describe("no cache plus 200 with invalid JSON", () => {
  test("returns null but writes raw body to cache", async () => {
    setFetchStub(() => Promise.resolve(new Response("not json", { status: 200 })));
    const result = await fetchModelInfo("org/a", resolved, {});
    expect(result).toBeNull();
    const cacheFile = modelInfoCacheFile(resolved.LOCAL_AI_RUNTIME_DIR, "org/a");
    expect(readCache(cacheFile)).toBe("not json");
  });
});

describe("URL and cache key routing", () => {
  test('fetchModelInfo("org/a") calls the encoded API URL', async () => {
    const calls: string[] = [];
    setFetchStub((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify({ id: "org/a" }), { status: 200 }));
    });
    await fetchModelInfo("org/a", resolved, {});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://huggingface.co/api/models/org%2Fa");
  });

  test('fetchRepoTree("org/a") calls the tree URL and caches at repoTreeCacheFile', async () => {
    const calls: string[] = [];
    setFetchStub((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
    await fetchRepoTree("org/a", resolved, {});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      "https://huggingface.co/api/models/org%2Fa/tree/main?recursive=1&expand=1",
    );
    const cacheFile = repoTreeCacheFile(resolved.LOCAL_AI_RUNTIME_DIR, "org/a");
    expect(() => readFileSync(cacheFile, "utf8")).not.toThrow();
  });

  test("fetchDiscoveryFeed uses author, limit, search params in URL and caches at discoveryCacheFile", async () => {
    const calls: string[] = [];
    setFetchStub((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
    await fetchDiscoveryFeed({}, resolved, {});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(
      "author=unsloth&search=GGUF&sort=downloads&direction=-1&limit=24&full=true",
    );
    const cacheFile = discoveryCacheFile(resolved.LOCAL_AI_RUNTIME_DIR, "unsloth", 24, "GGUF");
    expect(() => readFileSync(cacheFile, "utf8")).not.toThrow();
  });
});

describe("fetchDiscoveryFeed limit fallback", () => {
  test('LOCAL_AI_DISCOVERY_LIMIT "junk" falls back to 24', async () => {
    const junkResolved: ResolvedEnv = { ...resolved, LOCAL_AI_DISCOVERY_LIMIT: "junk" };
    const calls: string[] = [];
    setFetchStub((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
    await fetchDiscoveryFeed({}, junkResolved, {});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("limit=24");
  });

  test("explicit opts.limit of 5 wins over resolved value", async () => {
    const calls: string[] = [];
    setFetchStub((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
    await fetchDiscoveryFeed({ limit: 5 }, resolved, {});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("limit=5");
  });
});

describe("repoForRelOrRepo", () => {
  test('repoForRelOrRepo("org/name") returns "org/name" unchanged', () => {
    expect(repoForRelOrRepo("org/name")).toBe("org/name");
  });
});
