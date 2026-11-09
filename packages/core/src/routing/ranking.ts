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
 */
import type { RouteAdvertisementV1, RouteCandidate } from "./catalog.js";

export interface RankingSignals {
  /** deploymentIds currently resident on their owner node; absent = unknown. */
  resident?: ReadonlySet<string>;
  expectedLoadMs?: (ad: RouteAdvertisementV1) => number | undefined;
  drainMs?: (ad: RouteAdvertisementV1) => number | undefined;
  cooldownUntil?: (ad: RouteAdvertisementV1) => number | undefined;
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

function drainTier(ad: RouteAdvertisementV1): number {
  return ad.draining ? 2 : 0;
}

function degradedTier(ad: RouteAdvertisementV1): number {
  return ad.qualification?.stage === "degraded" ? 1 : 0;
}

function tierOf(ad: RouteAdvertisementV1): number {
  return drainTier(ad) + degradedTier(ad);
}

function qualityPointsOf(ad: RouteAdvertisementV1): number {
  const stage = ad.qualification?.stage;
  if (stage === undefined) return UNSTAGED_QUALITY_POINTS;
  return QUALITY_POINTS[stage] ?? 0;
}

function isResident(ad: RouteAdvertisementV1, signals: RankingSignals): boolean {
  return signals.resident?.has(ad.deploymentId) ?? false;
}

function loadCostMs(
  ad: RouteAdvertisementV1,
  signals: RankingSignals,
  weights: RankingWeights,
): number {
  if (signals.resident === undefined || isResident(ad, signals)) return 0;
  return signals.expectedLoadMs?.(ad) ?? weights.defaultExpectedLoadMs;
}

function drainCostMs(ad: RouteAdvertisementV1, signals: RankingSignals): number {
  if (signals.resident === undefined || isResident(ad, signals)) return 0;
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
): number {
  const load = loadCostMs(ad, signals, weights);
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

export function rankRouteCandidates(
  candidates: readonly RouteCandidate[],
  opts: { now: number; signals?: RankingSignals; weights?: Partial<RankingWeights> },
): RankedCandidate[] {
  const weights: RankingWeights = { ...DEFAULT_RANKING_WEIGHTS, ...opts.weights };
  const signals: RankingSignals = opts.signals ?? {};
  const ranked: RankedCandidate[] = candidates.map(
    (candidate: RouteCandidate, index: number): RankedCandidate => {
      const ad = candidate.advertisement;
      const qualityPoints = qualityPointsOf(ad);
      const switchCost = switchCostMs(ad, opts.now, signals, weights);
      return {
        candidate,
        index,
        tier: tierOf(ad),
        qualityPoints,
        switchCostMs: switchCost,
        score: qualityPoints * weights.msPerQualityPoint - switchCost,
      };
    },
  );
  return ranked.toSorted(compareRanked);
}

export function pickRouteCandidate(
  candidates: readonly RouteCandidate[],
  opts: { now: number; signals?: RankingSignals; weights?: Partial<RankingWeights> },
): RouteCandidate | undefined {
  return rankRouteCandidates(candidates, opts).at(0)?.candidate;
}
