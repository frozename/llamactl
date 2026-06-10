import { Database } from "bun:sqlite";
import type { CellRow, CellRowDetail } from "./types.js";

/** Idempotent and safe to call on every operation; v1 may memoize per-Database instance. */
export function ensureMatrixSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS matrix_runs (
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
  db.run(`
    CREATE TABLE IF NOT EXISTS matrix_cell_row_details (
      run_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      workload_name TEXT NOT NULL,
      row_index INTEGER NOT NULL,
      prediction TEXT,
      gold TEXT,
      metrics_json TEXT NOT NULL,
      latency_ms REAL,
      PRIMARY KEY (run_id, model_name, workload_name, row_index)
    )
  `);
}

export function insertCellRow(db: Database, row: CellRow): void {
  ensureMatrixSchema(db);
  db.query(
    `
      INSERT INTO matrix_runs (
        run_id, runner_version, model_name, workload_name, model_spec_json, n_rows,
        primary_metric_name, primary_metric_value, per_class_metrics_json,
        latency_p50_ms, latency_p95_ms, throughput_tps, errors,
        started_at, finished_at, host_machine
      ) VALUES (
        $run_id, $runner_version, $model_name, $workload_name, $model_spec_json, $n_rows,
        $primary_metric_name, $primary_metric_value, $per_class_metrics_json,
        $latency_p50_ms, $latency_p95_ms, $throughput_tps, $errors,
        $started_at, $finished_at, $host_machine
      )
      ON CONFLICT(run_id, model_name, workload_name) DO UPDATE SET
        model_spec_json=excluded.model_spec_json,
        runner_version=excluded.runner_version,
        n_rows=excluded.n_rows,
        primary_metric_name=excluded.primary_metric_name,
        primary_metric_value=excluded.primary_metric_value,
        per_class_metrics_json=excluded.per_class_metrics_json,
        latency_p50_ms=excluded.latency_p50_ms,
        latency_p95_ms=excluded.latency_p95_ms,
        throughput_tps=excluded.throughput_tps,
        errors=excluded.errors,
        started_at=excluded.started_at,
        finished_at=excluded.finished_at,
        host_machine=excluded.host_machine
    `,
  ).run({
    $run_id: row.run_id,
    $runner_version: row.runner_version,
    $model_name: row.model_name,
    $workload_name: row.workload_name,
    $model_spec_json: row.model_spec_json,
    $n_rows: row.n_rows,
    $primary_metric_name: row.primary_metric_name,
    $primary_metric_value: row.primary_metric_value,
    $per_class_metrics_json: row.per_class_metrics_json,
    $latency_p50_ms: row.latency_p50_ms,
    $latency_p95_ms: row.latency_p95_ms,
    $throughput_tps: row.throughput_tps,
    $errors: row.errors,
    $started_at: row.started_at,
    $finished_at: row.finished_at,
    $host_machine: row.host_machine,
  });
}

export function listCellRows(
  db: Database,
  filter: { run_id?: string; workload_name?: string } = {},
): CellRow[] {
  ensureMatrixSchema(db);
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.run_id) {
    clauses.push("run_id = $run_id");
    params.$run_id = filter.run_id;
  }
  if (filter.workload_name) {
    clauses.push("workload_name = $workload_name");
    params.$workload_name = filter.workload_name;
  }
  return db
    .query(
      `SELECT run_id, runner_version, model_name, workload_name, model_spec_json, n_rows, primary_metric_name, primary_metric_value, per_class_metrics_json, latency_p50_ms, latency_p95_ms, throughput_tps, errors, started_at, finished_at, host_machine
       FROM matrix_runs
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY run_id ASC, model_name ASC, workload_name ASC`,
    )
    .all(params as any) as CellRow[];
}

export function insertCellRowDetail(db: Database, detail: CellRowDetail): void {
  ensureMatrixSchema(db);
  db.query(
    `
      INSERT INTO matrix_cell_row_details (
        run_id, model_name, workload_name, row_index,
        prediction, gold, metrics_json, latency_ms
      ) VALUES (
        $run_id, $model_name, $workload_name, $row_index,
        $prediction, $gold, $metrics_json, $latency_ms
      )
      ON CONFLICT(run_id, model_name, workload_name, row_index) DO UPDATE SET
        prediction=excluded.prediction,
        gold=excluded.gold,
        metrics_json=excluded.metrics_json,
        latency_ms=excluded.latency_ms
    `,
  ).run({
    $run_id: detail.run_id,
    $model_name: detail.model_name,
    $workload_name: detail.workload_name,
    $row_index: detail.row_index,
    $prediction: detail.prediction,
    $gold: detail.gold,
    $metrics_json: detail.metrics_json,
    $latency_ms: detail.latency_ms,
  });
}

export function listCellRowDetails(
  db: Database,
  filter: { run_id?: string; model_name?: string; workload_name?: string } = {},
): CellRowDetail[] {
  ensureMatrixSchema(db);
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.run_id) {
    clauses.push("run_id = $run_id");
    params.$run_id = filter.run_id;
  }
  if (filter.model_name) {
    clauses.push("model_name = $model_name");
    params.$model_name = filter.model_name;
  }
  if (filter.workload_name) {
    clauses.push("workload_name = $workload_name");
    params.$workload_name = filter.workload_name;
  }
  return db
    .query(
      `SELECT run_id, model_name, workload_name, row_index, prediction, gold, metrics_json, latency_ms
       FROM matrix_cell_row_details
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY run_id ASC, model_name ASC, workload_name ASC, row_index ASC`,
    )
    .all(params as any) as CellRowDetail[];
}
