// packages/core/test/hf-summary.test.ts
// Issue #335 — pins the catalog-facing callers of HF model info:
// repoForRel, the rel branch of repoForRelOrRepo, summaryForRel and
// recommendationsWithHf. The fetch stub is the whole network; nothing
// below reaches huggingface.co.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ResolvedEnv } from "../src/types.js";

import { resolveEnv } from "../src/env.js";
import { hfApiModelUrl, repoForRel, repoForRelOrRepo, summaryForRel } from "../src/hf.js";
import { recommendationsWithHf } from "../src/recommendations.js";
import { envForTemp, makeTempRuntime } from "./helpers.js";

const Q8_REL = "gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q8_0.gguf";
const Q8_REPO = "unsloth/gemma-4-E4B-it-GGUF";
const Q4_REL = "gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf";
const Q4_REPO = "unsloth/gemma-4-31B-it-GGUF";
const API_PREFIX = "https://huggingface.co/api/models/";

/** Repo behind each shipped `macbook-pro-48g` ladder slot. */
const LADDER_48G: Record<string, string> = {
  best: Q4_REPO,
  vision: "unsloth/gemma-4-26B-A4B-it-GGUF",
  balanced: "unsloth/gemma-4-26B-A4B-it-GGUF",
  fast: Q8_REPO,
  qwen: "unsloth/Qwen3.6-35B-A3B-GGUF",
  qwen27: "unsloth/Qwen3.5-27B-GGUF",
};

type TempRuntime = ReturnType<typeof makeTempRuntime>;

let temp: TempRuntime;
let baseEnv: NodeJS.ProcessEnv;
let hfEnv: NodeJS.ProcessEnv;
let resolved: ResolvedEnv;
let calls: string[];
let origFetch: typeof globalThis.fetch;

beforeEach(() => {
  temp = makeTempRuntime();
  baseEnv = envForTemp(temp);
  hfEnv = { ...baseEnv, LOCAL_AI_RECOMMENDATIONS_SOURCE: "hf" };
  resolved = resolveEnv(baseEnv);
  calls = [];
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  temp.cleanup();
});

function stubFetch(body: (url: string) => unknown): void {
  globalThis.fetch = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    return Promise.resolve(new Response(JSON.stringify(body(url)), { status: 200 }));
  }) as unknown as typeof globalThis.fetch;
}

/** Repo id an HF model-info URL points at (the API encodes the slash). */
function repoFromUrl(url: string): string {
  return decodeURIComponent(url.slice(API_PREFIX.length));
}

function fileName(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

describe("repoForRel", () => {
  test("case 1: resolves a builtin catalog rel to its repo id", () => {
    expect(repoForRel(Q8_REL)).toBe(Q8_REPO);
    expect(repoForRel(Q4_REL)).toBe(Q4_REPO);
    expect(repoForRel("Qwen3.5-27B-GGUF/Qwen3.5-27B-UD-Q5_K_XL.gguf")).toBe(
      "unsloth/Qwen3.5-27B-GGUF",
    );
  });
});

describe("repoForRelOrRepo", () => {
  test("case 2: a catalog rel ending in .gguf resolves through the catalog, not echoed back", () => {
    expect(repoForRelOrRepo(Q8_REL)).toBe(Q8_REPO);
    expect(repoForRelOrRepo(Q4_REL)).toBe(Q4_REPO);
    expect(repoForRelOrRepo("Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf")).toBe(
      "unsloth/Qwen3.6-35B-A3B-GGUF",
    );
  });

  test("case 3: a repo id passes through without a catalog lookup", () => {
    expect(repoForRelOrRepo("Some/Repo-V2")).toBe("Some/Repo-V2");
    expect(repoForRelOrRepo("unsloth/Not-In-The-Catalog-GGUF")).toBe(
      "unsloth/Not-In-The-Catalog-GGUF",
    );
  });

  test("case 4: null for input that is neither a repo id nor a catalog rel", () => {
    expect(repoForRelOrRepo("gemma-4-E4B-it-Q8_0.gguf")).toBeNull();
    expect(repoForRelOrRepo("some-dir/gemma-4-E4B-it-Q8_0.gguf")).toBeNull();
    expect(repoForRelOrRepo("")).toBeNull();
  });
});

describe("summaryForRel", () => {
  test("case 5: keeps a zero download count and prefers pipeline_tag over pipelineTag", async () => {
    stubFetch(() => ({
      id: Q8_REPO,
      downloads: 0,
      likes: 0,
      lastModified: "2026-10-01T09:08:07.000Z",
      pipeline_tag: "text-generation",
      pipelineTag: "image-text-to-text",
    }));

    const line = await summaryForRel(Q8_REL, resolved, hfEnv);

    expect(line).toBe(
      `repo=${Q8_REPO} downloads=0 likes=0 updated=2026-10-01T09:08:07.000Z ` +
        `task=text-generation file=${fileName(Q8_REL)}`,
    );
    expect(calls).toEqual([hfApiModelUrl(Q8_REPO)]);
  });

  test("case 6: renders n/a for absent metrics and null when there is nothing to summarise", async () => {
    stubFetch(() => ({ id: Q4_REPO, pipelineTag: "any-to-any" }));

    expect(await summaryForRel(Q4_REL, resolved, hfEnv)).toBe(
      `repo=${Q4_REPO} downloads=n/a likes=n/a updated=n/a ` +
        `task=any-to-any file=${fileName(Q4_REL)}`,
    );

    stubFetch(() => ({ id: "anything", downloads: 1 }));
    expect(await summaryForRel("no-such-dir/no-such-file.gguf", resolved, hfEnv)).toBeNull();
    expect(await summaryForRel(Q8_REL, resolved, baseEnv)).toBeNull();
  });
});

describe("recommendationsWithHf", () => {
  test("case 7: writes an explicit null hf on every row when HF is off", async () => {
    stubFetch(() => ({ id: "unused", downloads: 5 }));

    const rows = await recommendationsWithHf("macbook-pro-48g", baseEnv);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.hasOwn(row, "hf")).toBe(true);
      expect(row.hf).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  test("case 8: fills hf on every row from the slot's repo and metrics", async () => {
    stubFetch((url) => ({
      id: repoFromUrl(url),
      downloads: 1000,
      likes: 7,
      lastModified: "2026-10-02T00:00:00.000Z",
      pipeline_tag: "text-generation",
    }));

    const rows = await recommendationsWithHf("macbook-pro-48g", hfEnv);

    expect(rows.map((row) => row.target)).toEqual([
      "best",
      "vision",
      "balanced",
      "fast",
      "qwen",
      "qwen27",
    ]);
    for (const row of rows) {
      expect(row.hf).toBe(
        `repo=${LADDER_48G[row.target] ?? ""} downloads=1000 likes=7 ` +
          `updated=2026-10-02T00:00:00.000Z task=text-generation file=${fileName(row.rel)}`,
      );
    }
  });

  test("case 9: asks HF for every distinct repo on the ladder and nothing else", async () => {
    stubFetch((url) => ({ id: repoFromUrl(url) }));

    const rows = await recommendationsWithHf("macbook-pro-48g", hfEnv);

    expect(rows).toHaveLength(6);
    const requested = [...new Set(calls)].sort();
    const expected = [...new Set(Object.values(LADDER_48G).map(hfApiModelUrl))].sort();
    expect(requested).toEqual(expected);
  });
});
