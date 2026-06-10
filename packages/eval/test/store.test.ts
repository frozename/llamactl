import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { queryRows, upsertRow } from "../src/store/sqlite.js";

const row = {
  model: "qwen",
  node: "local",
  ub: 512 as const,
  throughput_tps: 24,
  ttft_ms: 1500,
  tool_call_score: 0.8,
  context_8k_score: 0.75,
  context_16k_score: null,
  json_score: 1,
  composite: 0.7,
  asof: "2026-05-05T00:00:00.000Z",
};

describe("sqlite leaderboard store", () => {
  test("upserts and filters rows from a temp database", () => {
    const db = new Database(":memory:");
    upsertRow(db, row);
    upsertRow(db, { ...row, throughput_tps: 28, composite: 0.8 });

    const rows = queryRows(db, { node: "local", min_throughput: 25, sort_by: "throughput_tps" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "qwen", throughput_tps: 28, composite: 0.8 });
  });
});
