import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { CellRow, CellRowDetail } from "../src/matrix/types.js";

import {
  ensureMatrixSchema,
  insertCellRow,
  insertCellRowDetail,
  listCellRowDetails,
  listCellRows,
} from "../src/matrix/store.js";

function cell(overrides: Partial<CellRow> = {}): CellRow {
  return {
    run_id: "run-a",
    runner_version: 1,
    model_name: "m-a",
    workload_name: "w-a",
    model_spec_json: JSON.stringify({ name: "m-a" }),
    n_rows: 10,
    primary_metric_name: "accuracy",
    primary_metric_value: 0.9,
    per_class_metrics_json: JSON.stringify({ a: 0.9 }),
    latency_p50_ms: 50,
    latency_p95_ms: 95,
    throughput_tps: 100,
    errors: 0,
    started_at: "2025-01-01T00:00:00Z",
    finished_at: "2025-01-01T01:00:00Z",
    host_machine: "m4",
    ...overrides,
  };
}

function detail(overrides: Partial<CellRowDetail> = {}): CellRowDetail {
  return {
    run_id: "run-a",
    model_name: "m-a",
    workload_name: "w-a",
    row_index: 0,
    prediction: "pred",
    gold: "gold",
    metrics_json: JSON.stringify({ score: 0.9 }),
    latency_ms: 50,
    ...overrides,
  };
}

describe("matrix store queries", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("insertCellRow on an existing run/model/workload key replaces every non-key column", () => {
    const original = cell();
    insertCellRow(db, original);

    const updated = cell({
      runner_version: 2,
      model_spec_json: JSON.stringify({ name: "updated" }),
      n_rows: 20,
      primary_metric_name: "f1",
      primary_metric_value: 0.95,
      per_class_metrics_json: JSON.stringify({ a: 0.95 }),
      latency_p50_ms: 60,
      latency_p95_ms: 110,
      throughput_tps: 120,
      errors: 1,
      started_at: "2025-02-01T00:00:00Z",
      finished_at: "2025-02-01T01:00:00Z",
      host_machine: "m5",
    });
    insertCellRow(db, updated);

    expect(listCellRows(db)).toEqual([updated]);
  });

  test("rows that differ only in workload_name are stored separately", () => {
    insertCellRow(db, cell({ workload_name: "w-a" }));
    insertCellRow(db, cell({ workload_name: "w-b" }));
    expect(listCellRows(db)).toHaveLength(2);
  });

  test("listCellRows orders by run_id, then model_name, then workload_name", () => {
    insertCellRow(db, cell({ run_id: "run-b", model_name: "m-a", workload_name: "w-a" }));
    insertCellRow(db, cell({ run_id: "run-a", model_name: "m-b", workload_name: "w-a" }));
    insertCellRow(db, cell({ run_id: "run-a", model_name: "m-a", workload_name: "w-b" }));
    insertCellRow(db, cell({ run_id: "run-a", model_name: "m-a", workload_name: "w-a" }));

    const result = listCellRows(db);
    const keys = result.map((r) => `${r.run_id}/${r.model_name}/${r.workload_name}`);
    expect(keys).toEqual(["run-a/m-a/w-a", "run-a/m-a/w-b", "run-a/m-b/w-a", "run-b/m-a/w-a"]);
  });

  test("listCellRows filters by workload_name alone and ANDs it with run_id", () => {
    insertCellRow(db, cell({ run_id: "run-1", model_name: "m-a", workload_name: "w-1" }));
    insertCellRow(db, cell({ run_id: "run-1", model_name: "m-b", workload_name: "w-2" }));
    insertCellRow(db, cell({ run_id: "run-2", model_name: "m-c", workload_name: "w-1" }));

    const byWorkload = listCellRows(db, { workload_name: "w-1" });
    const byWorkloadKeys = byWorkload.map((r) => `${r.run_id}/${r.model_name}/${r.workload_name}`);
    expect(byWorkloadKeys).toEqual(["run-1/m-a/w-1", "run-2/m-c/w-1"]);

    const byRunAndWorkload = listCellRows(db, { run_id: "run-1", workload_name: "w-1" });
    const byRunWorkloadKeys = byRunAndWorkload.map(
      (r) => `${r.run_id}/${r.model_name}/${r.workload_name}`,
    );
    expect(byRunWorkloadKeys).toEqual(["run-1/m-a/w-1"]);
  });

  test("an empty-string run_id filter returns all rows", () => {
    insertCellRow(db, cell({ run_id: "run-1" }));
    insertCellRow(db, cell({ run_id: "run-2" }));
    expect(listCellRows(db, { run_id: "" })).toHaveLength(2);
  });

  test("listCellRows creates the schema on a fresh database", () => {
    const freshDb = new Database(":memory:");
    expect(listCellRows(freshDb)).toEqual([]);
    freshDb.close();
  });

  test("ensureMatrixSchema is idempotent and keeps existing rows", () => {
    const row = cell();
    insertCellRow(db, row);
    ensureMatrixSchema(db);
    ensureMatrixSchema(db);
    expect(listCellRows(db)).toEqual([row]);
  });

  test("insertCellRowDetail upsert replaces prediction, gold and metrics_json", () => {
    const original = detail();
    insertCellRowDetail(db, original);
    const updated = detail({
      prediction: "updated-pred",
      gold: "updated-gold",
      metrics_json: JSON.stringify({ score: 0.95 }),
    });
    insertCellRowDetail(db, updated);

    const details = listCellRowDetails(db);
    expect(details).toEqual([updated]);
  });

  test("listCellRowDetails filters by model_name and orders by model_name then row_index", () => {
    insertCellRowDetail(db, detail({ model_name: "m-b", row_index: 0 }));
    insertCellRowDetail(db, detail({ model_name: "m-a", row_index: 1 }));
    insertCellRowDetail(db, detail({ model_name: "m-a", row_index: 0 }));

    const all = listCellRowDetails(db);
    const allKeys = all.map((d) => `${d.model_name}/${String(d.row_index)}`);
    expect(allKeys).toEqual(["m-a/0", "m-a/1", "m-b/0"]);

    const filtered = listCellRowDetails(db, { model_name: "m-b" });
    const filteredKeys = filtered.map((d) => `${d.model_name}/${String(d.row_index)}`);
    expect(filteredKeys).toEqual(["m-b/0"]);
  });

  test("null prediction, gold and latency_ms round-trip as null", () => {
    const row = detail({ prediction: null, gold: null, latency_ms: null });
    insertCellRowDetail(db, row);

    const details = listCellRowDetails(db);
    const fetched = details[0]!;
    expect(fetched.prediction).toBeNull();
    expect(fetched.gold).toBeNull();
    expect(fetched.latency_ms).toBeNull();
  });
});
