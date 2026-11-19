// Evidence-based promotion proposals for the qualification lifecycle
// (frozename/llamactl#518). Pure decision logic over the ladder in
// stages.ts (stage vocabulary: QUALIFICATION_STAGES in schemas.ts) and
// caller-configured thresholds — no defaults are shipped, no IO, no clock.

import { z } from "zod";

import type { QualificationOverride } from "./overrides.js";

import {
  type HealthSignal,
  nextStage,
  type PromotionTarget,
  type QualificationStage,
} from "./stages.js";

/** Metrics an evidence aggregate must carry, in report order. */
export const PROMOTION_METRICS = [
  "firstAttemptSuccess",
  "repairSuccess",
  "toolCallCorrectness",
  "structuredOutputValidity",
  "regression",
  "improvement",
  "memoryStability",
  "runtimeReliability",
] as const;

export type PromotionMetric = (typeof PROMOTION_METRICS)[number];

const ratio = z.number().min(0).max(1);
const signedRatio = z.number().min(-1).max(1);

export const PromotionThresholdsSchema = z
  .object({
    minEvaluatedTasks: z.number().int().nonnegative(),
    minFirstAttemptSuccess: ratio,
    minRepairSuccess: ratio,
    minToolCallCorrectness: ratio,
    minStructuredOutputValidity: ratio,
    maxRegression: ratio,
    minImprovement: signedRatio,
    minMemoryStability: ratio,
    minRuntimeReliability: ratio,
  })
  .strict();
export type PromotionThresholds = z.infer<typeof PromotionThresholdsSchema>;

/**
 * Optional demotion floors for the entry path into `degraded`
 * (frozename/llamactl#518 routing (b)). Every metric floor is optional so
 * a policy checks only the floors it configures; `minEvaluatedTasks` is
 * the shared evidence gate, never itself a floor.
 */
export const DemotionThresholdsSchema = z
  .object({
    minEvaluatedTasks: z.number().int().nonnegative(),
    maxRegression: ratio.optional(),
    minFirstAttemptSuccess: ratio.optional(),
    minRepairSuccess: ratio.optional(),
    minToolCallCorrectness: ratio.optional(),
    minStructuredOutputValidity: ratio.optional(),
    minImprovement: signedRatio.optional(),
    minMemoryStability: ratio.optional(),
    minRuntimeReliability: ratio.optional(),
  })
  .strict();
export type DemotionThresholds = z.infer<typeof DemotionThresholdsSchema>;

/**
 * Strict at the top level (frozename/llamactl#518 review): a typo such as
 * `autoapply` is refused rather than silently defaulting `autoApply` off.
 */
export const PromotionPolicySchema = z
  .object({
    thresholds: z.object({
      candidate: PromotionThresholdsSchema.optional(),
      validated: PromotionThresholdsSchema.optional(),
      production: PromotionThresholdsSchema.optional(),
    }),
    autoApply: z.boolean().default(false),
    demotion: DemotionThresholdsSchema.optional(),
  })
  .strict();
export type PromotionPolicy = z.infer<typeof PromotionPolicySchema>;
export type PromotionPolicyInput = z.input<typeof PromotionPolicySchema>;

/**
 * Core-defined aggregate of eval rows plus penumbra agent_performance
 * outcomes. Core cannot import packages/eval, so the adapters that
 * produce it live there.
 */
export type PromotionEvidence = {
  evaluatedTasks: number;
  evidenceRef?: string;
} & Partial<Record<PromotionMetric, number>>;

/**
 * Strict validation boundary for an evidence aggregate (frozename/llamactl#518
 * routing quality signals). Plain `z.number()` already rejects NaN and
 * Infinity under zod v4, so no `.finite()` is used (deprecated). Unknown
 * keys are refused by `.strict()`. Metrics carry the same bounds as the
 * policy thresholds they are compared against: ratios in [0, 1] and
 * `improvement` in [-1, 1], so percent-scaled evidence is refused.
 */
export const PromotionEvidenceSchema = z
  .object({
    evaluatedTasks: z.number().int().nonnegative(),
    evidenceRef: z.string().min(1).optional(),
    firstAttemptSuccess: ratio.optional(),
    repairSuccess: ratio.optional(),
    toolCallCorrectness: ratio.optional(),
    structuredOutputValidity: ratio.optional(),
    regression: ratio.optional(),
    improvement: signedRatio.optional(),
    memoryStability: ratio.optional(),
    runtimeReliability: ratio.optional(),
  })
  .strict();

/**
 * Parse and validate an unknown evidence input, stripping undefined optional
 * keys so the result is assignable under `exactOptionalPropertyTypes`.
 */
export function parsePromotionEvidence(input: unknown): PromotionEvidence {
  const parsed = PromotionEvidenceSchema.parse(input);
  const evidence: PromotionEvidence = { evaluatedTasks: parsed.evaluatedTasks };
  if (parsed.evidenceRef !== undefined) evidence.evidenceRef = parsed.evidenceRef;
  for (const metric of PROMOTION_METRICS) {
    const value = parsed[metric];
    if (value !== undefined) evidence[metric] = value;
  }
  return evidence;
}

export interface PromotionProposal {
  rel: string;
  from: QualificationStage;
  to: PromotionTarget;
  evidenceRef?: string;
  metrics: Record<PromotionMetric, number>;
}

export type PromotionRefusalReason =
  | "frozen"
  | "pinned"
  | "degraded"
  | "terminal-stage"
  | "no-thresholds"
  | "insufficient-evidence";

export type PromotionDecision =
  | { kind: "proposal"; proposal: PromotionProposal }
  | { kind: "none"; reason: PromotionRefusalReason }
  | { kind: "none"; reason: "below-threshold"; failed: PromotionMetric[] };

export interface ProposePromotionInput {
  rel: string;
  declared: QualificationStage;
  evidence: PromotionEvidence;
  policy: PromotionPolicyInput;
  overrides?: { pin?: QualificationOverride; freeze?: QualificationOverride };
  health?: HealthSignal;
}

function metricOf(evidence: PromotionEvidence, metric: PromotionMetric): number {
  return evidence[metric] ?? Number.NaN;
}

function evidenceMetrics(evidence: PromotionEvidence): Record<PromotionMetric, number> {
  return {
    firstAttemptSuccess: metricOf(evidence, "firstAttemptSuccess"),
    repairSuccess: metricOf(evidence, "repairSuccess"),
    toolCallCorrectness: metricOf(evidence, "toolCallCorrectness"),
    structuredOutputValidity: metricOf(evidence, "structuredOutputValidity"),
    regression: metricOf(evidence, "regression"),
    improvement: metricOf(evidence, "improvement"),
    memoryStability: metricOf(evidence, "memoryStability"),
    runtimeReliability: metricOf(evidence, "runtimeReliability"),
  };
}

function failsThreshold(
  metric: PromotionMetric,
  value: number,
  thresholds: PromotionThresholds,
): boolean {
  switch (metric) {
    case "regression":
      return value > thresholds.maxRegression;
    case "improvement":
      return value < thresholds.minImprovement;
    case "firstAttemptSuccess":
      return value < thresholds.minFirstAttemptSuccess;
    case "repairSuccess":
      return value < thresholds.minRepairSuccess;
    case "toolCallCorrectness":
      return value < thresholds.minToolCallCorrectness;
    case "structuredOutputValidity":
      return value < thresholds.minStructuredOutputValidity;
    case "memoryStability":
      return value < thresholds.minMemoryStability;
    case "runtimeReliability":
      return value < thresholds.minRuntimeReliability;
  }
}

/**
 * First matching check wins: freeze, then pin, then health/declared
 * degradation, then the terminal rung, then threshold availability,
 * then evidence sufficiency, then per-metric comparison. A proposal
 * moves exactly one rung up the ladder.
 */
export function proposePromotion(input: ProposePromotionInput): PromotionDecision {
  const { rel, declared, evidence, policy, overrides, health } = input;
  if (overrides?.freeze !== undefined) return { kind: "none", reason: "frozen" };
  if (overrides?.pin !== undefined) return { kind: "none", reason: "pinned" };
  if (health?.ok === false || declared === "degraded") {
    return { kind: "none", reason: "degraded" };
  }
  const to = nextStage(declared);
  if (to === null) return { kind: "none", reason: "terminal-stage" };
  const thresholds = policy.thresholds[to];
  if (thresholds === undefined) return { kind: "none", reason: "no-thresholds" };
  const complete = PROMOTION_METRICS.every((metric) => Number.isFinite(metricOf(evidence, metric)));
  if (evidence.evaluatedTasks < thresholds.minEvaluatedTasks || !complete) {
    return { kind: "none", reason: "insufficient-evidence" };
  }
  const failed = PROMOTION_METRICS.filter((metric) =>
    failsThreshold(metric, metricOf(evidence, metric), thresholds),
  );
  if (failed.length > 0) return { kind: "none", reason: "below-threshold", failed };
  return {
    kind: "proposal",
    proposal: {
      rel,
      from: declared,
      to,
      metrics: evidenceMetrics(evidence),
      ...(evidence.evidenceRef === undefined ? {} : { evidenceRef: evidence.evidenceRef }),
    },
  };
}

export interface ApplyPromotionOptions {
  policy: PromotionPolicyInput;
  apply?: (proposal: PromotionProposal) => void;
}

export type ApplyPromotionResult =
  | { status: "skipped" }
  | { status: "proposed" }
  | { status: "applied"; to: PromotionTarget };

/**
 * Gate a decision through the parsed policy's autoApply, the single
 * source of truth (frozename/llamactl#518 review). The catalog-row
 * writer is injected; the real one is built in E-14. autoApply without
 * a writer writes nothing, so the result stays `proposed` rather than
 * claiming an apply that never happened.
 */
export function applyPromotion(
  decision: PromotionDecision,
  options: ApplyPromotionOptions,
): ApplyPromotionResult {
  if (decision.kind === "none") return { status: "skipped" };
  const { autoApply } = PromotionPolicySchema.parse(options.policy);
  if (!autoApply || options.apply === undefined) return { status: "proposed" };
  options.apply(decision.proposal);
  return { status: "applied", to: decision.proposal.to };
}
