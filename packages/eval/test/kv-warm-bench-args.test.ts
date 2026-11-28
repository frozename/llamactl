import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KV_WARM_BENCH_DEFAULT_PROXY_BASE_URL,
  type KvWarmBenchArgs,
  type KvWarmBenchCounterSnapshot,
  parseKvWarmBenchRunArgs,
  runKvWarmBench,
} from "../src/matrix/workloads/kv-warm-bench.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

interface CapturedCall {
  body: string | undefined;
  url: string;
}

interface ChatCompletionBody {
  max_tokens: number;
  messages: { content: string; role: string }[];
  temperature: number;
}

interface StubbedRun {
  calls: CapturedCall[];
  error: unknown;
  result: Awaited<ReturnType<typeof runKvWarmBench>> | undefined;
}

const DEFAULT_FRONTIERS = [2048, 4096, 8192, 16384, 32768];

const MODEL_REQUIRED = "kv-warm-bench: model is required";
const WARM_RUNS_INVALID = "kv-warm-bench: warmRuns must be an integer between 1 and 100";
const FRONTIERS_INVALID = "kv-warm-bench: frontiers must be a non-empty list of integers >= 64";

const flatCounters = (): KvWarmBenchCounterSnapshot => ({
  kv_cold_miss_total: 0,
  kv_false_hit_total: 0,
  kv_warm_hit_total: 0,
});

// Nothing here reaches the network: /v1/tokenize 404s (so frontier sizes are interpreted
// as word counts) and /v1/chat/completions answers with an empty completion.
function stubFetch(): { calls: CapturedCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: CapturedCall[] = [];
  globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/v1/tokenize")) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: (): void => {
      globalThis.fetch = original;
    },
  };
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// outPath stays inside a tmpdir so a bad default can never write into the checkout.
async function runAgainstStub(args: KvWarmBenchArgs): Promise<StubbedRun> {
  return await withTempDir("kv-warm-bench-args-", async (dir) => {
    const stub = stubFetch();
    try {
      const result = await runKvWarmBench(
        { dataRoot: dir, outPath: join(dir, "bench.md"), ...args },
        { counterReader: flatCounters },
      );
      return { calls: stub.calls, error: undefined, result };
    } catch (error) {
      return { calls: stub.calls, error, result: undefined };
    } finally {
      stub.restore();
    }
  });
}

function chatBodies(calls: CapturedCall[]): ChatCompletionBody[] {
  return calls
    .filter((call) => call.url.endsWith("/v1/chat/completions"))
    .map((call) => JSON.parse(call.body ?? "{}") as ChatCompletionBody);
}

function refusalMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  throw new Error("expected runKvWarmBench to reject with an Error");
}

function promptOf(body: ChatCompletionBody): string {
  return body.messages[0]?.content ?? "";
}

function wordCount(prompt: string): number {
  return (prompt.split("\n")[1] ?? "").split(/\s+/).filter(Boolean).length;
}

function seedHeader(prompt: string): string {
  return prompt.split("\n")[0] ?? "";
}

describe("parseKvWarmBenchRunArgs", () => {
  test("refuses a run without --model", () => {
    expect(() => parseKvWarmBenchRunArgs([])).toThrow("usage: run kv-warm-bench --model <name>");
    expect(() =>
      parseKvWarmBenchRunArgs(["run", "kv-warm-bench", "--proxy", "http://127.0.0.1:8089"]),
    ).toThrow("usage: run kv-warm-bench --model <name>");
  });

  test("refuses --model as a trailing flag with no value", () => {
    expect(() => parseKvWarmBenchRunArgs(["run", "kv-warm-bench", "--model"])).toThrow(
      "usage: run kv-warm-bench --model <name>",
    );
  });

  test("maps every documented flag", () => {
    expect(
      parseKvWarmBenchRunArgs([
        "run",
        "kv-warm-bench",
        "--model",
        "granite-8b",
        "--proxy",
        "http://10.0.0.5:8080/",
        "--temperature",
        "0.25",
        "--max-tokens",
        "300",
        "--frontiers",
        "2048, 4096, 8192",
        "--warm-runs",
        "5",
        "--data-root",
        "/tmp/kv-data",
        "--out",
        "/tmp/kv-out.md",
        "--seed",
        "4321",
      ]),
    ).toEqual({
      model: "granite-8b",
      proxyBaseUrl: "http://10.0.0.5:8080/",
      temperature: 0.25,
      maxTokens: 300,
      frontiers: [2048, 4096, 8192],
      warmRuns: 5,
      dataRoot: "/tmp/kv-data",
      outPath: "/tmp/kv-out.md",
      seed: 4321,
    });
  });

  test("omits optional flags that were not passed", () => {
    const parsed = parseKvWarmBenchRunArgs(["run", "kv-warm-bench", "--model", "granite-8b"]);
    expect(parsed).toStrictEqual({ model: "granite-8b" });
    expect(Object.keys(parsed).sort()).toEqual(["model"]);
  });

  test("treats an empty flag value as absent", () => {
    expect(
      parseKvWarmBenchRunArgs([
        "--model",
        "granite-8b",
        "--proxy",
        "",
        "--frontiers",
        "",
        "--warm-runs",
        "",
      ]),
    ).toStrictEqual({ model: "granite-8b" });
  });

  test("keeps the first value when a flag repeats", () => {
    expect(
      parseKvWarmBenchRunArgs([
        "--model",
        "first-model",
        "--model",
        "second-model",
        "--frontiers",
        "2048",
        "--frontiers",
        "4096",
      ]),
    ).toStrictEqual({ frontiers: [2048], model: "first-model" });
  });

  test("parses temperature as a float and the integer flags as integers", () => {
    const parsed = parseKvWarmBenchRunArgs([
      "--model",
      "granite-8b",
      "--temperature",
      "0.25",
      "--max-tokens",
      "300.7",
      "--warm-runs",
      "5",
      "--seed",
      "4321",
    ]);
    expect(parsed.temperature).toBe(0.25);
    expect(parsed.maxTokens).toBe(300);
    expect(parsed.warmRuns).toBe(5);
    expect(parsed.seed).toBe(4321);
  });

  test("drops non-numeric and non-positive entries from --frontiers", () => {
    const parsed = parseKvWarmBenchRunArgs([
      "--model",
      "granite-8b",
      "--frontiers",
      "2048,0,-5,abc, 4096 ,12abc,",
    ]);
    expect(parsed.frontiers).toEqual([2048, 4096, 12]);
  });

  test("does not validate ranges: out-of-band numbers reach runKvWarmBench", () => {
    expect(
      parseKvWarmBenchRunArgs(["--model", "granite-8b", "--warm-runs", "0", "--frontiers", "7"]),
    ).toStrictEqual({ frontiers: [7], model: "granite-8b", warmRuns: 0 });
  });
});

describe("runKvWarmBench argument refusals", () => {
  test("refuses a blank model before any request", async () => {
    for (const model of ["", "   ", "\t"]) {
      const run = await runAgainstStub({ model, frontiers: [64] });
      expect(refusalMessage(run.error)).toBe(MODEL_REQUIRED);
      expect(run.result).toBeUndefined();
      expect(run.calls).toEqual([]);
    }
  });

  test("refuses warmRuns below 1, above 100 and non-integers", async () => {
    for (const warmRuns of [0, -3, 101, 2.5, Number.NaN]) {
      const run = await runAgainstStub({ model: "granite-test", frontiers: [64], warmRuns });
      expect(refusalMessage(run.error)).toBe(WARM_RUNS_INVALID);
      expect(run.result).toBeUndefined();
      expect(run.calls).toEqual([]);
    }
  });

  test("refuses an empty frontier list", async () => {
    const run = await runAgainstStub({ model: "granite-test", frontiers: [] });
    expect(refusalMessage(run.error)).toBe(FRONTIERS_INVALID);
    expect(run.calls).toEqual([]);
  });

  test("refuses frontiers below 64 after flooring", async () => {
    for (const frontiers of [[63], [64, 63], [63.9], [Number.NaN], [Number.POSITIVE_INFINITY]]) {
      const run = await runAgainstStub({ model: "granite-test", frontiers });
      expect(refusalMessage(run.error)).toBe(FRONTIERS_INVALID);
      expect(run.calls).toEqual([]);
    }
  });

  test("refuses an out-of-band value parsed from argv", async () => {
    const parsed = parseKvWarmBenchRunArgs([
      "--model",
      "granite-test",
      "--frontiers",
      "64",
      "--warm-runs",
      "0",
    ]);
    const run = await runAgainstStub(parsed);
    expect(refusalMessage(run.error)).toBe(WARM_RUNS_INVALID);
    expect(run.calls).toEqual([]);
  });

  test("accepts the documented boundaries warmRuns 1, warmRuns 100 and frontier 64", async () => {
    const min = await runAgainstStub({ model: "granite-test", frontiers: [64], warmRuns: 1 });
    expect(min.error).toBeUndefined();
    expect(chatBodies(min.calls).length).toBe(2);

    const max = await runAgainstStub({ model: "granite-test", frontiers: [64], warmRuns: 100 });
    expect(max.error).toBeUndefined();
    expect(chatBodies(max.calls).length).toBe(101);
    expect(max.result?.markdown).toContain("- Warm runs: 100");
  });
});

describe("runKvWarmBench argument normalisation", () => {
  test("applies the documented defaults when only a model is given", async () => {
    const run = await runAgainstStub({ model: "granite-test" });
    expect(run.error).toBeUndefined();
    const result = run.result;
    if (!result) {
      throw new Error("expected runKvWarmBench to resolve");
    }

    const tokenizeUrl = `${KV_WARM_BENCH_DEFAULT_PROXY_BASE_URL}/v1/tokenize`;
    const chatUrl = `${KV_WARM_BENCH_DEFAULT_PROXY_BASE_URL}/v1/chat/completions`;
    expect(run.calls.map((call) => call.url)).toEqual([
      tokenizeUrl,
      ...Array.from({ length: 20 }, () => chatUrl),
    ]);

    const bodies = chatBodies(run.calls);
    for (const body of bodies) {
      expect(body.temperature).toBe(0);
      expect(body.max_tokens).toBe(256);
      expect(seedHeader(promptOf(body))).toBe("KV-WARM-BENCH-SEED=11");
    }

    expect(bodies.map((body) => wordCount(promptOf(body)))).toEqual(
      DEFAULT_FRONTIERS.flatMap((frontier) => [frontier, frontier, frontier, frontier]),
    );
    expect(result.rows.map((row) => row.promptSize)).toEqual(DEFAULT_FRONTIERS);
    expect(result.markdown).toContain("- Frontiers: 2048, 4096, 8192, 16384, 32768");
    expect(result.markdown).toContain("- Warm runs: 3");
    expect(result.markdown).toContain("- Model: granite-test");
  });

  test("strips trailing slashes from the proxy base URL", async () => {
    const run = await runAgainstStub({
      model: "granite-test",
      proxyBaseUrl: "http://127.0.0.1:8099///",
      frontiers: [64],
      warmRuns: 1,
    });
    expect(run.error).toBeUndefined();
    expect(run.calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8099/v1/tokenize",
      "http://127.0.0.1:8099/v1/chat/completions",
      "http://127.0.0.1:8099/v1/chat/completions",
    ]);
    expect(run.result?.markdown).toContain("- Proxy base URL: http://127.0.0.1:8099");
  });

  test("keeps a proxy base URL without trailing slashes untouched", async () => {
    const run = await runAgainstStub({
      model: "granite-test",
      proxyBaseUrl: "http://127.0.0.1:8099",
      frontiers: [64],
      warmRuns: 1,
    });
    expect(run.error).toBeUndefined();
    expect(run.calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8099/v1/tokenize",
      "http://127.0.0.1:8099/v1/chat/completions",
      "http://127.0.0.1:8099/v1/chat/completions",
    ]);
  });

  test("honours an explicit seed in the generated prompt", async () => {
    const run = await runAgainstStub({
      model: "granite-test",
      frontiers: [64],
      warmRuns: 1,
      seed: 4321,
    });
    expect(run.error).toBeUndefined();
    const bodies = chatBodies(run.calls);
    expect(bodies.length).toBe(2);
    for (const body of bodies) {
      expect(seedHeader(promptOf(body))).toBe("KV-WARM-BENCH-SEED=4321");
      expect(wordCount(promptOf(body))).toBe(64);
    }
  });

  test("floors fractional frontiers instead of refusing them", async () => {
    const run = await runAgainstStub({
      model: "granite-test",
      frontiers: [64.7, 128.2],
      warmRuns: 1,
    });
    expect(run.error).toBeUndefined();
    expect(run.result?.rows.map((row) => row.promptSize)).toEqual([64, 128]);
    expect(run.result?.markdown).toContain("- Frontiers: 64, 128");
    expect(chatBodies(run.calls).map((body) => wordCount(promptOf(body)))).toEqual([
      64, 64, 128, 128,
    ]);
  });

  test("carries parsed argv through normalisation", async () => {
    await withTempDir("kv-warm-bench-argv-", async (dir) => {
      const outPath = join(dir, "bench.md");
      const parsed = parseKvWarmBenchRunArgs([
        "--model",
        "granite-8b",
        "--proxy",
        "http://127.0.0.1:8099/",
        "--frontiers",
        "64,128",
        "--warm-runs",
        "2",
        "--temperature",
        "0.25",
        "--max-tokens",
        "32",
        "--seed",
        "7",
        "--data-root",
        dir,
        "--out",
        outPath,
      ]);
      const run = await runAgainstStub(parsed);
      expect(run.error).toBeUndefined();
      expect(run.result?.outputPath).toBe(outPath);
      expect(run.calls.map((call) => call.url)).toEqual([
        "http://127.0.0.1:8099/v1/tokenize",
        "http://127.0.0.1:8099/v1/chat/completions",
        "http://127.0.0.1:8099/v1/chat/completions",
        "http://127.0.0.1:8099/v1/chat/completions",
        "http://127.0.0.1:8099/v1/chat/completions",
        "http://127.0.0.1:8099/v1/chat/completions",
        "http://127.0.0.1:8099/v1/chat/completions",
      ]);
      const bodies = chatBodies(run.calls);
      expect(bodies.map((body) => [body.temperature, body.max_tokens])).toEqual([
        [0.25, 32],
        [0.25, 32],
        [0.25, 32],
        [0.25, 32],
        [0.25, 32],
        [0.25, 32],
      ]);
      expect(bodies.map((body) => wordCount(promptOf(body)))).toEqual([64, 64, 64, 128, 128, 128]);
      expect(bodies.map((body) => seedHeader(promptOf(body)))).toEqual([
        "KV-WARM-BENCH-SEED=7",
        "KV-WARM-BENCH-SEED=7",
        "KV-WARM-BENCH-SEED=7",
        "KV-WARM-BENCH-SEED=7",
        "KV-WARM-BENCH-SEED=7",
        "KV-WARM-BENCH-SEED=7",
      ]);
    });
  });
});
