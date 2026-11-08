import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  type CostGuardianConfig,
  CostGuardianConfigSchema,
  emptyCostGuardianConfig,
} from "../src/config.js";
import { type DailySnapshot, decideGuardianAction } from "../src/state.js";

function makeConfig(
  budget: CostGuardianConfig["budget"],
  thresholds: CostGuardianConfig["thresholds"] = {
    warn: 0.5,
    force_private: 0.8,
    deregister: 0.9,
  },
): CostGuardianConfig {
  return { ...emptyCostGuardianConfig(), budget, thresholds };
}

function dailySnapshot(cost: number): DailySnapshot {
  return {
    snapshot: {
      windowSince: "2026-01-01T00:00:00.000Z",
      windowUntil: "2026-01-02T00:00:00.000Z",
      totalEstimatedCostUsd: cost,
    },
  };
}

// --- (a) (b) threshold ties ---

describe("decideGuardianAction threshold ties", () => {
  test("equal thresholds 0.6/0.6/0.6 at 60 of 100 give tier deregister crossing 0.6", () => {
    const result = decideGuardianAction({
      config: makeConfig({ daily_usd: 100 }, { warn: 0.6, force_private: 0.6, deregister: 0.6 }),
      daily: dailySnapshot(60),
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(result.tier).toBe("deregister");
    expect(result.thresholdCrossed).toBe(0.6);
  });

  test("force_private equal to deregister at 80 of 100 gives tier deregister crossing 0.8", () => {
    const result = decideGuardianAction({
      config: makeConfig({ daily_usd: 100 }, { warn: 0.5, force_private: 0.8, deregister: 0.8 }),
      daily: dailySnapshot(80),
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(result.tier).toBe("deregister");
    expect(result.thresholdCrossed).toBe(0.8);
  });
});

// --- (c) negative spend ---

describe("decideGuardianAction negative spend", () => {
  test("negative daily cost reports raw dailyUsd -50 and the raw cost in reason, with dailyFraction 0", () => {
    const result = decideGuardianAction({
      config: makeConfig({ daily_usd: 100 }),
      daily: dailySnapshot(-50),
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(result.dailyUsd).toBe(-50);
    expect(result.dailyFraction).toBe(0);
    expect(result.reason).toBe("daily spend $-50.0000 of $100.00 budget = 0.0%");
  });
});

// --- (d) (e) (f) (g) (h) config schema parsing ---

describe("CostGuardianConfigSchema flag and denylist parsing", () => {
  test("auto_deregister true parses to true", () => {
    expect(CostGuardianConfigSchema.parse({ auto_deregister: true }).auto_deregister).toBe(true);
  });

  test("string 'true' for auto_deregister throws ZodError", () => {
    expect(() => CostGuardianConfigSchema.parse({ auto_deregister: "true" })).toThrow(z.ZodError);
  });

  test("numeric 1 for auto_force_private throws ZodError", () => {
    expect(() => CostGuardianConfigSchema.parse({ auto_force_private: 1 })).toThrow(z.ZodError);
  });

  test("explicit empty protectedProviders stays empty", () => {
    expect(CostGuardianConfigSchema.parse({ protectedProviders: [] }).protectedProviders).toEqual(
      [],
    );
  });

  test("non-string protectedProviders entry throws ZodError", () => {
    expect(() => CostGuardianConfigSchema.parse({ protectedProviders: [1] })).toThrow(z.ZodError);
  });
});
