import type { CostGuardianConfig } from "./config.js";

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

export type CostGuardianTier = "noop" | "warn" | "force_private" | "deregister";

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
  thresholds: CostGuardianConfig["thresholds"],
): { tier: CostGuardianTier; crossed: number } {
  if (fraction === undefined || Number.isNaN(fraction)) {
    return { tier: "noop", crossed: 0 };
  }
  if (!Number.isFinite(fraction)) {
    // Positive infinity = unbounded overspend → fail closed at highest tier.
    return fraction > 0
      ? { tier: "deregister", crossed: thresholds.deregister }
      : { tier: "noop", crossed: 0 };
  }
  if (fraction >= thresholds.deregister)
    return { tier: "deregister", crossed: thresholds.deregister };
  if (fraction >= thresholds.force_private)
    return { tier: "force_private", crossed: thresholds.force_private };
  if (fraction >= thresholds.warn) return { tier: "warn", crossed: thresholds.warn };
  return { tier: "noop", crossed: 0 };
}

const tierRank: Record<CostGuardianTier, number> = {
  noop: 0,
  warn: 1,
  force_private: 2,
  deregister: 3,
};

function fractionOfBudget(
  cost: number | undefined,
  budget: number | undefined,
): number | undefined {
  if (cost === undefined || budget === undefined || budget <= 0) return undefined;
  const effectiveCost = cost < 0 ? 0 : cost;
  return effectiveCost / budget;
}

function horizonReason(
  label: "daily" | "weekly",
  cost: number | undefined,
  budget: number | undefined,
  fraction: number,
): string {
  return `${label} spend $${(cost ?? 0).toFixed(4)} of $${(budget ?? 0).toFixed(2)} budget = ${(fraction * 100).toFixed(1)}%`;
}

function buildReason(
  daily: { cost?: number; budget?: number; fraction?: number },
  weekly: { cost?: number; budget?: number; fraction?: number },
): string {
  const reasonParts: string[] = [];
  if (daily.fraction !== undefined) {
    reasonParts.push(horizonReason("daily", daily.cost, daily.budget, daily.fraction));
  }
  if (weekly.fraction !== undefined) {
    reasonParts.push(horizonReason("weekly", weekly.cost, weekly.budget, weekly.fraction));
  }
  if (reasonParts.length === 0) {
    return "no budget configured or no pricing data — nothing to evaluate";
  }
  return reasonParts.join("; ");
}

function attachSpendFields(
  decision: GuardianDecision,
  fields: {
    dailyFraction?: number;
    weeklyFraction?: number;
    dailyCost?: number;
    weeklyCost?: number;
  },
): void {
  if (fields.dailyFraction !== undefined) decision.dailyFraction = fields.dailyFraction;
  if (fields.weeklyFraction !== undefined) decision.weeklyFraction = fields.weeklyFraction;
  if (fields.dailyCost !== undefined) decision.dailyUsd = fields.dailyCost;
  if (fields.weeklyCost !== undefined) decision.weeklyUsd = fields.weeklyCost;
}

export function decideGuardianAction(input: GuardianDecisionInput): GuardianDecision {
  const now = input.now ? input.now() : new Date();
  const ts = now.toISOString();
  const { config, daily, weekly } = input;

  const dailyCost = daily?.snapshot.totalEstimatedCostUsd;
  const weeklyCost = weekly?.snapshot.totalEstimatedCostUsd;
  const dailyBudget = config.budget.daily_usd;
  const weeklyBudget = config.budget.weekly_usd;

  const dailyFraction = fractionOfBudget(dailyCost, dailyBudget);
  const weeklyFraction = fractionOfBudget(weeklyCost, weeklyBudget);

  const dailyTier = tierForFraction(dailyFraction, config.thresholds);
  const weeklyTier = tierForFraction(weeklyFraction, config.thresholds);

  // Stricter of the two wins. Track which horizon drove the decision so
  // deregisterTarget points at the right provider.
  const winnerIsDaily = tierRank[dailyTier.tier] >= tierRank[weeklyTier.tier];
  const winning = winnerIsDaily ? dailyTier : weeklyTier;
  const winningSnapshot = winnerIsDaily ? daily?.snapshot : weekly?.snapshot;
  const fallbackSnapshot = winnerIsDaily ? weekly?.snapshot : daily?.snapshot;

  const deregisterTarget =
    winning.tier === "deregister"
      ? (winningSnapshot?.topProvider?.key ?? fallbackSnapshot?.topProvider?.key ?? null)
      : null;

  const decision: GuardianDecision = {
    ts,
    tier: winning.tier,
    reason: buildReason(
      { cost: dailyCost, budget: dailyBudget, fraction: dailyFraction },
      { cost: weeklyCost, budget: weeklyBudget, fraction: weeklyFraction },
    ),
    thresholdCrossed: winning.crossed,
    deregisterTarget,
  };
  attachSpendFields(decision, { dailyFraction, weeklyFraction, dailyCost, weeklyCost });
  return decision;
}
