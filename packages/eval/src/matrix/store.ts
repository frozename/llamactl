import { Database } from 'bun:sqlite';
import type { CellRow } from './types.js';

export function ensureMatrixSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS matrix_runs (
      run_id TEXT NOT NULL,
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
}

export function insertCellRow(db: Database, row: CellRow): void {
  ensureMatrixSchema(db);
  db
    .query(
      `
      INSERT INTO matrix_runs (
        run_id, model_name, workload_name, model_spec_json, n_rows,
        primary_metric_name, primary_metric_value, per_class_metrics_json,
        latency_p50_ms, latency_p95_ms, throughput_tps, errors,
        started_at, finished_at, host_machine
      ) VALUES (
        $run_id, $model_name, $workload_name, $model_spec_json, $n_rows,
        $primary_metric_name, $primary_metric_value, $per_class_metrics_json,
        $latency_p50_ms, $latency_p95_ms, $throughput_tps, $errors,
        $started_at, $finished_at, $host_machine
      )
      ON CONFLICT(run_id, model_name, workload_name) DO UPDATE SET
        model_spec_json=excluded.model_spec_json,
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
    )
    .run({
      $run_id: row.run_id,
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
    clauses.push('run_id = $run_id');
    params.$run_id = filter.run_id;
  }
  if (filter.workload_name) {
    clauses.push('workload_name = $workload_name');
    params.$workload_name = filter.workload_name;
  }
  return db
    .query(
      `SELECT run_id, model_name, workload_name, model_spec_json, n_rows, primary_metric_name, primary_metric_value, per_class_metrics_json, latency_p50_ms, latency_p95_ms, throughput_tps, errors, started_at, finished_at, host_machine
       FROM matrix_runs
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY run_id ASC, model_name ASC, workload_name ASC`,
    )
    .all(params as any) as CellRow[];
}
