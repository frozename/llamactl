import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { aggregateMetrics, percentile } from './scoring.js';
import { ensureModelServing, teardownIfOwned } from './lifecycle.js';
import { resolveCorpusPath } from './repo-root.js';
import { ensureMatrixSchema, insertCellRow } from './store.js';
import { buildCompletionRequest, completeChat } from '../client.js';
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
  let cellsWritten = 0;

  for (const model of opts.models) {
    let boot: Awaited<ReturnType<typeof ensureModelServing>> | undefined;
    try {
      boot = await ensureModelServing(model);
    } catch (err) {
      for (const workload of opts.workloads) {
        const now = new Date().toISOString();
        insertCellRow(opts.db, {
          run_id: runId,
          runner_version: 1,
          model_name: model.name,
          workload_name: workload.name,
          model_spec_json: JSON.stringify(model),
          n_rows: 0,
          primary_metric_name: workload.primary_metric_name ?? 'macro_f1',
          primary_metric_value: 0,
          per_class_metrics_json: JSON.stringify({}),
          latency_p50_ms: 0,
          latency_p95_ms: 0,
          throughput_tps: 0,
          errors: 1,
          started_at: now,
          finished_at: now,
          host_machine: os.hostname(),
        });
        cellsWritten += 1;
      }
      console.warn(`[matrix] failed to boot ${model.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    try {
      for (const workload of opts.workloads) {
        const started = new Date().toISOString();
        const predictions: Array<{ pred: string; gold: string }> = [];
        const wallMsArr: number[] = [];
        let totalCompletionTokens = 0;
        let totalWallMs = 0;
        let errors = 0;
        let nRows = 0;
        let rows: unknown[] = [];
        try {
          const abs = resolveCorpusPath(workload.corpus_path);
          const text = await Bun.file(abs).text();
          const lines = text.split('\n').filter(Boolean);
          rows = [];
          for (const line of lines) {
            try {
              rows.push(JSON.parse(line));
            } catch {
              errors += 1;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[matrix] corpus load failed for ${workload.name}: ${message}`);
          errors += 1;
        }
        for (const row of rows) {
          nRows += 1;
          try {
            const built = workload.prompt_builder(row) as { messages: any[] };
            const req = buildCompletionRequest({ messages: built.messages, maxTokens: 256 });
            const { resp, wallMs } = await completeChat(`http://${model.host}:${model.port}`, req);
            wallMsArr.push(wallMs);
            totalWallMs += wallMs;
            totalCompletionTokens += resp.usage?.completion_tokens ?? 0;
            const completion = resp.choices[0]?.message?.content ?? '';
            const { prediction, gold } = workload.scorer(row, completion);
            predictions.push({ pred: prediction, gold });
          } catch (err) {
            errors += 1;
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[matrix] inference failed for ${workload.name} row ${nRows}: ${message}`);
          }
        }
        const finished = new Date().toISOString();
        const agg = aggregateMetrics(predictions);
        const wallSec = totalWallMs / 1000;
        const throughput = wallSec > 0 ? totalCompletionTokens / wallSec : 0;
        insertCellRow(opts.db, {
          run_id: runId,
          runner_version: 1,
          model_name: model.name,
          workload_name: workload.name,
          model_spec_json: JSON.stringify(model),
          n_rows: nRows,
          primary_metric_name: workload.primary_metric_name ?? 'macro_f1',
          primary_metric_value: agg.macro_f1,
          per_class_metrics_json: JSON.stringify(agg.per_class),
          latency_p50_ms: percentile(wallMsArr, 50),
          latency_p95_ms: percentile(wallMsArr, 95),
          throughput_tps: throughput,
          errors,
          started_at: started,
          finished_at: finished,
          host_machine: os.hostname(),
        });
        cellsWritten += 1;
      }
    } finally {
      await teardownIfOwned(boot);
    }
  }

  return { runId, cellsWritten };
}
