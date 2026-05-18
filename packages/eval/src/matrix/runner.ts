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
        let judgeBoot: Awaited<ReturnType<typeof ensureModelServing>> | undefined;
        if (workload.judge_model) {
          judgeBoot = await ensureModelServing(workload.judge_model);
        }
        const started = new Date().toISOString();
        const predictions: Array<{ pred: string; gold: string }> = [];
        const rowMetrics: Array<Record<string, number>> = [];
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
        try {
          for (const row of rows) {
            nRows += 1;
            try {
              const built = workload.prompt_builder(row);
              const req = buildCompletionRequest({
                messages: built.messages as any[],
                maxTokens: 256,
                ...(built.tools ? { tools: built.tools as any[], tool_choice: built.tool_choice } : {}),
              });
              const { resp, wallMs } = await completeChat(`http://${model.host}:${model.port}`, req);
              wallMsArr.push(wallMs);
              totalWallMs += wallMs;
              totalCompletionTokens += resp.usage?.completion_tokens ?? 0;
              const completion = resp.choices[0]?.message?.content ?? '';
              const scored = await workload.scorer(row, completion, {
                tool_calls: resp.choices[0]?.message?.tool_calls,
              });
              predictions.push({ pred: scored.prediction, gold: scored.gold });
              rowMetrics.push(scored.metrics);
            } catch (err) {
              errors += 1;
              const message = err instanceof Error ? err.message : String(err);
              console.warn(`[matrix] inference failed for ${workload.name} row ${nRows}: ${message}`);
            }
          }
        } finally {
          if (judgeBoot) {
            await teardownIfOwned(judgeBoot);
          }
        }
        const finished = new Date().toISOString();
        const agg =
          workload.primary_metric_name === 'composite'
            ? (() => {
                const sums = { intent_preservation: 0, contract_clarity: 0, noise_removal: 0, n_scored: 0, n_parse_error: 0 };
                let compositeSum = 0;
                for (const metrics of rowMetrics) {
                  if (typeof metrics.intent_preservation === 'number') sums.intent_preservation += metrics.intent_preservation;
                  if (typeof metrics.contract_clarity === 'number') sums.contract_clarity += metrics.contract_clarity;
                  if (typeof metrics.noise_removal === 'number') sums.noise_removal += metrics.noise_removal;
                  if (typeof metrics.parse_error === 'number' && metrics.parse_error > 0) sums.n_parse_error += 1;
                  compositeSum += metrics.composite ?? 0;
                  sums.n_scored += 1;
                }
                return {
                  primary_metric_value: sums.n_scored > 0 ? compositeSum / sums.n_scored : 0,
                  per_class_metrics_json: JSON.stringify({
                    mean_intent_preservation: sums.n_scored > 0 ? sums.intent_preservation / sums.n_scored : 0,
                    mean_contract_clarity: sums.n_scored > 0 ? sums.contract_clarity / sums.n_scored : 0,
                    mean_noise_removal: sums.n_scored > 0 ? sums.noise_removal / sums.n_scored : 0,
                    n_scored: sums.n_scored,
                    n_parse_error: sums.n_parse_error,
                  }),
                };
              })()
            : workload.primary_metric_name === 'mean_exact_match'
            ? (() => {
                let sum = 0;
                let n = 0;
                for (const metrics of rowMetrics) {
                  if (typeof metrics.exact_match === 'number') {
                    sum += metrics.exact_match;
                    n += 1;
                  }
                }
                const mean = n > 0 ? sum / n : 0;
                return {
                  primary_metric_value: mean,
                  per_class_metrics_json: JSON.stringify({ mean_exact_match: mean, n_scored: n }),
                };
              })()
            : workload.primary_metric_name === 'mean_ndcg5'
            ? (() => {
                let sum = 0;
                let n = 0;
                let nParseErrors = 0;
                for (const metrics of rowMetrics) {
                  if (typeof metrics.ndcg5 === 'number') {
                    sum += metrics.ndcg5;
                    n += 1;
                  }
                  if (typeof metrics.parse_error === 'number' && metrics.parse_error > 0) nParseErrors += 1;
                }
                const mean = n > 0 ? sum / n : 0;
                return {
                  primary_metric_value: mean,
                  per_class_metrics_json: JSON.stringify({ mean_ndcg5: mean, n_scored: n, n_parse_error: nParseErrors }),
                };
              })()
            : (() => {
                const aggregate = aggregateMetrics(predictions);
                return {
                  primary_metric_value: aggregate.macro_f1,
                  per_class_metrics_json: JSON.stringify(aggregate.per_class),
                };
              })();
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
          primary_metric_value: agg.primary_metric_value,
          per_class_metrics_json: agg.per_class_metrics_json,
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
