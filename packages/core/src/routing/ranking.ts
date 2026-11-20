/**
 * Candidate ranking for the unified proxy (frozename/llamactl#518 (c)).
 * Orders an already-eligible candidate list by qualification stage against
 * switch cost (load + drain + cooldown); it never drops a candidate.
 *
 * Logical availability, operational availability and routing eligibility
 * stay distinct concerns: eligibility (experimental exclusion, capability
 * matching) happens upstream in the catalog; this module only orders what
 * it is handed.
 *
 * Intended divergence (#518): stages below production (validated, candidate)
 * now rank below unstaged peers on the unified path, because an unstaged
 * advertisement scores as production (3) while a declared lower stage scores
 * less. The legacy (flag-off) path ignores stages entirely.
 *
 * Part of #519: the ResidencyPolicy knobs residentPreference and
 * coldLoadPenaltyMs apply here too, resolved through opts.policy.
 * coldLoadPenaltyMs adds ms to a non-resident candidate's load cost when
 * residency is known; residentPreference adds quality points (multiplied by
 * msPerQualityPoint) to a resident candidate's score. Both are inert at 0
 * and while residency is unknown (signals.resident === undefined); the
 * defaults reproduce the #518 decisions and scores exactly. With
 * signals.residencyKnown, an ad outside it (a peer, under the shared proxy)
 * is neither charged nor rewarded; without it the resident set speaks for
 * every candidate.
 *
 * Part of #518: operational availability (lifecycle draining/unloading/
 * failed) orders candidates but never changes eligibility. The optional
 * signals.operationalState callback folds a node-local lifecycle state into
 * the drain/degraded tiers and zeroes a failed candidate's quality points
 * (the effectiveStage health overlay); without it scores and order stay
 * byte-identical.
 */
import type { RouteAdvertisementV1, RouteCandidate } from "./catalog.js";

import { type ResidencyPolicy, resolveResidencyPolicy } from "../residency/admission.js";

export type OperationalState = "draining" | "failed";

export interface RankingSignals {
  /** deploymentIds currently resident on their owner node; absent = unknown. */
  resident?: ReadonlySet<string>;
  /** whether `resident` speaks for this candidate; absent = it speaks for
   *  every candidate (the #518/#519 behaviour). A candidate outside it has
   *  unknown residency: no load or drain cost and no resident bonus. */
  residencyKnown?: (ad: RouteAdvertisementV1) => boolean;
  expectedLoadMs?: (ad: RouteAdvertisementV1) => number | undefined;
  drainMs?: (ad: RouteAdvertisementV1) => number | undefined;
  cooldownUntil?: (ad: RouteAdvertisementV1) => number | undefined;
  /** node-local lifecycle state of a candidate's workload; absent means
   *  unknown. It only orders candidates (drain/degraded tiers, quality
   *  overlay) and never changes eligibility. */
  operationalState?: (ad: RouteAdvertisementV1) => OperationalState | undefined;
}

export interface RankingWeights {
  msPerQualityPoint: number;
  defaultExpectedLoadMs: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  msPerQualityPoint: 30_000,
  defaultExpectedLoadMs: 60_000,
};

const QUALITY_POINTS: Record<string, number> = {
  candidate: 1,
  degraded: 0,
  experimental: 0,
  production: 3,
  validated: 2,
};

const UNSTAGED_QUALITY_POINTS = QUALITY_POINTS["production"] ?? 0;

function drainTier(ad: RouteAdvertisementV1, op: OperationalState | undefined): number {
  return ad.draining || op === "draining" ? 2 : 0;
}

function degradedTier(ad: RouteAdvertisementV1, op: OperationalState | undefined): number {
  return ad.qualification?.stage === "degraded" || op === "failed" ? 1 : 0;
}

function tierOf(ad: RouteAdvertisementV1, op: OperationalState | undefined): number {
  return drainTier(ad, op) + degradedTier(ad, op);
}

function qualityPointsOf(ad: RouteAdvertisementV1, op: OperationalState | undefined): number {
  if (op === "failed") return QUALITY_POINTS["degraded"] ?? 0;
  const stage = ad.qualification?.stage;
  if (stage === undefined) return UNSTAGED_QUALITY_POINTS;
  return QUALITY_POINTS[stage] ?? 0;
}

function isResident(ad: RouteAdvertisementV1, signals: RankingSignals): boolean {
  return signals.resident?.has(ad.deploymentId) ?? false;
}

function residencyKnownFor(ad: RouteAdvertisementV1, signals: RankingSignals): boolean {
  return signals.resident !== undefined && (signals.residencyKnown?.(ad) ?? true);
}

function loadCostMs(
  ad: RouteAdvertisementV1,
  signals: RankingSignals,
  weights: RankingWeights,
  policy: ResidencyPolicy,
): number {
  if (!residencyKnownFor(ad, signals) || isResident(ad, signals)) return 0;
  return (signals.expectedLoadMs?.(ad) ?? weights.defaultExpectedLoadMs) + policy.coldLoadPenaltyMs;
}

function drainCostMs(ad: RouteAdvertisementV1, signals: RankingSignals): number {
  if (!residencyKnownFor(ad, signals) || isResident(ad, signals)) return 0;
  return signals.drainMs?.(ad) ?? 0;
}

function cooldownCostMs(ad: RouteAdvertisementV1, now: number, signals: RankingSignals): number {
  const until = signals.cooldownUntil?.(ad);
  if (until === undefined) return 0;
  return Math.max(0, until - now);
}

function switchCostMs(
  ad: RouteAdvertisementV1,
  now: number,
  signals: RankingSignals,
  weights: RankingWeights,
  policy: ResidencyPolicy,
): number {
  const load = loadCostMs(ad, signals, weights, policy);
  const drain = drainCostMs(ad, signals);
  const cooldown = cooldownCostMs(ad, now, signals);
  return load + drain + cooldown;
}

export interface RankedCandidate {
  candidate: RouteCandidate;
  index: number;
  tier: number;
  qualityPoints: number;
  switchCostMs: number;
  score: number;
}

function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.score !== b.score) return b.score - a.score;
  return a.index - b.index;
}

export interface RankingOptions {
  now: number;
  signals?: RankingSignals;
  weights?: Partial<RankingWeights>;
  policy?: Partial<ResidencyPolicy> | null | undefined;
}

export function rankRouteCandidates(
  candidates: readonly RouteCandidate[],
  opts: RankingOptions,
): RankedCandidate[] {
  const weights: RankingWeights = { ...DEFAULT_RANKING_WEIGHTS, ...opts.weights };
  const signals: RankingSignals = opts.signals ?? {};
  const policy = resolveResidencyPolicy(opts.policy ?? null);
  const ranked: RankedCandidate[] = candidates.map(
    (candidate: RouteCandidate, index: number): RankedCandidate => {
      const ad = candidate.advertisement;
      const op = signals.operationalState?.(ad);
      const qualityPoints = qualityPointsOf(ad, op);
      const switchCost = switchCostMs(ad, opts.now, signals, weights, policy);
      const residentBonus =
        residencyKnownFor(ad, signals) && isResident(ad, signals)
          ? policy.residentPreference * weights.msPerQualityPoint
          : 0;
      return {
        candidate,
        index,
        tier: tierOf(ad, op),
        qualityPoints,
        switchCostMs: switchCost,
        score: qualityPoints * weights.msPerQualityPoint - switchCost + residentBonus,
      };
    },
  );
  return ranked.toSorted(compareRanked);
}

export function pickRouteCandidate(
  candidates: readonly RouteCandidate[],
  opts: RankingOptions,
): RouteCandidate | undefined {
  return rankRouteCandidates(candidates, opts).at(0)?.candidate;
}
