import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDeterministicPrompt,
  buildFrontierPrompt,
  createTokenizeClient,
  formatKvWarmBenchCsvRow,
  type KvWarmBenchCounterSnapshot,
  type KvWarmBenchRow,
  readKvCountersFromRegistry,
  renderKvWarmBenchMarkdown,
  runKvWarmBench,
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

describe("readKvCountersFromRegistry", () => {
  test("cold-miss count includes entries whose reason was updated from 'cold'", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kv-cold-miss-test-"));
    try {
      mkdirSync(join(tmp, "kvstore"), { recursive: true });
      const db = new Database(join(tmp, "kvstore", "registry.db"));
      db.run(
        "CREATE TABLE kv_entries (sha TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT 'cold')",
      );
      // Entry 1: still reason='cold' (never re-saved)
      db.run("INSERT INTO kv_entries (sha, hits, reason) VALUES ('sha1', 0, 'cold')");
      // Entry 2: originally a cold miss, but reason was later updated to 'evict'
      db.run("INSERT INTO kv_entries (sha, hits, reason) VALUES ('sha2', 3, 'evict')");
      db.close();

      const counters = readKvCountersFromRegistry(tmp);
      // Both entries represent cold-miss events; only counting reason='cold' misses one
      expect(counters.kv_cold_miss_total).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runKvWarmBench counter deltas", () => {
  test("each frontier row shows its own counter delta, not the cumulative total", async () => {
    const origFetch = globalThis.fetch;
    const outDir = mkdtempSync(join(tmpdir(), "kv-warm-bench-out-"));

    try {
      globalThis.fetch = ((input: Request | string | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
        if (url.endsWith("/v1/tokenize")) {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        return Promise.resolve(
          new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
        );
      }) as unknown as typeof fetch;

      // Four snapshots: before-f1, after-f1, before-f2, after-f2
      const snapshots: KvWarmBenchCounterSnapshot[] = [
        { kv_warm_hit_total: 5, kv_cold_miss_total: 1, kv_false_hit_total: 0 },
        { kv_warm_hit_total: 8, kv_cold_miss_total: 2, kv_false_hit_total: 0 },
        { kv_warm_hit_total: 8, kv_cold_miss_total: 2, kv_false_hit_total: 0 },
        { kv_warm_hit_total: 10, kv_cold_miss_total: 3, kv_false_hit_total: 0 },
      ];
      let callIndex = 0;
      const counterReader = (_dataRoot: string): KvWarmBenchCounterSnapshot =>
        // snapshots always has 4 entries; callIndex stays in range for this test
        snapshots[callIndex++]!;

      const result = await runKvWarmBench(
        {
          model: "test-model",
          frontiers: [64, 128],
          warmRuns: 1,
          dataRoot: "/tmp/noop",
          outPath: join(outDir, "out.md"),
        },
        { counterReader },
      );

      const row0 = result.rows[0];
      const row1 = result.rows[1];
      if (!row0 || !row1) throw new Error("expected 2 rows");

      // Frontier 1 delta: snapshots[1] - snapshots[0] = {3, 1, 0}
      expect(row0.kvWarmHitTotal).toBe(3);
      expect(row0.kvColdMissTotal).toBe(1);

      // Frontier 2 delta: snapshots[3] - snapshots[2] = {2, 1, 0}
      expect(row1.kvWarmHitTotal).toBe(2);
      expect(row1.kvColdMissTotal).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
