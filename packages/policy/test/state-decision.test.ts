import { describe, expect, test } from "bun:test";

import { type CostGuardianConfig, emptyCostGuardianConfig } from "../src/config.js";
import { type DailySnapshot, decideGuardianAction } from "../src/state.js";

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

describe("decideGuardianAction", () => {
  test("below warn: cost 49.99 of 100 -> noop", () => {
    const result = decide({ budget: { daily_usd: 100 }, daily: { cost: 49.99 } });
    expect(result.tier).toBe("noop");
    expect(result.thresholdCrossed).toBe(0);
  });

  test("exactly at warn: cost 50 of 100 -> warn", () => {
    const result = decide({ budget: { daily_usd: 100 }, daily: { cost: 50 } });
    expect(result.tier).toBe("warn");
    expect(result.thresholdCrossed).toBe(0.5);
  });

  test("exactly at force_private: cost 80 of 100 -> force_private", () => {
    const result = decide({ budget: { daily_usd: 100 }, daily: { cost: 80 } });
    expect(result.tier).toBe("force_private");
    expect(result.thresholdCrossed).toBe(0.8);
  });

  test("exactly at deregister: cost 90 of 100 -> deregister", () => {
    const result = decide({ budget: { daily_usd: 100 }, daily: { cost: 90 } });
    expect(result.tier).toBe("deregister");
    expect(result.thresholdCrossed).toBe(0.9);
  });

  test("stricter horizon wins: weekly 50 of 60 outranks daily 60 of 100", () => {
    const result = decide({
      budget: { daily_usd: 100, weekly_usd: 60 },
      daily: { cost: 60 },
      weekly: { cost: 50 },
    });
    expect(result.tier).toBe("force_private");
    expect(result.thresholdCrossed).toBe(0.8);
  });

  test("tie goes to daily: equal fractions pick the daily topProvider", () => {
    const result = decide({
      budget: { daily_usd: 100, weekly_usd: 100 },
      daily: { cost: 95, topProviderKey: "provider-daily" },
      weekly: { cost: 95, topProviderKey: "provider-weekly" },
    });
    expect(result.tier).toBe("deregister");
    expect(result.deregisterTarget).toBe("provider-daily");
  });

  test("deregisterTarget falls back to the losing horizon's topProvider", () => {
    const result = decide({
      budget: { daily_usd: 100, weekly_usd: 100 },
      daily: { cost: 95 },
      weekly: { cost: 10, topProviderKey: "provider-weekly" },
    });
    expect(result.tier).toBe("deregister");
    expect(result.deregisterTarget).toBe("provider-weekly");
  });

  test("deregisterTarget is null below deregister", () => {
    const result = decide({
      budget: { daily_usd: 100 },
      daily: { cost: 85, topProviderKey: "provider-daily" },
    });
    expect(result.tier).toBe("force_private");
    expect(result.deregisterTarget).toBeNull();
  });

  test("deregisterTarget is null at deregister when nothing has a topProvider", () => {
    const result = decide({ budget: { daily_usd: 100 }, daily: { cost: 95 } });
    expect(result.deregisterTarget).toBeNull();
  });

  test("no budget configured: noop with fallback reason, dailyUsd set, no dailyFraction", () => {
    const result = decide({ budget: {}, daily: { cost: 1000 } });
    expect(result.tier).toBe("noop");
    expect(result.reason).toBe("no budget configured or no pricing data — nothing to evaluate");
    expect(result.dailyUsd).toBe(1000);
    expect("dailyFraction" in result).toBe(false);
  });

  test("no pricing data: noop, neither dailyFraction nor dailyUsd present", () => {
    const result = decide({ budget: { daily_usd: 100 }, daily: {} });
    expect(result.tier).toBe("noop");
    expect("dailyFraction" in result).toBe(false);
    expect("dailyUsd" in result).toBe(false);
  });

  test("zero budget bypasses the schema: noop, no dailyFraction", () => {
    const result = decide({ budget: { daily_usd: 0 }, daily: { cost: 5 } });
    expect(result.tier).toBe("noop");
    expect("dailyFraction" in result).toBe(false);
  });

  test("reason joins daily and weekly segments", () => {
    const result = decide({
      budget: { daily_usd: 10, weekly_usd: 60 },
      daily: { cost: 6 },
      weekly: { cost: 6 },
    });
    expect(result.reason).toBe(
      "daily spend $6.0000 of $10.00 budget = 60.0%; weekly spend $6.0000 of $60.00 budget = 10.0%",
    );
  });

  test("weekly-only budget: warn with weekly reason, weeklyFraction and weeklyUsd", () => {
    const result = decide({ budget: { weekly_usd: 60 }, weekly: { cost: 30 } });
    expect(result.tier).toBe("warn");
    expect(result.reason).toBe("weekly spend $30.0000 of $60.00 budget = 50.0%");
    expect(result.weeklyFraction).toBe(0.5);
    expect(result.weeklyUsd).toBe(30);
  });

  test("ts comes from the injected clock", () => {
    const result = decide({ budget: { daily_usd: 100 }, daily: { cost: 10 } });
    expect(result.ts).toBe("2026-01-02T03:04:05.000Z");
  });
});
