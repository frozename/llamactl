import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CellRow, CellRowDetail } from "../src/matrix/types.js";
import type * as types from "../src/matrix/types.js";

import * as store from "../src/matrix/store.js";
import {
  ensureMatrixSchema,
  insertCellRow,
  insertCellRowDetail,
  listCellRowDetails,
  listCellRows,
} from "../src/matrix/store.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

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

function provenance(overrides: Partial<types.EvalProvenance> = {}): types.EvalProvenance {
  return {
    engine: "gufo",
    engine_version: "0.9.1",
    engine_commit: "abc1234",
    binary_sha256: "ab".repeat(32),
    gguf_sha256: "cd".repeat(32),
    hf_revision: "main@deadbeef",
    quant: "Q4_K_M",
    ctx: 32768,
    flags: ["--slots", "2"],
    host: "z13",
    ...overrides,
  };
}

function perfRow(overrides: Partial<types.PerfRunRow> = {}): types.PerfRunRow {
  return {
    run_id: "run-a",
    model_name: "m-a",
    suite_name: "suite-a",
    metric_name: "tok_per_s",
    metric: { value: 42.5, status: "ok" },
    provenance: provenance(),
    started_at: "2025-01-01T00:00:00Z",
    host_machine: "z13",
    ...overrides,
  };
}

describe("perf_runs", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("unavailable metric round-trips as null value with status and reason", () => {
    expect(typeof store.insertPerfRun).toBe("function");
    expect(typeof store.listPerfRuns).toBe("function");
    const metric: types.MetricValue = {
      value: null,
      status: "unavailable",
      reason: "engine reports no draft acceptance",
    };
    store.insertPerfRun(db, perfRow({ metric_name: "acceptance", metric }));

    const rows = store.listPerfRuns(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metric).toEqual(metric);

    const raw = db
      .query("SELECT metric_value, metric_status, metric_reason FROM perf_runs")
      .get() as {
      metric_value: number | null;
      metric_status: string;
      metric_reason: string | null;
    } | null;
    expect(raw).not.toBeNull();
    expect(raw!.metric_value).toBeNull();
    expect(raw!.metric_status).toBe("unavailable");
    expect(raw!.metric_reason).toBe("engine reports no draft acceptance");
  });

  test("a real zero metric stays distinct from unavailable", () => {
    expect(typeof store.insertPerfRun).toBe("function");
    expect(typeof store.listPerfRuns).toBe("function");
    store.insertPerfRun(
      db,
      perfRow({
        metric_name: "unavailable-metric",
        metric: { value: null, status: "unavailable", reason: "no acceptance data" },
      }),
    );
    store.insertPerfRun(
      db,
      perfRow({ metric_name: "zero-metric", metric: { value: 0, status: "ok" } }),
    );

    const rows = store.listPerfRuns(db);
    expect(rows).toHaveLength(2);
    const zero = rows.find((r) => r.metric_name === "zero-metric");
    const unavailable = rows.find((r) => r.metric_name === "unavailable-metric");
    expect(zero?.metric).toEqual({ value: 0, status: "ok" });
    expect(unavailable?.metric).toEqual({
      value: null,
      status: "unavailable",
      reason: "no acceptance data",
    });
  });

  test("provenance round-trips deep-equal including flags, ctx and null engine_commit", () => {
    expect(typeof store.insertPerfRun).toBe("function");
    expect(typeof store.listPerfRuns).toBe("function");
    const full = provenance();
    const noCommit = provenance({ engine_commit: null });
    store.insertPerfRun(db, perfRow({ metric_name: "m-full", provenance: full }));
    store.insertPerfRun(db, perfRow({ metric_name: "m-no-commit", provenance: noCommit }));

    const rows = store.listPerfRuns(db);
    expect(rows).toHaveLength(2);
    const byMetric = new Map(rows.map((r) => [r.metric_name, r.provenance]));
    expect(byMetric.get("m-full")).toEqual(full);
    expect(byMetric.get("m-no-commit")).toEqual(noCommit);
    expect(byMetric.get("m-full")?.flags).toEqual(["--slots", "2"]);
    expect(byMetric.get("m-full")?.ctx).toBe(32768);
    expect(byMetric.get("m-no-commit")?.engine_commit).toBeNull();
    expect(byMetric.get("m-full")?.hf_revision).toBe("main@deadbeef");
  });

  test("insertPerfRun rejects an unavailable metric with an empty or whitespace reason", () => {
    expect(typeof store.insertPerfRun).toBe("function");
    expect(typeof store.listPerfRuns).toBe("function");
    for (const reason of ["", "   "]) {
      const row = perfRow({ metric: { value: null, status: "unavailable", reason } });
      expect(() => store.insertPerfRun(db, row)).toThrow();
      expect(store.listPerfRuns(db)).toEqual([]);
    }
  });

  test("insertPerfRun rejects an ok metric with NaN", () => {
    expect(typeof store.insertPerfRun).toBe("function");
    expect(typeof store.listPerfRuns).toBe("function");
    const row = perfRow({ metric: { value: NaN, status: "ok" } });
    expect(() => store.insertPerfRun(db, row)).toThrow();
    expect(store.listPerfRuns(db)).toEqual([]);
  });

  test("insertPerfRun rejects an ok metric with Infinity", () => {
    expect(typeof store.insertPerfRun).toBe("function");
    expect(typeof store.listPerfRuns).toBe("function");
    const row = perfRow({ metric: { value: Infinity, status: "ok" } });
    expect(() => store.insertPerfRun(db, row)).toThrow();
    expect(store.listPerfRuns(db)).toEqual([]);
  });

  test("insertPerfRun rejects an ok metric whose value is null", () => {
    expect(typeof store.insertPerfRun).toBe("function");
    expect(typeof store.listPerfRuns).toBe("function");
    const row = perfRow({
      metric: { value: null, status: "ok" } as unknown as types.MetricValue,
    });
    expect(() => store.insertPerfRun(db, row)).toThrow();
    expect(store.listPerfRuns(db)).toEqual([]);
  });

  test("a raw INSERT with metric_status ok and NULL metric_value violates the CHECK constraint", () => {
    expect(typeof store.insertPerfRun).toBe("function");
    ensureMatrixSchema(db);
    expect(() =>
      db.run(
        `INSERT INTO perf_runs (
          run_id, model_name, suite_name, metric_name,
          metric_value, metric_status, metric_reason,
          provenance_json, started_at, host_machine
        ) VALUES (
          'run-x', 'm-x', 'suite-x', 'metric-x',
          NULL, 'ok', NULL,
          '{}', '2025-01-01T00:00:00Z', 'z13'
        )`,
      ),
    ).toThrow();
  });

  test("ensureMatrixSchema migrates a legacy matrix_runs-only database additively", () => {
    expect(typeof store.listPerfRuns).toBe("function");
    const dir = mkdtempSync(join(tmpdir(), "llamactl-perf-legacy-"));
    try {
      const path = join(dir, "legacy.db");
      const legacy = new Database(path);
      legacy.run(`
        CREATE TABLE matrix_runs (
          run_id TEXT NOT NULL,
          runner_version INTEGER NOT NULL DEFAULT 0,
          model_name TEXT NOT NULL,
          workload_name TEXT NOT NULL,
          model_spec_json TEXT NOT NULL,
          n_rows INTEGER NOT NULL,
          primary_metric_name TEXT NOT NULL,
          primary_metric_value REAL NOT NULL,
          per_class_metrics_json TEXT NOT NULL,
          latency_p50_ms REAL NOT NULL,
          latency_p95_ms REAL NOT NULL,
          throughput_tps REAL NOT NULL,
          errors INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          host_machine TEXT NOT NULL,
          PRIMARY KEY (run_id, model_name, workload_name)
        )
      `);
      const original = cell({
        run_id: "run-legacy",
        model_name: "m-legacy",
        workload_name: "w-legacy",
      });
      legacy
        .prepare(`INSERT INTO matrix_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          original.run_id,
          original.runner_version,
          original.model_name,
          original.workload_name,
          original.model_spec_json,
          original.n_rows,
          original.primary_metric_name,
          original.primary_metric_value,
          original.per_class_metrics_json,
          original.latency_p50_ms,
          original.latency_p95_ms,
          original.throughput_tps,
          original.errors,
          original.started_at,
          original.finished_at,
          original.host_machine,
        );
      legacy.close();

      const migrated = new Database(path);
      ensureMatrixSchema(migrated);
      ensureMatrixSchema(migrated);

      expect(listCellRows(migrated)).toEqual([original]);

      const perfTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='perf_runs'")
        .get();
      expect(perfTable).toBeTruthy();

      expect(store.listPerfRuns(migrated)).toEqual([]);

      const columns = migrated.query("PRAGMA table_info(matrix_runs)").all() as {
        name: string;
      }[];
      expect(columns.map((c) => c.name)).toEqual([
        "run_id",
        "runner_version",
        "model_name",
        "workload_name",
        "model_spec_json",
        "n_rows",
        "primary_metric_name",
        "primary_metric_value",
        "per_class_metrics_json",
        "latency_p50_ms",
        "latency_p95_ms",
        "throughput_tps",
        "errors",
        "started_at",
        "finished_at",
        "host_machine",
      ]);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("listPerfRuns filters by run_id and model_name and orders deterministically", () => {
    expect(typeof store.insertPerfRun).toBe("function");
    expect(typeof store.listPerfRuns).toBe("function");
    store.insertPerfRun(
      db,
      perfRow({ run_id: "run-b", model_name: "m-b", suite_name: "s2", metric_name: "m2" }),
    );
    store.insertPerfRun(
      db,
      perfRow({ run_id: "run-a", model_name: "m-b", suite_name: "s1", metric_name: "m1" }),
    );
    store.insertPerfRun(
      db,
      perfRow({ run_id: "run-a", model_name: "m-a", suite_name: "s9", metric_name: "m9" }),
    );
    store.insertPerfRun(
      db,
      perfRow({ run_id: "run-a", model_name: "m-a", suite_name: "s1", metric_name: "m2" }),
    );

    const all = store.listPerfRuns(db);
    const keys = all.map((r) => [r.run_id, r.model_name, r.suite_name, r.metric_name].join("/"));
    expect(keys).toEqual([
      "run-a/m-a/s1/m2",
      "run-a/m-a/s9/m9",
      "run-a/m-b/s1/m1",
      "run-b/m-b/s2/m2",
    ]);

    expect(store.listPerfRuns(db, { run_id: "run-a" })).toHaveLength(3);
    expect(store.listPerfRuns(db, { model_name: "m-a" })).toHaveLength(2);
    const both = store.listPerfRuns(db, { run_id: "run-a", model_name: "m-b" });
    expect(both.map((r) => `${r.model_name}/${r.suite_name}/${r.metric_name}`)).toEqual([
      "m-b/s1/m1",
    ]);
  });
});
