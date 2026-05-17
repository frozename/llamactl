import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { resolve as pathResolve } from 'node:path';
import { aggregateMetrics, percentile } from './scoring.js';
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
        const abs = pathResolve(workload.corpus_path);
        const text = await Bun.file(abs).text();
        rows = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
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
        } catch {
          errors += 1;
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
  }

  return { runId, cellsWritten };
}
