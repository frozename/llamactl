import type { Database } from "bun:sqlite";

import { randomUUID } from "node:crypto";
import os from "node:os";

import type { ChatMessage, ToolDef } from "../client.js";
import type { ModelSpec, WorkloadEval } from "./types.js";

import { buildCompletionRequest, completeChat } from "../client.js";
import { ensureModelServing, teardownIfOwned } from "./lifecycle.js";
import { resolveCorpusPath } from "./repo-root.js";
import { aggregateMetrics, percentile } from "./scoring.js";
import { ensureMatrixSchema, insertCellRow, insertCellRowDetail } from "./store.js";

type WorkloadAggregate = { primary_metric_value: number; per_class_metrics_json: string };

interface RunMatrixOpts {
  models: ModelSpec[];
  workloads: WorkloadEval[];
  db: Database;
  runId?: string;
  corpusOverrides?: Map<string, string>;
  concurrency?: number;
}

async function loadCorpusRows(
  workload: WorkloadEval,
  corpusOverrides?: Map<string, string>,
): Promise<{ rows: unknown[]; errors: number }> {
  let rows: unknown[] = [];
  let errors = 0;
  try {
    const corpusPath = corpusOverrides?.get(workload.name) ?? workload.corpus_path;
    const abs = resolveCorpusPath(corpusPath);
    const text = await Bun.file(abs).text();
    const lines = text.split("\n").filter(Boolean);
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
  return { rows, errors };
}

async function runWorkloadRows(
  model: ModelSpec,
  workload: WorkloadEval,
  rows: unknown[],
  concurrency: number,
  runId: string,
  db: Database,
): Promise<{
  predictions: { pred: string; gold: string }[];
  rowMetrics: Record<string, number>[];
  wallMsArr: number[];
  totalCompletionTokens: number;
  totalWallMs: number;
  errors: number;
}> {
  const predictions: { pred: string; gold: string }[] = [];
  const rowMetrics: Record<string, number>[] = [];
  const wallMsArr: number[] = [];
  let totalCompletionTokens = 0;
  let totalWallMs = 0;
  let errors = 0;
  const runRow = async (rowIndex: number): Promise<void> => {
    const row = rows[rowIndex];
    try {
      const built = workload.prompt_builder(row);
      const structuredOutputsSupported = model.structured_outputs_supported !== false;
      const req = buildCompletionRequest({
        messages: built.messages as ChatMessage[],
        maxTokens: workload.maxTokens ?? 256,
        temperature: workload.temperature,
        ...(model.request_model_id ? { model: model.request_model_id } : {}),
        ...(model.disable_thinking ? { enableThinking: false } : {}),
        ...(built.tools ? { tools: built.tools as ToolDef[], tool_choice: built.tool_choice } : {}),
        ...(structuredOutputsSupported && workload.response_format
          ? { response_format: workload.response_format }
          : {}),
      });
      const { resp, wallMs } = await completeChat(
        `http://${model.host}:${String(model.port)}`,
        req,
      );
      wallMsArr.push(wallMs);
      totalWallMs += wallMs;
      totalCompletionTokens += resp.usage?.completion_tokens ?? 0;
      const _msg = resp.choices[0]?.message;
      const completion = `${_msg?.reasoning_content ?? ""}${_msg?.content ?? ""}`;
      const scored = await workload.scorer(row, completion, {
        tool_calls: _msg?.tool_calls,
      });
      predictions.push({ pred: scored.prediction, gold: scored.gold });
      rowMetrics.push(scored.metrics);
      insertCellRowDetail(db, {
        run_id: runId,
        model_name: model.name,
        workload_name: workload.name,
        row_index: rowIndex,
        prediction: scored.prediction,
        gold: scored.gold,
        metrics_json: JSON.stringify(scored.metrics),
        latency_ms: wallMs,
      });
    } catch (err) {
      errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[matrix] inference failed for ${workload.name} row ${String(rowIndex + 1)}: ${message}`,
      );
    }
  };

  if (concurrency === 1 || rows.length <= 1) {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      await runRow(rowIndex);
    }
  } else {
    let nextRowIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      for (;;) {
        const rowIndex = nextRowIndex;
        nextRowIndex += 1;
        if (rowIndex >= rows.length) {
          return;
        }
        await runRow(rowIndex);
      }
    });
    await Promise.all(workers);
  }

  return { predictions, rowMetrics, wallMsArr, totalCompletionTokens, totalWallMs, errors };
}

function aggregateWorkloadMetrics(
  workload: WorkloadEval,
  predictions: { pred: string; gold: string }[],
  rowMetrics: Record<string, number>[],
): WorkloadAggregate {
  const metricName = workload.primary_metric_name;
  if (metricName === "composite") {
    const sums = {
      intent_preservation: 0,
      contract_clarity: 0,
      noise_removal: 0,
      n_scored: 0,
      n_parse_error: 0,
    };
    let compositeSum = 0;
    for (const metrics of rowMetrics) {
      if (typeof metrics.intent_preservation === "number")
        sums.intent_preservation += metrics.intent_preservation;
      if (typeof metrics.contract_clarity === "number")
        sums.contract_clarity += metrics.contract_clarity;
      if (typeof metrics.noise_removal === "number") sums.noise_removal += metrics.noise_removal;
      if (typeof metrics.parse_error === "number" && metrics.parse_error > 0)
        sums.n_parse_error += 1;
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
  }
  if (metricName === "mean_exact_match") {
    let sum = 0;
    let n = 0;
    for (const metrics of rowMetrics) {
      if (typeof metrics.exact_match === "number") {
        sum += metrics.exact_match;
        n += 1;
      }
    }
    const mean = n > 0 ? sum / n : 0;
    return {
      primary_metric_value: mean,
      per_class_metrics_json: JSON.stringify({ mean_exact_match: mean, n_scored: n }),
    };
  }
  if (metricName === "mean_ndcg5") {
    let sum = 0;
    let recallSum = 0;
    let n = 0;
    let nParseErrors = 0;
    let nFallback = 0;
    for (const metrics of rowMetrics) {
      if (typeof metrics.ndcg5 === "number") {
        sum += metrics.ndcg5;
        recallSum += typeof metrics.recall5 === "number" ? metrics.recall5 : 0;
        n += 1;
      }
      if (typeof metrics.parse_error === "number" && metrics.parse_error > 0) nParseErrors += 1;
      if (typeof metrics.fallback === "number" && metrics.fallback > 0) nFallback += 1;
    }
    const mean = n > 0 ? sum / n : 0;
    return {
      primary_metric_value: mean,
      per_class_metrics_json: JSON.stringify({
        mean_ndcg5: mean,
        mean_recall5: n > 0 ? recallSum / n : 0,
        n_scored: n,
        n_parse_error: nParseErrors,
        n_fallback: nFallback,
      }),
    };
  }
  if (metricName === "mean_brief_quality") {
    let sum = 0;
    let n = 0;
    let sumTcs = 0;
    let sumSs = 0;
    let sumPs = 0;
    for (const metrics of rowMetrics) {
      if (typeof metrics.brief_quality === "number") {
        sum += metrics.brief_quality;
        sumTcs += metrics.token_count_score ?? 0;
        sumSs += metrics.structure_score ?? 0;
        sumPs += metrics.paragraph_score ?? 0;
        n += 1;
      }
    }
    const mean = n > 0 ? sum / n : 0;
    return {
      primary_metric_value: mean,
      per_class_metrics_json: JSON.stringify({
        mean_brief_quality: mean,
        mean_token_count_score: n > 0 ? sumTcs / n : 0,
        mean_structure_score: n > 0 ? sumSs / n : 0,
        mean_paragraph_score: n > 0 ? sumPs / n : 0,
        n_scored: n,
      }),
    };
  }
  const aggregate = aggregateMetrics(predictions);
  return {
    primary_metric_value: aggregate.macro_f1,
    per_class_metrics_json: JSON.stringify(aggregate.per_class),
  };
}

function recordBootError(
  model: ModelSpec,
  workloads: WorkloadEval[],
  runId: string,
  db: Database,
): number {
  let cellsWritten = 0;
  for (const workload of workloads) {
    const now = new Date().toISOString();
    insertCellRow(db, {
      run_id: runId,
      runner_version: 1,
      model_name: model.name,
      workload_name: workload.name,
      model_spec_json: JSON.stringify(model),
      n_rows: 0,
      primary_metric_name: workload.primary_metric_name ?? "macro_f1",
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
  return cellsWritten;
}

export async function runMatrix(
  opts: RunMatrixOpts,
): Promise<{ runId: string; cellsWritten: number }> {
  if (opts.models.length === 0) {
    throw new Error("runMatrix: models list is empty — no work to do");
  }
  if (opts.workloads.length === 0) {
    throw new Error("runMatrix: workloads list is empty — no work to do");
  }
  const concurrency = opts.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("runMatrix: concurrency must be an integer between 1 and 8");
  }
  ensureMatrixSchema(opts.db);
  const runId = opts.runId ?? `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
  let cellsWritten = 0;

  for (const model of opts.models) {
    let boot: Awaited<ReturnType<typeof ensureModelServing>> | undefined;
    try {
      boot = await ensureModelServing(model);
    } catch (err) {
      cellsWritten += recordBootError(model, opts.workloads, runId, opts.db);
      console.warn(
        `[matrix] failed to boot ${model.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    try {
      for (const workload of opts.workloads) {
        let judgeBoot: Awaited<ReturnType<typeof ensureModelServing>> | undefined;
        if (workload.judge_model) {
          judgeBoot = await ensureModelServing(workload.judge_model);
        }
        const started = new Date().toISOString();
        const { rows, errors: corpusErrors } = await loadCorpusRows(workload, opts.corpusOverrides);
        try {
          const result = await runWorkloadRows(model, workload, rows, concurrency, runId, opts.db);
          const finished = new Date().toISOString();
          const agg = aggregateWorkloadMetrics(workload, result.predictions, result.rowMetrics);
          const wallSec = result.totalWallMs / 1000;
          const throughput = wallSec > 0 ? result.totalCompletionTokens / wallSec : 0;
          insertCellRow(opts.db, {
            run_id: runId,
            runner_version: 1,
            model_name: model.name,
            workload_name: workload.name,
            model_spec_json: JSON.stringify(model),
            n_rows: rows.length,
            primary_metric_name: workload.primary_metric_name ?? "macro_f1",
            primary_metric_value: agg.primary_metric_value,
            per_class_metrics_json: agg.per_class_metrics_json,
            latency_p50_ms: percentile(result.wallMsArr, 50),
            latency_p95_ms: percentile(result.wallMsArr, 95),
            throughput_tps: throughput,
            errors: corpusErrors + result.errors,
            started_at: started,
            finished_at: finished,
            host_machine: os.hostname(),
          });
          cellsWritten += 1;
        } finally {
          if (judgeBoot) {
            await teardownIfOwned(judgeBoot);
          }
        }
      }
    } finally {
      await teardownIfOwned(boot);
    }
  }

  return { runId, cellsWritten };
}
