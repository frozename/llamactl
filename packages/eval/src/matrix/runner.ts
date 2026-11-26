import type { Database } from "bun:sqlite";

import { randomUUID } from "node:crypto";
import os from "node:os";

import type { ChatMessage, ToolDef } from "../client.js";
import type { ProvenanceInput, ProvenanceReaders } from "../perf/provenance.js";
import type { EvalEngine, ModelSpec, WorkloadEval } from "./types.js";

import { buildCompletionRequest, completeChat } from "../client.js";
import { collectEvalProvenance } from "../perf/provenance.js";
import { ensureModelServing, teardownIfOwned } from "./lifecycle.js";
import { resolveCorpusPath } from "./repo-root.js";
import { aggregateMetrics, percentile } from "./scoring.js";
import {
  ensureMatrixSchema,
  insertCellRow,
  insertCellRowDetail,
  insertMatrixProvenance,
} from "./store.js";
import { isExternalOnlyEngine } from "./types.js";

type WorkloadAggregate = { primary_metric_value: number; per_class_metrics_json: string };

export interface RunMatrixOpts {
  models: ModelSpec[];
  workloads: WorkloadEval[];
  db: Database;
  runId?: string;
  corpusOverrides?: Map<string, string>;
  concurrency?: number;
  provenanceReaders?: ProvenanceReaders;
  // #517: read-only pre-spawn gate for the managed boots this runner makes;
  // returns the refusal text for a model whose exclusive residency group is
  // occupied, or null to let the boot proceed.
  launchRefusal?: ((model: ModelSpec) => string | null) | undefined;
}

async function loadCorpusRows(
  workload: WorkloadEval,
  corpusOverrides?: Map<string, string>,
): Promise<{ rows: unknown[]; errors: number; loadFailed: boolean }> {
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
    return { rows: [], errors, loadFailed: true };
  }
  return { rows, errors, loadFailed: false };
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
  let errors = 0;
  const runRow = async (rowIndex: number): Promise<void> => {
    const row = rows[rowIndex];
    try {
      const built = workload.prompt_builder(row);
      const structuredOutputsSupported = model.structured_outputs_supported !== false;
      const req = buildCompletionRequest({
        messages: built.messages as ChatMessage[],
        maxTokens: workload.maxTokens ?? 256,
        ...(workload.temperature !== undefined ? { temperature: workload.temperature } : {}),
        // Diffusion hosts draw canvas-init noise from the server's global
        // PRNG and only reseed when the request carries a seed; unseeded
        // sequential rows let that state drift until an unlucky init sends
        // one row into a pathologically slow denoise. AR hosts ignore the
        // seed at temperature 0, so pinning it costs nothing there.
        seed: 0,
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
      totalCompletionTokens += resp.usage?.completion_tokens ?? 0;
      const _msg = resp.choices[0]?.message;
      const completion = `${_msg?.reasoning_content ?? ""}${_msg?.content ?? ""}`;
      const scored = await workload.scorer(row, completion, {
        ...(_msg?.tool_calls !== undefined ? { tool_calls: _msg.tool_calls } : {}),
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

  const batchStartMs = Date.now();
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
  const totalWallMs = Date.now() - batchStartMs;

  return { predictions, rowMetrics, wallMsArr, totalCompletionTokens, totalWallMs, errors };
}

function numberOrZero(value: number | undefined): number {
  return typeof value === "number" ? value : 0;
}

function isPositiveNumber(value: number | undefined): boolean {
  return typeof value === "number" && value > 0;
}

function meanOrZero(sum: number, n: number): number {
  return n > 0 ? sum / n : 0;
}

function aggregateSingleMetricMean(
  rowMetrics: Record<string, number>[],
  metricKey: string,
  meanLabel: string,
): WorkloadAggregate {
  let sum = 0;
  let n = 0;
  for (const metrics of rowMetrics) {
    if (typeof metrics[metricKey] === "number") {
      sum += metrics[metricKey];
      n += 1;
    }
  }
  const mean = meanOrZero(sum, n);
  return {
    primary_metric_value: mean,
    per_class_metrics_json: JSON.stringify({ [meanLabel]: mean, n_scored: n }),
  };
}

function aggregateComposite(rowMetrics: Record<string, number>[]): WorkloadAggregate {
  const sums = {
    intent_preservation: 0,
    contract_clarity: 0,
    noise_removal: 0,
    n_scored: 0,
    n_parse_error: 0,
  };
  let compositeSum = 0;
  for (const metrics of rowMetrics) {
    sums.intent_preservation += numberOrZero(metrics["intent_preservation"]);
    sums.contract_clarity += numberOrZero(metrics["contract_clarity"]);
    sums.noise_removal += numberOrZero(metrics["noise_removal"]);
    if (isPositiveNumber(metrics["parse_error"])) sums.n_parse_error += 1;
    compositeSum += metrics["composite"] ?? 0;
    sums.n_scored += 1;
  }
  return {
    primary_metric_value: meanOrZero(compositeSum, sums.n_scored),
    per_class_metrics_json: JSON.stringify({
      mean_intent_preservation: meanOrZero(sums.intent_preservation, sums.n_scored),
      mean_contract_clarity: meanOrZero(sums.contract_clarity, sums.n_scored),
      mean_noise_removal: meanOrZero(sums.noise_removal, sums.n_scored),
      n_scored: sums.n_scored,
      n_parse_error: sums.n_parse_error,
    }),
  };
}

function aggregateMeanExactMatch(rowMetrics: Record<string, number>[]): WorkloadAggregate {
  return aggregateSingleMetricMean(rowMetrics, "exact_match", "mean_exact_match");
}

export function aggregateMeanPassAt1(rowMetrics: Record<string, number>[]): WorkloadAggregate {
  return aggregateSingleMetricMean(rowMetrics, "pass", "mean_pass_at_1");
}

function aggregateMeanNdcg5(rowMetrics: Record<string, number>[]): WorkloadAggregate {
  let sum = 0;
  let recallSum = 0;
  let n = 0;
  let nParseErrors = 0;
  let nFallback = 0;
  for (const metrics of rowMetrics) {
    if (typeof metrics["ndcg5"] === "number") {
      sum += metrics["ndcg5"];
      recallSum += numberOrZero(metrics["recall5"]);
      n += 1;
    }
    if (isPositiveNumber(metrics["parse_error"])) nParseErrors += 1;
    if (isPositiveNumber(metrics["fallback"])) nFallback += 1;
  }
  const mean = meanOrZero(sum, n);
  return {
    primary_metric_value: mean,
    per_class_metrics_json: JSON.stringify({
      mean_ndcg5: mean,
      mean_recall5: meanOrZero(recallSum, n),
      n_scored: n,
      n_parse_error: nParseErrors,
      n_fallback: nFallback,
    }),
  };
}

function aggregateMeanBriefQuality(rowMetrics: Record<string, number>[]): WorkloadAggregate {
  let sum = 0;
  let n = 0;
  let sumTcs = 0;
  let sumSs = 0;
  let sumPs = 0;
  for (const metrics of rowMetrics) {
    if (typeof metrics["brief_quality"] === "number") {
      sum += metrics["brief_quality"];
      sumTcs += metrics["token_count_score"] ?? 0;
      sumSs += metrics["structure_score"] ?? 0;
      sumPs += metrics["paragraph_score"] ?? 0;
      n += 1;
    }
  }
  const mean = meanOrZero(sum, n);
  return {
    primary_metric_value: mean,
    per_class_metrics_json: JSON.stringify({
      mean_brief_quality: mean,
      mean_token_count_score: meanOrZero(sumTcs, n),
      mean_structure_score: meanOrZero(sumSs, n),
      mean_paragraph_score: meanOrZero(sumPs, n),
      n_scored: n,
    }),
  };
}

function aggregateWorkloadMetrics(
  workload: WorkloadEval,
  predictions: { pred: string; gold: string }[],
  rowMetrics: Record<string, number>[],
): WorkloadAggregate {
  const metricName = workload.primary_metric_name;
  if (metricName === "composite") return aggregateComposite(rowMetrics);
  if (metricName === "mean_exact_match") return aggregateMeanExactMatch(rowMetrics);
  if (metricName === "mean_pass_at_1") return aggregateMeanPassAt1(rowMetrics);
  if (metricName === "mean_ndcg5") return aggregateMeanNdcg5(rowMetrics);
  if (metricName === "mean_brief_quality") return aggregateMeanBriefQuality(rowMetrics);
  const aggregate = aggregateMetrics(predictions);
  return {
    primary_metric_value: aggregate.macro_f1,
    per_class_metrics_json: JSON.stringify(aggregate.per_class),
  };
}

const CTX_SIZE_INLINE_RE = /^--ctx-size(?:\s+|=)(\d+)$/;
const CTX_SIZE_VALUE_RE = /^\d+$/;

function positiveIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Scans `flags` (start_args then extra_args) from the end, so the last
 *  `--ctx-size N` / `--ctx-size=N` / `-c N` occurrence wins.
 *  - An inline `--ctx-size=N` match, or a `--ctx-size`/`-c` followed by an
 *    all-digit argument, ends the scan: N if it is a positive integer,
 *    otherwise null (e.g. `-c 0` yields null, not an earlier value).
 *  - A `--ctx-size`/`-c` with no following argument, or one that is not
 *    all digits (e.g. `-c auto`), is not a match: the scan falls through
 *    to earlier occurrences. */
function lastCtxSize(flags: readonly string[]): number | null {
  for (let i = flags.length - 1; i >= 0; i -= 1) {
    const flag = flags[i];
    if (flag === undefined) continue;
    const inline = CTX_SIZE_INLINE_RE.exec(flag);
    if (inline !== null) return positiveIntOrNull(inline[1]);
    if (flag !== "--ctx-size" && flag !== "-c") continue;
    const next = flags[i + 1];
    if (next !== undefined && CTX_SIZE_VALUE_RE.test(next)) {
      return positiveIntOrNull(next);
    }
  }
  return null;
}

function binaryPathReason(model: ModelSpec, engine: EvalEngine): string | null {
  if (model.binary) return null;
  const suffix = isExternalOnlyEngine(engine) ? ` (engine ${engine} runs outside eval)` : "";
  return `ModelSpec ${model.name} declares no engine binary${suffix}`;
}

function ctxUnavailableReason(model: ModelSpec, engine: EvalEngine): string {
  if (engine === "llamacpp" || engine === "gufo") {
    return `ModelSpec ${model.name} flags declare no --ctx-size/-c`;
  }
  return `engine ${engine} context size is not declared in ModelSpec flags; no --ctx-size`;
}

function matrixProvenanceInput(model: ModelSpec): ProvenanceInput {
  const engine = model.engine ?? "llamacpp";
  const flags = [...(model.start_args ?? []), ...(model.extra_args ?? [])];
  const reasons: NonNullable<ProvenanceInput["reasons"]> = {};
  const binaryReason = binaryPathReason(model, engine);
  if (binaryReason !== null) reasons.binary_path = binaryReason;
  if (engine === "omlx") {
    reasons.gguf_path = `engine omlx serves an MLX model directory, not a GGUF file`;
  }
  const ctx = engine === "llamacpp" || engine === "gufo" ? lastCtxSize(flags) : null;
  if (ctx === null) reasons.ctx = ctxUnavailableReason(model, engine);
  return {
    engine,
    binary_path: model.binary ?? null,
    gguf_path: engine === "omlx" ? null : model.gguf_path,
    quant: model.quant,
    flags,
    ctx,
    ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
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

async function runWorkloadCell(
  opts: RunMatrixOpts,
  model: ModelSpec,
  workload: WorkloadEval,
  runId: string,
  concurrency: number,
): Promise<void> {
  let judgeBoot: Awaited<ReturnType<typeof ensureModelServing>> | undefined;
  if (workload.judge_model) {
    try {
      judgeBoot = await ensureModelServing(workload.judge_model, {
        launchRefusal: opts.launchRefusal,
      });
    } catch (err) {
      recordBootError(model, [workload], runId, opts.db);
      console.warn(
        `[matrix] failed to boot judge for ${workload.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }
  const started = new Date().toISOString();
  const {
    rows,
    errors: corpusErrors,
    loadFailed,
  } = await loadCorpusRows(workload, opts.corpusOverrides);
  try {
    if (loadFailed) {
      insertCellRow(opts.db, {
        run_id: runId,
        runner_version: 1,
        model_name: model.name,
        workload_name: workload.name,
        model_spec_json: JSON.stringify(model),
        n_rows: 0,
        primary_metric_name: workload.primary_metric_name ?? "macro_f1",
        // -1 is a sentinel: not a real score, signals "no data / corpus load failed".
        primary_metric_value: -1,
        per_class_metrics_json: JSON.stringify({ error: "corpus_load_failed" }),
        latency_p50_ms: 0,
        latency_p95_ms: 0,
        throughput_tps: 0,
        errors: corpusErrors,
        started_at: started,
        finished_at: new Date().toISOString(),
        host_machine: os.hostname(),
      });
      return;
    }
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
  } finally {
    if (judgeBoot) {
      await teardownIfOwned(judgeBoot);
    }
  }
}

/** Boot one model, run every workload cell against it, and tear the
 *  boot down. Returns the number of cells written (boot failures are
 *  recorded as error cells). */
async function runModelCells(
  opts: RunMatrixOpts,
  model: ModelSpec,
  runId: string,
  concurrency: number,
): Promise<number> {
  if (opts.provenanceReaders) {
    try {
      const provenance = await collectEvalProvenance(
        matrixProvenanceInput(model),
        opts.provenanceReaders,
      );
      insertMatrixProvenance(opts.db, { run_id: runId, model_name: model.name, provenance });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[matrix] provenance collection failed for ${model.name}: ${message}`);
    }
  }
  let boot: Awaited<ReturnType<typeof ensureModelServing>> | undefined;
  try {
    boot = await ensureModelServing(model, { launchRefusal: opts.launchRefusal });
  } catch (err) {
    const cellsWritten = recordBootError(model, opts.workloads, runId, opts.db);
    console.warn(
      `[matrix] failed to boot ${model.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return cellsWritten;
  }
  let cellsWritten = 0;
  try {
    for (const workload of opts.workloads) {
      await runWorkloadCell(opts, model, workload, runId, concurrency);
      cellsWritten += 1;
    }
  } finally {
    await teardownIfOwned(boot);
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
    cellsWritten += await runModelCells(opts, model, runId, concurrency);
  }

  return { runId, cellsWritten };
}
