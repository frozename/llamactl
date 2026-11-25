// Evidence producer for evidence-based promotion (frozename/llamactl#518).
// Pure logic over CellRows: no IO, no clock, no default mapping.

import type { Database } from "bun:sqlite";

import { qualificationPromotion } from "@llamactl/core";
import { z } from "zod";

import type { CellRow } from "../matrix/types.js";

import { compareMetric } from "../matrix/diff.js";

const { parsePromotionEvidence, PROMOTION_METRICS } = qualificationPromotion;

type PromotionEvidence = z.infer<typeof qualificationPromotion.PromotionEvidenceSchema>;
type PromotionMetric = (typeof qualificationPromotion.PROMOTION_METRICS)[number];

const ABSOLUTE_METRICS = [
  "firstAttemptSuccess",
  "repairSuccess",
  "toolCallCorrectness",
  "structuredOutputValidity",
  "memoryStability",
  "runtimeReliability",
] as const;

/** A metric an evidence map may declare; never `regression` or `improvement`. */
export type QualificationEvidenceAbsoluteMetric = (typeof ABSOLUTE_METRICS)[number];

type AbsoluteMetric = QualificationEvidenceAbsoluteMetric;

/** A non-empty list of non-empty workload names, deduplicated in first-seen order. */
const WorkloadListSchema = z
  .array(z.string().min(1))
  .min(1)
  .transform((arr) => [...new Set(arr)]);

/**
 * Evidence mapping: each absolute metric key is optional, at least one is
 * required, and unknown keys (including `regression`/`improvement`) are refused.
 */
export const QualificationEvidenceMappingSchema = z
  .object({
    metrics: z
      .object({
        firstAttemptSuccess: WorkloadListSchema.optional(),
        repairSuccess: WorkloadListSchema.optional(),
        toolCallCorrectness: WorkloadListSchema.optional(),
        structuredOutputValidity: WorkloadListSchema.optional(),
        memoryStability: WorkloadListSchema.optional(),
        runtimeReliability: WorkloadListSchema.optional(),
      })
      .strict()
      .refine((obj) => Object.keys(obj).length > 0, {
        message: "metrics must contain at least one key",
      }),
  })
  .strict();

/** A parsed evidence mapping: only the metric keys the input declared. */
export interface QualificationEvidenceMapping {
  metrics: Partial<Record<AbsoluteMetric, string[]>>;
}

/**
 * Parse and validate an evidence mapping input. The result copies only the
 * metric keys whose parsed value is defined, so it never carries an undefined
 * key and is assignable under `exactOptionalPropertyTypes`.
 */
export function parseQualificationEvidenceMapping(input: unknown): QualificationEvidenceMapping {
  const parsed = QualificationEvidenceMappingSchema.parse(input);
  const metrics: Partial<Record<AbsoluteMetric, string[]>> = {};
  for (const metric of ABSOLUTE_METRICS) {
    const workloads = parsed.metrics[metric];
    if (workloads !== undefined) metrics[metric] = workloads;
  }
  return { metrics };
}

/**
 * Read matrix cell rows from a readonly database handle without calling
 * `ensureMatrixSchema` — it works on legacy databases that lack newer tables.
 */
export function readMatrixCellRows(db: Database): CellRow[] {
  return db
    .query(
      `SELECT run_id, runner_version, model_name, workload_name, model_spec_json, n_rows, primary_metric_name, primary_metric_value, per_class_metrics_json, latency_p50_ms, latency_p95_ms, throughput_tps, errors, started_at, finished_at, host_machine
       FROM matrix_runs
       ORDER BY run_id ASC, model_name ASC, workload_name ASC`,
    )
    .all() as CellRow[];
}

/** A missing cell entry for the refusal result. */
type MissingCell =
  | { side: "candidate"; metric: AbsoluteMetric; workload: string }
  | { side: "baseline"; workload: string };

/** Result of evidence-from-cells computation. */
type QualificationEvidenceResult =
  | { ok: true; evidence: PromotionEvidence }
  | { ok: false; reason: "missing-cells"; missing: MissingCell[] }
  | { ok: false; reason: "baseline-is-candidate"; workloads: string[] };

/** Options passed to `qualificationEvidenceFromCells`. */
interface EvidenceOptions {
  model: string;
  mapping: QualificationEvidenceMapping;
  runId?: string;
  baseline?: { model: string; runId: string };
}

/**
 * Build promotion evidence from eval matrix cells plus an optional baseline
 * run. Pure logic: no IO, no clock, no default mapping.
 *
 * Steps:
 * 1. Candidate pool: cells with model_name === model, filtered by run_id.
 * 2. Select one cell per workload: max finished_at (string compare), tie
 *    broken by greater run_id.
 * 3. A mapped (metric, workload) pair is missing when there is no cell or
 *    the selected cell has n_rows <= 0.
 * 4. Compared workloads W: the distinct mapped workloads, in
 *    PROMOTION_METRICS order then mapping order.
 * 5. With a baseline: baseline pool, select per workload as in step 2.
 *    A workload in W with no baseline cell (or n_rows <= 0) is a baseline
 *    missing entry — listed after candidate entries, in W order.
 * 6. Each mapped metric = Σ(primary_metric_value × n_rows) / Σ n_rows.
 * 7. evaluatedTasks = Σ n_rows over distinct selected candidate cells.
 * 8. With a baseline, regression and improvement are computed per compareMetric.
 * 9. evidenceRef = `matrix:<model>@<run ids>;baseline=<model>@<run id>`.
 * 10. Return `{ ok: true, evidence: parsePromotionEvidence(raw) }`.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity, max-lines-per-function
export function qualificationEvidenceFromCells(
  cells: readonly CellRow[],
  opts: EvidenceOptions,
): QualificationEvidenceResult {
  const { model, mapping, runId, baseline } = opts;

  // Step 1: Candidate pool filtered by model (and runId when set).
  const candidatePool = cells.filter(
    (c) => c.model_name === model && (runId === undefined || c.run_id === runId),
  );

  // Step 2: Select one cell per workload (max finished_at, tie by run_id).
  const candidateByWorkload = new Map<string, CellRow>();
  for (const c of candidatePool) {
    const existing = candidateByWorkload.get(c.workload_name);
    if (
      existing === undefined ||
      c.finished_at > existing.finished_at ||
      (c.finished_at === existing.finished_at && c.run_id > existing.run_id)
    ) {
      candidateByWorkload.set(c.workload_name, c);
    }
  }

  // Step 3: Determine which (metric, workload) pairs are missing.
  const missing: MissingCell[] = [];
  const mappedWorkloads = new Set<string>();

  for (const metric of ABSOLUTE_METRICS) {
    const workloads = mapping.metrics[metric];
    if (workloads === undefined) continue;
    for (const w of workloads) {
      mappedWorkloads.add(w);
      const selected = candidateByWorkload.get(w);
      if (selected === undefined || selected.n_rows <= 0) {
        missing.push({ side: "candidate", metric, workload: w });
      }
    }
  }

  // Step 4: W = distinct mapped workloads in PROMOTION_METRICS order then mapping order.
  const W = Array.from(mappedWorkloads).sort((a, b) => {
    const aIndex = ABSOLUTE_METRICS.findIndex(
      (metric) => mapping.metrics[metric]?.includes(a) ?? false,
    );
    const bIndex = ABSOLUTE_METRICS.findIndex(
      (metric) => mapping.metrics[metric]?.includes(b) ?? false,
    );
    if (aIndex !== bIndex) return aIndex - bIndex;
    // Within the same metric, preserve mapping order (first occurrence).
    const aMetric = ABSOLUTE_METRICS.find(
      (metric) => mapping.metrics[metric]?.includes(a) ?? false,
    );
    const bMetric = ABSOLUTE_METRICS.find(
      (metric) => mapping.metrics[metric]?.includes(b) ?? false,
    );
    if (aMetric !== undefined && bMetric !== undefined && aMetric === bMetric) {
      const aMap = mapping.metrics[aMetric];
      const bMap = mapping.metrics[bMetric];
      return (aMap?.indexOf(a) ?? 0) - (bMap?.indexOf(b) ?? 0);
    }
    return 0;
  });

  // Step 5 (baseline): Collect baseline missing entries for workloads in W that
  // are also in the candidate pool (have a candidateByWorkload entry). This
  // avoids reporting baseline missing for workloads that are candidate missing.
  const baselineMissing: MissingCell[] = [];
  if (baseline !== undefined) {
    const { model: baselineModel, runId: baselineRunId } = baseline;
    const baselinePool = cells.filter(
      (c) => c.model_name === baselineModel && c.run_id === baselineRunId,
    );
    const baselineByWorkload = new Map<string, CellRow>();
    for (const c of baselinePool) {
      const existing = baselineByWorkload.get(c.workload_name);
      if (
        existing === undefined ||
        c.finished_at > existing.finished_at ||
        (c.finished_at === existing.finished_at && c.run_id > existing.run_id)
      ) {
        baselineByWorkload.set(c.workload_name, c);
      }
    }
    for (const w of W) {
      // Only report baseline missing for workloads that are in the candidate pool.
      if (!candidateByWorkload.has(w)) continue;
      const baselineCell = baselineByWorkload.get(w);
      if (baselineCell === undefined || baselineCell.n_rows <= 0) {
        baselineMissing.push({ side: "baseline", workload: w });
      }
    }
  }
  // Merge baseline missing entries (if any) into the candidate missing list.
  const allMissing: MissingCell[] = [...missing, ...baselineMissing];

  // Step 3b: Any missing (candidate or baseline) → refuse.
  if (allMissing.length > 0) {
    return { ok: false, reason: "missing-cells", missing: allMissing };
  }

  // Step 6: Compute each mapped metric as n_rows-weighted mean.
  const evidence: { evaluatedTasks: number } & Record<string, number> = { evaluatedTasks: 0 };

  for (const metric of ABSOLUTE_METRICS) {
    const workloads = mapping.metrics[metric];
    if (workloads === undefined) continue;
    let weightedSum = 0;
    let totalNRows = 0;
    for (const w of workloads) {
      const selected = candidateByWorkload.get(w);
      if (selected !== undefined) {
        weightedSum += selected.primary_metric_value * selected.n_rows;
        totalNRows += selected.n_rows;
      }
    }
    if (totalNRows > 0) {
      evidence[metric] = weightedSum / totalNRows;
    }
  }

  // Step 7: evaluatedTasks = Σ n_rows over distinct selected candidate cells.
  for (const c of candidateByWorkload.values()) {
    evidence.evaluatedTasks += c.n_rows;
  }

  // Step 8: Baseline processing (regression and improvement).
  if (baseline !== undefined) {
    const { model: baselineModel, runId: baselineRunId } = baseline;

    // Baseline pool: cells with model_name === baseline.model and run_id === baseline.runId.
    const baselinePool = cells.filter(
      (c) => c.model_name === baselineModel && c.run_id === baselineRunId,
    );

    // Select per workload as in step 2.
    const baselineByWorkload = new Map<string, CellRow>();
    for (const c of baselinePool) {
      const existing = baselineByWorkload.get(c.workload_name);
      if (
        existing === undefined ||
        c.finished_at > existing.finished_at ||
        (c.finished_at === existing.finished_at && c.run_id > existing.run_id)
      ) {
        baselineByWorkload.set(c.workload_name, c);
      }
    }

    // Check for baseline-is-candidate.
    const baselineIsCandidate: string[] = [];
    for (const w of W) {
      const candidateCell = candidateByWorkload.get(w);
      const baselineCell = baselineByWorkload.get(w);
      if (baselineCell !== undefined && baselineCell.n_rows > 0) {
        if (baselineCell.run_id === candidateCell?.run_id && baselineCell.model_name === model) {
          baselineIsCandidate.push(w);
        }
      }
    }

    // Baseline-is-candidate → refuse.
    if (baselineIsCandidate.length > 0) {
      return { ok: false, reason: "baseline-is-candidate", workloads: baselineIsCandidate };
    }

    // Step 8: Compute regression and improvement using compareMetric.
    let regressionCount = 0;
    let weightedDeltaSum = 0;
    let totalCandidateNRows = 0;

    for (const w of W) {
      const candidateCell = candidateByWorkload.get(w);
      const baselineCell = baselineByWorkload.get(w);
      if (candidateCell === undefined || baselineCell === undefined) continue;

      const baselineMv = { value: baselineCell.primary_metric_value, status: "ok" as const };
      const candidateMv = { value: candidateCell.primary_metric_value, status: "ok" as const };
      const cmp = compareMetric(baselineMv, candidateMv, { higherIsBetter: true });

      if (cmp.verdict === "regressed") {
        regressionCount++;
      }
      if (cmp.delta !== null) {
        weightedDeltaSum += cmp.delta * candidateCell.n_rows;
        totalCandidateNRows += candidateCell.n_rows;
      }
    }

    const wCount = W.length;
    if (wCount > 0) {
      evidence["regression"] = regressionCount / wCount;
    }
    if (totalCandidateNRows > 0) {
      evidence["improvement"] = weightedDeltaSum / totalCandidateNRows;
    }
  }

  // Step 9: evidenceRef — run_ids from the selected cells (one per workload).
  const selectedRunIds = [
    ...new Set([...candidateByWorkload.values()].map((c) => c.run_id)),
  ].sort();
  let evidenceRef = `matrix:${model}@${selectedRunIds.join(",")}`;
  if (baseline !== undefined) {
    evidenceRef += `;baseline=${baseline.model}@${baseline.runId}`;
  }
  (evidence as PromotionEvidence).evidenceRef = evidenceRef;

  // Step 10: Parse through the strict adapter.
  return { ok: true, evidence: parsePromotionEvidence(evidence) };
}
