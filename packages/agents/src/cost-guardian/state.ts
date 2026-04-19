import type { CostGuardianConfig } from './config.js';

/**
 * Pure state machine. Given a cost snapshot + a budget + thresholds,
 * decides what the guardian should do on this tick.
 *
 * Tier ordering:
 *   noop  → spend well under budget, nothing to say.
 *   warn  → spend crossed `thresholds.warn * budget`.
 *   force_private → crossed `thresholds.force_private * budget`.
 *   deregister    → crossed `thresholds.deregister * budget`.
 *
 * Any higher tier implies lower tiers — a deregister-level tick also
 * merits a warn log — but the emitted `tier` is always the highest
 * crossed threshold, and the actionable surface (webhook call,
 * embersynth flip, sirius dry-run) lives in follow-up slices that
 * consume this intent.
 *
 * Budget resolution: when both `daily_usd` and `weekly_usd` are set,
 * the guardian compares against the stricter *fraction* of each (e.g.
 * 6 USD of a 10 USD daily cap is 60%; 6 USD of a 60 USD weekly cap
 * is 10% — daily wins, tier = warn). When only one is set, we use
 * that. When neither is set, tier is always `noop`.
 */

export type CostGuardianTier = 'noop' | 'warn' | 'force_private' | 'deregister';

export interface CostSnapshotSubset {
  /** Rolling-window total cost in USD — `undefined` when no record
   *  in the window matched pricing. */
  totalEstimatedCostUsd?: number;
  /** Window bounds, passed through to the decision for logging. */
  windowSince: string;
  windowUntil: string;
  /** Highest-spending provider for the window, for the tier-3
   *  deregister dry-run target. `undefined` when nothing cost
   *  anything (or catalog was empty). */
  topProvider?: { key: string; estimatedCostUsd?: number };
}

export interface DailySnapshot {
  snapshot: CostSnapshotSubset;
}

export interface WeeklySnapshot {
  snapshot: CostSnapshotSubset;
}

export interface GuardianDecisionInput {
  daily?: DailySnapshot;
  weekly?: WeeklySnapshot;
  config: CostGuardianConfig;
  /** When provided, overrides Date.now()-derived ts on the decision
   *  (tests pass a frozen clock). */
  now?: () => Date;
}

export interface GuardianDecision {
  ts: string;
  tier: CostGuardianTier;
  /** Reason string suitable for a webhook payload / journal entry. */
  reason: string;
  /** Fraction of budget consumed, per horizon. Either or both can be
   *  absent when the horizon's budget isn't configured or the
   *  snapshot lacked pricing. */
  dailyFraction?: number;
  weeklyFraction?: number;
  /** Absolute spend per horizon for readability. */
  dailyUsd?: number;
  weeklyUsd?: number;
  /** Threshold that drove the decision; 0 when tier=noop. */
  thresholdCrossed: number;
  /** Optional: the provider the guardian would dry-run deregister at
   *  tier-3. `null` when tier<deregister or no top spender
   *  identified. */
  deregisterTarget: string | null;
}

function tierForFraction(
  fraction: number | undefined,
  thresholds: CostGuardianConfig['thresholds'],
): { tier: CostGuardianTier; crossed: number } {
  if (fraction === undefined || !Number.isFinite(fraction)) {
    return { tier: 'noop', crossed: 0 };
  }
  if (fraction >= thresholds.deregister) return { tier: 'deregister', crossed: thresholds.deregister };
  if (fraction >= thresholds.force_private) return { tier: 'force_private', crossed: thresholds.force_private };
  if (fraction >= thresholds.warn) return { tier: 'warn', crossed: thresholds.warn };
  return { tier: 'noop', crossed: 0 };
}

const tierRank: Record<CostGuardianTier, number> = {
  noop: 0,
  warn: 1,
  force_private: 2,
  deregister: 3,
};

export function decideGuardianAction(
  input: GuardianDecisionInput,
): GuardianDecision {
  const now = input.now ? input.now() : new Date();
  const ts = now.toISOString();
  const { config, daily, weekly } = input;

  const dailyCost = daily?.snapshot.totalEstimatedCostUsd;
  const weeklyCost = weekly?.snapshot.totalEstimatedCostUsd;
  const dailyBudget = config.budget.daily_usd;
  const weeklyBudget = config.budget.weekly_usd;

  const dailyFraction =
    dailyCost !== undefined && dailyBudget !== undefined && dailyBudget > 0
      ? dailyCost / dailyBudget
      : undefined;
  const weeklyFraction =
    weeklyCost !== undefined && weeklyBudget !== undefined && weeklyBudget > 0
      ? weeklyCost / weeklyBudget
      : undefined;

  const dailyTier = tierForFraction(dailyFraction, config.thresholds);
  const weeklyTier = tierForFraction(weeklyFraction, config.thresholds);

  // Stricter of the two wins.
  const winning =
    tierRank[dailyTier.tier] >= tierRank[weeklyTier.tier] ? dailyTier : weeklyTier;

  let reasonParts: string[] = [];
  if (dailyFraction !== undefined) {
    reasonParts.push(
      `daily spend $${(dailyCost ?? 0).toFixed(4)} of $${(dailyBudget ?? 0).toFixed(2)} budget = ${(dailyFraction * 100).toFixed(1)}%`,
    );
  }
  if (weeklyFraction !== undefined) {
    reasonParts.push(
      `weekly spend $${(weeklyCost ?? 0).toFixed(4)} of $${(weeklyBudget ?? 0).toFixed(2)} budget = ${(weeklyFraction * 100).toFixed(1)}%`,
    );
  }
  if (reasonParts.length === 0) {
    reasonParts = ['no budget configured or no pricing data — nothing to evaluate'];
  }

  const deregisterTarget =
    winning.tier === 'deregister'
      ? (daily?.snapshot.topProvider?.key ??
          weekly?.snapshot.topProvider?.key ??
          null)
      : null;

  const decision: GuardianDecision = {
    ts,
    tier: winning.tier,
    reason: reasonParts.join('; '),
    thresholdCrossed: winning.crossed,
    deregisterTarget,
  };
  if (dailyFraction !== undefined) decision.dailyFraction = dailyFraction;
  if (weeklyFraction !== undefined) decision.weeklyFraction = weeklyFraction;
  if (dailyCost !== undefined) decision.dailyUsd = dailyCost;
  if (weeklyCost !== undefined) decision.weeklyUsd = weeklyCost;
  return decision;
}
