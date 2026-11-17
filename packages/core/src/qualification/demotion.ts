// Evidence-based demotion proposals for the entry path into `degraded`
// (frozename/llamactl#518 routing (b)). Pure decision logic over the same
// evidence and overrides the promotion ladder uses, gated by an optional
// `demotion` floor block — no IO, no clock, no shipped defaults.

import type { PromotionTarget } from "./stages.js";

import {
  type DemotionThresholds,
  PROMOTION_METRICS,
  type PromotionDecision,
  type PromotionEvidence,
  type PromotionMetric,
  type PromotionPolicyInput,
  PromotionPolicySchema,
  type PromotionProposal,
  proposePromotion,
  type ProposePromotionInput,
} from "./promotion.js";

export interface DemotionProposal {
  rel: string;
  from: "candidate" | "validated" | "production";
  to: "degraded";
  breached: PromotionMetric[];
  metrics: Partial<Record<PromotionMetric, number>>;
  evidenceRef?: string;
}

export type DemotionRefusalReason =
  | "frozen"
  | "pinned"
  | "already-degraded"
  | "not-demotable"
  | "no-thresholds"
  | "insufficient-evidence"
  | "within-tolerance";

export type DemotionDecision =
  | { kind: "demotion"; proposal: DemotionProposal }
  | { kind: "none"; reason: DemotionRefusalReason };

export type ProposeDemotionInput = Omit<ProposePromotionInput, "health">;

interface FloorBinding {
  readonly metric: PromotionMetric;
  readonly floorKey: keyof DemotionThresholds;
  readonly breaches: (value: number, floor: number) => boolean;
}

interface Reading {
  readonly metric: PromotionMetric;
  readonly floor: number;
  readonly value: number;
  readonly breaches: (value: number, floor: number) => boolean;
}

// One lookup entry per configurable floor, kept in PROMOTION_METRICS order
// so `breached` reports in that order without a sort. The table drives the
// comparison, which keeps the decision branch-light for strict-boolean lint.
const FLOOR_TABLE: readonly FloorBinding[] = PROMOTION_METRICS.map((metric) => {
  const below = (value: number, floor: number): boolean => value < floor;
  switch (metric) {
    case "regression":
      return {
        metric,
        floorKey: "maxRegression",
        breaches: (value: number, floor: number) => value > floor,
      };
    case "improvement":
      return { metric, floorKey: "minImprovement", breaches: below };
    case "firstAttemptSuccess":
      return { metric, floorKey: "minFirstAttemptSuccess", breaches: below };
    case "repairSuccess":
      return { metric, floorKey: "minRepairSuccess", breaches: below };
    case "toolCallCorrectness":
      return { metric, floorKey: "minToolCallCorrectness", breaches: below };
    case "structuredOutputValidity":
      return { metric, floorKey: "minStructuredOutputValidity", breaches: below };
    case "memoryStability":
      return { metric, floorKey: "minMemoryStability", breaches: below };
    case "runtimeReliability":
      return { metric, floorKey: "minRuntimeReliability", breaches: below };
  }
});

function none(reason: DemotionRefusalReason): DemotionDecision {
  return { kind: "none", reason };
}

type FloorReadings = Reading[] | "no-thresholds" | "insufficient-evidence";

function configuredReadings(
  policy: PromotionPolicyInput,
  evidence: PromotionEvidence,
): FloorReadings {
  const demotion = PromotionPolicySchema.parse(policy).demotion;
  if (demotion === undefined) return "no-thresholds";
  const readings: Reading[] = [];
  for (const binding of FLOOR_TABLE) {
    const floor = demotion[binding.floorKey];
    if (floor === undefined) continue;
    readings.push({
      metric: binding.metric,
      floor,
      value: evidence[binding.metric] ?? Number.NaN,
      breaches: binding.breaches,
    });
  }
  if (readings.length === 0) return "no-thresholds";
  if (evidence.evaluatedTasks < demotion.minEvaluatedTasks) return "insufficient-evidence";
  if (readings.some((reading) => !Number.isFinite(reading.value))) return "insufficient-evidence";
  return readings;
}

/**
 * First matching check wins: freeze, pin, a declared `degraded` stage
 * (already demoted), a declared `experimental` stage (never reached a
 * demotable rung), a missing or floor-less `demotion` block, then evidence
 * sufficiency, then per-metric breach. A breach is strict: value past
 * `maxRegression`, or value below a min floor.
 */
export function proposeDemotion(input: ProposeDemotionInput): DemotionDecision {
  const { rel, declared, evidence, policy, overrides } = input;
  if (overrides?.freeze !== undefined) return none("frozen");
  if (overrides?.pin !== undefined) return none("pinned");
  if (declared === "degraded") return none("already-degraded");
  if (declared === "experimental") return none("not-demotable");
  const readings = configuredReadings(policy, evidence);
  if (readings === "no-thresholds") return none("no-thresholds");
  if (readings === "insufficient-evidence") return none("insufficient-evidence");
  const breached = readings
    .filter((reading) => reading.breaches(reading.value, reading.floor))
    .map((reading) => reading.metric);
  if (breached.length === 0) return none("within-tolerance");
  const metrics: Partial<Record<PromotionMetric, number>> = {};
  for (const reading of readings) {
    metrics[reading.metric] = reading.value;
  }
  return {
    kind: "demotion",
    proposal: {
      rel,
      from: declared,
      to: "degraded",
      breached,
      metrics,
      ...(evidence.evidenceRef === undefined ? {} : { evidenceRef: evidence.evidenceRef }),
    },
  };
}

export type QualificationDecision =
  | { kind: "demotion"; proposal: DemotionProposal }
  | PromotionDecision;

/**
 * Run the demotion path first so a demotable stage past a floor reaches
 * `degraded` instead of climbing a rung; otherwise defer to the untouched
 * promotion decision.
 */
export function evaluateQualification(input: ProposePromotionInput): QualificationDecision {
  const demotion = proposeDemotion(input);
  if (demotion.kind === "demotion") return demotion;
  return proposePromotion(input);
}

export interface ApplyQualificationOptions {
  policy: PromotionPolicyInput;
  apply?: (proposal: PromotionProposal | DemotionProposal) => void;
}

export type ApplyQualificationResult =
  | { status: "skipped" }
  | { status: "proposed" }
  | { status: "applied"; to: PromotionTarget | "degraded" };

/**
 * Gate either decision kind through the parsed policy's `autoApply`, the
 * single source of truth, defaulting to false. A `none` decision is
 * skipped; `autoApply` without an injected writer writes nothing and stays
 * `proposed`. `health` remains the runtime overlay in `effectiveStage` and
 * never triggers a persisted demotion here.
 */
export function applyQualification(
  decision: QualificationDecision | DemotionDecision,
  options: ApplyQualificationOptions,
): ApplyQualificationResult {
  if (decision.kind === "none") return { status: "skipped" };
  const { autoApply } = PromotionPolicySchema.parse(options.policy);
  if (!autoApply || options.apply === undefined) return { status: "proposed" };
  options.apply(decision.proposal);
  return { status: "applied", to: decision.proposal.to };
}
