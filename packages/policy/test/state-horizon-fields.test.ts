import { describe, expect, test } from "bun:test";

import { type CostGuardianConfig, emptyCostGuardianConfig } from "../src/config.js";
import { type DailySnapshot, decideGuardianAction, type GuardianDecision } from "../src/state.js";

function config(budget: CostGuardianConfig["budget"]): CostGuardianConfig {
  return {
    ...emptyCostGuardianConfig(),
    budget,
    thresholds: { warn: 0.5, force_private: 0.8, deregister: 0.9 },
  };
}

function snapshot(opts: { cost?: number; topProviderKey?: string }): DailySnapshot {
  return {
    snapshot: {
      windowSince: "2026-01-01T00:00:00.000Z",
      windowUntil: "2026-01-02T00:00:00.000Z",
      ...(opts.cost !== undefined ? { totalEstimatedCostUsd: opts.cost } : {}),
      ...(opts.topProviderKey !== undefined ? { topProvider: { key: opts.topProviderKey } } : {}),
    },
  };
}

function decide(input: {
  budget: CostGuardianConfig["budget"];
  daily?: { cost?: number; topProviderKey?: string };
  weekly?: { cost?: number; topProviderKey?: string };
}): ReturnType<typeof decideGuardianAction> {
  return decideGuardianAction({
    config: config(input.budget),
    ...(input.daily !== undefined ? { daily: snapshot(input.daily) } : {}),
    ...(input.weekly !== undefined ? { weekly: snapshot(input.weekly) } : {}),
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
}

describe("GuardianDecision per-horizon spend fields", () => {
  test("daily-only budget records weekly spend without a weekly fraction or tier influence", () => {
    const result = decide({
      budget: { daily_usd: 100 },
      daily: { cost: 10 },
      weekly: { cost: 1000, topProviderKey: "provider-weekly" },
    });

    const expected: GuardianDecision = {
      ts: "2026-01-02T03:04:05.000Z",
      tier: "noop",
      reason: "daily spend $10.0000 of $100.00 budget = 10.0%",
      thresholdCrossed: 0,
      deregisterTarget: null,
      dailyFraction: 0.1,
      dailyUsd: 10,
      weeklyUsd: 1000,
    };
    expect(result).toEqual(expected);
  });

  test("weekly-only budget records daily spend without a daily fraction and takes the weekly deregister target", () => {
    const result = decide({
      budget: { weekly_usd: 100 },
      daily: { cost: 500, topProviderKey: "provider-daily" },
      weekly: { cost: 90, topProviderKey: "provider-weekly" },
    });

    const expected: GuardianDecision = {
      ts: "2026-01-02T03:04:05.000Z",
      tier: "deregister",
      reason: "weekly spend $90.0000 of $100.00 budget = 90.0%",
      thresholdCrossed: 0.9,
      deregisterTarget: "provider-weekly",
      weeklyFraction: 0.9,
      dailyUsd: 500,
      weeklyUsd: 90,
    };
    expect(result).toEqual(expected);
  });

  test("both budgets attach both fractions and both USD figures", () => {
    const result = decide({
      budget: { daily_usd: 10, weekly_usd: 60 },
      daily: { cost: 6 },
      weekly: { cost: 12 },
    });

    const expected: GuardianDecision = {
      ts: "2026-01-02T03:04:05.000Z",
      tier: "warn",
      reason:
        "daily spend $6.0000 of $10.00 budget = 60.0%; weekly spend $12.0000 of $60.00 budget = 20.0%",
      thresholdCrossed: 0.5,
      deregisterTarget: null,
      dailyFraction: 0.6,
      weeklyFraction: 0.2,
      dailyUsd: 6,
      weeklyUsd: 12,
    };
    expect(result).toEqual(expected);
  });

  test("reason rounds cost to 4 places, budget to 2 and percent to 1", () => {
    const result = decide({
      budget: { daily_usd: 7.5 },
      daily: { cost: 1.23456789 },
    });

    expect(result.reason).toBe("daily spend $1.2346 of $7.50 budget = 16.5%");
    expect(result.tier).toBe("noop");
  });
});
