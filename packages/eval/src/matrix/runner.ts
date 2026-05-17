import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { ensureMatrixSchema, insertCellRow } from './store.js';
import type { ModelSpec, WorkloadEval } from './types.js';

interface RunMatrixOpts {
  models: ModelSpec[];
  workloads: WorkloadEval[];
  db: Database;
  runId?: string;
}

export async function runMatrix(
  opts: RunMatrixOpts,
): Promise<{ runId: string; cellsWritten: number }> {
  ensureMatrixSchema(opts.db);
  const runId = opts.runId ?? `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  let cellsWritten = 0;

  for (const model of opts.models) {
    for (const workload of opts.workloads) {
      insertCellRow(
        opts.db,
        {
          run_id: runId,
          runner_version: 0,
          model_name: model.name,
          workload_name: workload.name,
          // NOTE: stores model spec verbatim incl. extra_args; do not put secrets in extra_args.
          model_spec_json: JSON.stringify(model),
          n_rows: 0,
          primary_metric_name: workload.primary_metric_name ?? 'primary',
          primary_metric_value: 0,
          per_class_metrics_json: JSON.stringify({}),
          latency_p50_ms: 0,
          latency_p95_ms: 0,
          throughput_tps: 0,
          errors: 0,
          started_at: now,
          finished_at: now,
          host_machine: os.hostname(),
        },
      );
      cellsWritten += 1;
    }
  }

  return { runId, cellsWritten };
}
