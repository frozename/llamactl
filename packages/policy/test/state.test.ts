import { describe, expect, test } from "bun:test";

import {
  type CostGuardianConfig,
  CostGuardianThresholdsSchema,
  emptyCostGuardianConfig,
} from "../src/config.js";
import { decideGuardianAction } from "../src/state.js";

function makeConfig(
  budgetOverride: { daily_usd?: number; weekly_usd?: number } = {},
): CostGuardianConfig {
  return {
    ...emptyCostGuardianConfig(),
    budget: budgetOverride,
    thresholds: { warn: 0.5, force_private: 0.8, deregister: 0.9 },
  };
}

describe("fix 1: zero thresholds rejected by schema", () => {
  test("all-zero thresholds fail parse", () => {
    expect(() =>
      CostGuardianThresholdsSchema.parse({ warn: 0, force_private: 0, deregister: 0 }),
    ).toThrow();
  });

  test("valid positive thresholds parse successfully", () => {
    expect(() =>
      CostGuardianThresholdsSchema.parse({ warn: 0.5, force_private: 0.8, deregister: 0.95 }),
    ).not.toThrow();
  });
});

describe("fix 2: deregisterTarget picks the winning horizon", () => {
  test("weekly-driven deregister returns weekly topProvider, not daily", () => {
    const result = decideGuardianAction({
      config: makeConfig({ daily_usd: 100, weekly_usd: 100 }),
      daily: {
        snapshot: {
          totalEstimatedCostUsd: 5,
          windowSince: "2024-01-01T00:00:00Z",
          windowUntil: "2024-01-02T00:00:00Z",
          topProvider: { key: "provider-daily", estimatedCostUsd: 5 },
        },
      },
      weekly: {
        snapshot: {
          totalEstimatedCostUsd: 95,
          windowSince: "2024-01-01T00:00:00Z",
          windowUntil: "2024-01-08T00:00:00Z",
          topProvider: { key: "provider-weekly", estimatedCostUsd: 95 },
        },
      },
    });
    expect(result.tier).toBe("deregister");
    expect(result.deregisterTarget).toBe("provider-weekly");
  });
});

describe("fix 3: Infinity fraction maps to deregister", () => {
  test("infinite cost fraction escalates to deregister tier", () => {
    const result = decideGuardianAction({
      config: makeConfig({ daily_usd: 100 }),
      daily: {
        snapshot: {
          totalEstimatedCostUsd: Infinity,
          windowSince: "2024-01-01T00:00:00Z",
          windowUntil: "2024-01-02T00:00:00Z",
        },
      },
    });
    expect(result.tier).toBe("deregister");
  });
});

describe("fix 4: negative cost clamped to zero", () => {
  test("negative totalEstimatedCostUsd is treated as zero spend", () => {
    const result = decideGuardianAction({
      config: makeConfig({ daily_usd: 100 }),
      daily: {
        snapshot: {
          totalEstimatedCostUsd: -50,
          windowSince: "2024-01-01T00:00:00Z",
          windowUntil: "2024-01-02T00:00:00Z",
        },
      },
    });
    expect(result.tier).toBe("noop");
    expect(result.dailyFraction).toBe(0);
  });
});
