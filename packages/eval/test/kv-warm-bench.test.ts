import { describe, expect, test } from "bun:test";

import {
  buildDeterministicPrompt,
  buildFrontierPrompt,
  createTokenizeClient,
  formatKvWarmBenchCsvRow,
  type KvWarmBenchRow,
  renderKvWarmBenchMarkdown,
} from "../src/matrix/workloads/kv-warm-bench.js";

describe("buildDeterministicPrompt", () => {
  test("is byte-identical for the same args", () => {
    const a = buildDeterministicPrompt({ approxTokens: 2048, seed: 7 });
    const b = buildDeterministicPrompt({ approxTokens: 2048, seed: 7 });
    expect(a).toBe(b);
  });
});

describe("buildFrontierPrompt", () => {
  test("matches the exact token frontier when tokenize endpoint is available", async () => {
    const origFetch = globalThis.fetch;
    const tokenizeCalls: number[] = [];
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/v1/tokenize")) {
        const body =
          typeof init?.body === "string" ? (JSON.parse(init.body) as { prompt?: string }) : {};
        const payload = body.prompt ?? "";
        const words = payload.split("\n")[1]?.trim().split(/\s+/).filter(Boolean).length ?? 0;
        tokenizeCalls.push(words);
        return Promise.resolve(
          new Response(JSON.stringify({ token_ids: [], n_tokens: words * 6 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    }) as unknown as typeof fetch;

    try {
      const tokenizeClient = await createTokenizeClient({
        proxyBaseUrl: "http://127.0.0.1:8089",
        model: "granite-test",
      });
      expect(tokenizeClient).not.toBeNull();
      if (!tokenizeClient) return;

      const prompt = await buildFrontierPrompt({
        frontierTokens: 120,
        seed: 11,
        tokenize: tokenizeClient,
      });
      const finalWords = prompt.split("\n")[1]?.trim().split(/\s+/).filter(Boolean).length ?? 0;
      expect(finalWords * 6).toBe(120);
      expect(tokenizeCalls.length).toBeLessThanOrEqual(4);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("createTokenizeClient", () => {
  test("warns once and falls back when tokenize endpoint is unavailable", async () => {
    const origFetch = globalThis.fetch;
    const warnings: string[] = [];
    globalThis.fetch = (() =>
      Promise.resolve(new Response("not found", { status: 404 }))) as unknown as typeof fetch;

    try {
      const tokenizeClient = await createTokenizeClient({
        proxyBaseUrl: "http://127.0.0.1:8089",
        model: "granite-test",
        onWarn: (msg) => warnings.push(msg),
      });
      expect(tokenizeClient).toBeNull();
      expect(warnings).toEqual([
        "kv-warm-bench: /v1/tokenize unavailable; interpreting --frontiers as approximate word counts",
      ]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("formatKvWarmBenchCsvRow", () => {
  test("renders all columns in documented order", () => {
    const row: KvWarmBenchRow = {
      promptSize: 8192,
      tColdMs: 1200.23,
      tColdFirstByteMs: 220.11,
      tWarmMinMs: 410.2,
      tWarmP50Ms: 420.3,
      tWarmP95Ms: 455.4,
      ratioColdOverWarm: 2.86,
      kvWarmHitTotal: 9,
      kvColdMissTotal: 3,
      kvFalseHitTotal: 0,
    };

    expect(formatKvWarmBenchCsvRow(row)).toBe(
      "8192,1200.23,220.11,410.20,420.30,455.40,2.86,9,3,0",
    );
  });
});

describe("renderKvWarmBenchMarkdown", () => {
  test("includes table headers, raw CSV block, and decision checklist", () => {
    const rows: KvWarmBenchRow[] = [
      {
        promptSize: 2048,
        tColdMs: 800,
        tColdFirstByteMs: 150,
        tWarmMinMs: 300,
        tWarmP50Ms: 320,
        tWarmP95Ms: 350,
        ratioColdOverWarm: 2.5,
        kvWarmHitTotal: 3,
        kvColdMissTotal: 1,
        kvFalseHitTotal: 0,
      },
    ];

    const md = renderKvWarmBenchMarkdown({
      generatedAtIso: "2026-05-24T12:00:00.000Z",
      model: "qwen-test",
      proxyBaseUrl: "http://127.0.0.1:8089",
      machine: "host-1",
      os: "darwin 26.0.0",
      frontiers: [2048],
      warmRuns: 3,
      rows,
    });

    expect(md).toContain(
      "| promptSize | t_cold_ms | t_cold_first_byte_ms | t_warm_min_ms | t_warm_p50_ms | t_warm_p95_ms | ratio_cold_over_warm | kv_warm_hit_total | kv_cold_miss_total | kv_false_hit_total |",
    );
    expect(md).toContain("```csv");
    expect(md).toContain(
      "promptSize,t_cold_ms,t_cold_first_byte_ms,t_warm_min_ms,t_warm_p50_ms,t_warm_p95_ms,ratio_cold_over_warm,kv_warm_hit_total,kv_cold_miss_total,kv_false_hit_total",
    );
    expect(md).toContain("## Decision (to fill in after running)");
    expect(md).toContain(
      "- [ ] 16k frontier cold/warm ratio ≥ 2.0 → Slice 2 ships, Phase 8 NOT needed",
    );
    expect(md).toContain("- [ ] Write cost p95 ≤ 100 ms → no cadence work needed");
    expect(md).toContain(
      "- [ ] False-hit rate (`kv_false_hit_total / kv_warm_hit_total`) ≤ 1% → no equivalence work needed",
    );
  });
});
