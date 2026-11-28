import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { EvalProvenance, MetricValue, PerfRunRow } from "../../src/matrix/types.js";
import type { PerfEngineClient } from "../../src/perf/client.js";

import { listPerfRuns } from "../../src/matrix/store.js";
import { normaliseAcceptance } from "../../src/perf/normalise.js";
import { runPerfSuite } from "../../src/perf/runner.js";

const RUN_ID = "run-acc-bound";

const PROVENANCE: EvalProvenance = {
  engine: "llamacpp",
  engine_version: "b1-mtp",
  engine_commit: "0123abcd",
  binary_sha256: "ab".repeat(32),
  gguf_sha256: "cd".repeat(32),
  hf_revision: "main@deadbeef",
  quant: "Q4_K_M",
  ctx: 40960,
  flags: ["-np", "2", "-c", "40960"],
  host: "test-host",
};

function metricOf(rows: PerfRunRow[], name: string): MetricValue {
  const row = rows.find((r) => r.metric_name === name);
  if (row === undefined) throw new Error(`missing perf metric ${name}`);
  return row.metric;
}

describe("#521 spec_acceptance cannot exceed 1", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("B1: llamacpp timings with accepted draft tokens above drafted are unavailable", () => {
    expect(normaliseAcceptance({ timings: { draft_n: 100, draft_n_accepted: 120 } })).toEqual({
      value: null,
      status: "unavailable",
      reason:
        "engine reported 120 accepted draft tokens of 100 drafted; acceptance cannot exceed 1",
    });
  });

  test("B2: gufo usage with accepted draft tokens above drafted is unavailable", () => {
    expect(normaliseAcceptance({ usage: { draft_tokens: 10, draft_tokens_accepted: 11 } })).toEqual(
      {
        value: null,
        status: "unavailable",
        reason:
          "engine reported 11 accepted draft tokens of 10 drafted; acceptance cannot exceed 1",
      },
    );
  });

  test("B3: kapitsa usage with accepted draft tokens above drafted is unavailable", () => {
    expect(
      normaliseAcceptance({
        usage: { kapitsa: { draft_tokens: 200, draft_tokens_accepted: 201 } },
      }),
    ).toEqual({
      value: null,
      status: "unavailable",
      reason:
        "engine reported 201 accepted draft tokens of 200 drafted; acceptance cannot exceed 1",
    });
  });

  test("B4: runPerfSuite stores the impossible acceptance as unavailable without harming decode", async () => {
    const forbiddenCalls: string[] = [];
    const client: PerfEngineClient = {
      listModels: () => {
        forbiddenCalls.push("listModels");
        throw new Error("listModels must not be called");
      },
      tokenize: () => {
        forbiddenCalls.push("tokenize");
        throw new Error("tokenize must not be called");
      },
      streamCompletion: () => {
        forbiddenCalls.push("streamCompletion");
        throw new Error("streamCompletion must not be called");
      },
      streamChat: () =>
        Promise.resolve({
          ttftMs: 10,
          completionTokens: 16,
          promptTokens: 8,
          final: {
            timings: { predicted_per_second: 50, draft_n: 4, draft_n_accepted: 5 },
          },
        }),
    };

    await runPerfSuite(db, {
      run_id: RUN_ID,
      model_name: "fake",
      provenance: PROVENANCE,
      clock: { now: () => 0 },
      client,
      prefillReason: "prefill skipped in this test",
      slots: null,
      decodeTokens: 16,
      concurrencyPromptWords: 8,
      started_at: "2026-11-27T00:00:00.000Z",
      host_machine: "test-host",
    });

    expect(forbiddenCalls).toEqual([]);
    const rows = listPerfRuns(db, { run_id: RUN_ID });
    const reason =
      "engine reported 5 accepted draft tokens of 4 drafted; acceptance cannot exceed 1";
    expect(metricOf(rows, "spec_acceptance")).toEqual({
      value: null,
      status: "unavailable",
      reason,
    });
    expect(metricOf(rows, "decode_tps")).toEqual({ value: 50, status: "ok" });

    const stored = db
      .query(
        "SELECT metric_value, metric_status, metric_reason FROM perf_runs WHERE run_id = ? AND metric_name = 'spec_acceptance'",
      )
      .get(RUN_ID) as {
      metric_value: number | null;
      metric_status: string;
      metric_reason: string | null;
    } | null;
    expect(stored).toEqual({
      metric_value: null,
      metric_status: "unavailable",
      metric_reason: reason,
    });
  });

  test("G1: acceptance of exactly one remains ok", () => {
    expect(normaliseAcceptance({ timings: { draft_n: 8, draft_n_accepted: 8 } })).toEqual({
      value: 1,
      status: "ok",
    });
  });

  test("G2: acceptance below one remains ok", () => {
    expect(normaliseAcceptance({ timings: { draft_n: 100, draft_n_accepted: 75 } })).toEqual({
      value: 0.75,
      status: "ok",
    });
  });

  test("G3: zero drafted tokens still reports no draft tokens proposed", () => {
    const metric = normaliseAcceptance({ timings: { draft_n: 0, draft_n_accepted: 0 } });
    expect(metric.status).toBe("unavailable");
    if (metric.status !== "unavailable") throw new Error("expected an unavailable metric");
    expect(metric.value).toBeNull();
    expect(metric.reason).toMatch(/no draft tokens proposed/);
  });
});
