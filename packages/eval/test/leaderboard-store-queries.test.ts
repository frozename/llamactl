import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { LeaderboardRow } from "../src/store/sqlite.js";

import { queryRows, upsertRow } from "../src/store/sqlite.js";

function lb(overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    model: "m",
    node: "local",
    ub: 512,
    throughput_tps: 10,
    ttft_ms: 100,
    tool_call_score: 0.7,
    context_8k_score: 0.8,
    context_16k_score: null,
    json_score: 0.75,
    composite: 0.5,
    asof: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("leaderboard store queries", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("queryRows sorts by composite descending by default", () => {
    upsertRow(db, lb({ model: "model-a", composite: 0.2 }));
    upsertRow(db, lb({ model: "model-b", composite: 0.9 }));
    upsertRow(db, lb({ model: "model-c", composite: 0.5 }));

    const result = queryRows(db);
    const models = result.map((r) => r.model);
    expect(models).toEqual(["model-b", "model-c", "model-a"]);
  });

  test("equal sort keys break ties by model, then node, then ub ascending", () => {
    upsertRow(db, lb({ model: "b", node: "local", ub: 512, composite: 0.8 }));
    upsertRow(db, lb({ model: "a", node: "remote", ub: 256, composite: 0.8 }));
    upsertRow(db, lb({ model: "a", node: "local", ub: 512, composite: 0.8 }));
    upsertRow(db, lb({ model: "a", node: "local", ub: 256, composite: 0.8 }));

    const result = queryRows(db);
    const keys = result.map((r) => `${r.model}/${r.node}/${String(r.ub)}`);
    expect(keys).toEqual(["a/local/256", "a/local/512", "a/remote/256", "b/local/512"]);
  });

  test("min_throughput includes rows exactly at the threshold", () => {
    upsertRow(db, lb({ model: "model-24", throughput_tps: 24, composite: 0.3 }));
    upsertRow(db, lb({ model: "model-25", throughput_tps: 25, composite: 0.5 }));
    upsertRow(db, lb({ model: "model-26", throughput_tps: 26, composite: 0.7 }));

    const result = queryRows(db, { min_throughput: 25 });
    const models = result.map((r) => r.model);
    expect(models).toEqual(["model-26", "model-25"]);
  });

  test("min_tool_call_score is inclusive and ANDs with node", () => {
    upsertRow(db, lb({ model: "model-a", node: "remote", tool_call_score: 0.5 }));
    upsertRow(db, lb({ model: "model-b", node: "local", tool_call_score: 0.8 }));
    upsertRow(db, lb({ model: "model-c", node: "remote", tool_call_score: 0.8 }));

    const result = queryRows(db, { node: "local", min_tool_call_score: 0.8 });
    expect(result).toHaveLength(1);
    const first = result[0]!;
    expect(first.model).toEqual("model-b");
  });

  test("ub is part of the upsert key while a same-key upsert replaces every value column", () => {
    upsertRow(db, lb({ model: "m", node: "local", ub: 256 }));
    upsertRow(db, lb({ model: "m", node: "local", ub: 512 }));
    expect(queryRows(db)).toHaveLength(2);

    const updated512 = lb({
      model: "m",
      node: "local",
      ub: 512,
      throughput_tps: 20,
      ttft_ms: 80,
      tool_call_score: 0.9,
      context_8k_score: 0.85,
      context_16k_score: 0.6,
      json_score: 0.8,
      composite: 0.9,
      asof: "2025-02-01T00:00:00Z",
    });
    upsertRow(db, updated512);

    const result = queryRows(db, { sort_by: "ub" });
    expect(result).toEqual([updated512, lb({ model: "m", node: "local", ub: 256 })]);
  });

  test("an empty-string node filter returns all nodes", () => {
    upsertRow(db, lb({ model: "model-a", node: "local" }));
    upsertRow(db, lb({ model: "model-b", node: "remote" }));
    expect(queryRows(db, { node: "" })).toHaveLength(2);
  });

  test("an explicit sort_by sorts that column descending", () => {
    upsertRow(db, lb({ model: "model-a", ttft_ms: 100 }));
    upsertRow(db, lb({ model: "model-b", ttft_ms: 300 }));
    upsertRow(db, lb({ model: "model-c", ttft_ms: 200 }));

    const result = queryRows(db, { sort_by: "ttft_ms" });
    const models = result.map((r) => r.model);
    expect(models).toEqual(["model-b", "model-c", "model-a"]);
  });
});
