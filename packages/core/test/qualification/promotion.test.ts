import { describe, expect, test } from "bun:test";

import type * as PromotionNs from "../../src/qualification/promotion.js";

type Promotion = typeof PromotionNs;

async function loadPromotion(): Promise<Promotion> {
  const m: Promotion | null = await import("../../src/qualification/promotion.js").catch(
    () => null,
  );
  expect(m).not.toBeNull();
  if (m === null) {
    throw new Error("qualification/promotion module missing");
  }
  return m;
}

const T = {
  minEvaluatedTasks: 10,
  minFirstAttemptSuccess: 0.8,
  minRepairSuccess: 0.5,
  minToolCallCorrectness: 0.9,
  minStructuredOutputValidity: 0.9,
  maxRegression: 0.05,
  minImprovement: 0,
  minMemoryStability: 0.9,
  minRuntimeReliability: 0.95,
};

const policy = { thresholds: { candidate: T } };
const autoPolicy = { thresholds: { candidate: T }, autoApply: true };

// Inclusive boundaries: each metric sitting exactly at its min (or
// exactly at maxRegression) must still yield a proposal, pinning `<`
// vs `<=` and `>` vs `>=` in the threshold comparisons
// (frozename/llamactl#518 review).
const METRIC_BOUNDARIES: readonly (readonly [PromotionNs.PromotionMetric, number])[] = [
  ["firstAttemptSuccess", T.minFirstAttemptSuccess],
  ["repairSuccess", T.minRepairSuccess],
  ["toolCallCorrectness", T.minToolCallCorrectness],
  ["structuredOutputValidity", T.minStructuredOutputValidity],
  ["regression", T.maxRegression],
  ["improvement", T.minImprovement],
  ["memoryStability", T.minMemoryStability],
  ["runtimeReliability", T.minRuntimeReliability],
];

const E = {
  evaluatedTasks: 12,
  firstAttemptSuccess: 0.85,
  repairSuccess: 0.6,
  toolCallCorrectness: 0.95,
  structuredOutputValidity: 0.95,
  regression: 0.01,
  improvement: 0.02,
  memoryStability: 0.95,
  runtimeReliability: 0.99,
  evidenceRef: "eval-run-1",
};

describe("qualification.promotion.proposePromotion", () => {
  test("rejects evidence with too few evaluated tasks", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: { ...E, evaluatedTasks: 3 },
      policy,
    });
    expect(decision).toEqual({ kind: "none", reason: "insufficient-evidence" });
  });

  test("rejects evidence missing a required metric", async () => {
    const { proposePromotion } = await loadPromotion();
    const { toolCallCorrectness: _dropped, ...withoutMetric } = E;
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: withoutMetric,
      policy,
    });
    expect(decision).toEqual({ kind: "none", reason: "insufficient-evidence" });
  });

  test("rejects NaN metric values as insufficient evidence", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: { ...E, toolCallCorrectness: NaN },
      policy,
    });
    expect(decision).toEqual({ kind: "none", reason: "insufficient-evidence" });
  });

  test("proposes only the next ladder stage when thresholds are met", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: E,
      policy,
    });
    expect(decision).toMatchObject({
      kind: "proposal",
      proposal: {
        rel: "m.gguf",
        from: "experimental",
        to: "candidate",
        evidenceRef: "eval-run-1",
      },
    });
  });

  test("treats evaluatedTasks equal to minEvaluatedTasks as sufficient", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: { ...E, evaluatedTasks: T.minEvaluatedTasks },
      policy,
    });
    expect(decision).toMatchObject({
      kind: "proposal",
      proposal: { rel: "m.gguf", from: "experimental", to: "candidate" },
    });
  });

  for (const [metric, boundary] of METRIC_BOUNDARIES) {
    test(`treats ${metric} exactly at its threshold as passing`, async () => {
      const { proposePromotion } = await loadPromotion();
      const evidence: PromotionNs.PromotionEvidence = { ...E, evaluatedTasks: T.minEvaluatedTasks };
      evidence[metric] = boundary;
      const decision = proposePromotion({
        rel: "m.gguf",
        declared: "experimental",
        evidence,
        policy,
      });
      expect(decision).toMatchObject({
        kind: "proposal",
        proposal: { rel: "m.gguf", from: "experimental", to: "candidate" },
      });
    });
  }

  test("never skips a stage: candidate promotes to validated", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "candidate",
      evidence: E,
      policy: { thresholds: { validated: T } },
    });
    expect(decision).toMatchObject({
      kind: "proposal",
      proposal: {
        rel: "m.gguf",
        from: "candidate",
        to: "validated",
        evidenceRef: "eval-run-1",
      },
    });
  });

  test("reports every metric below threshold", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: { ...E, toolCallCorrectness: 0.5, regression: 0.2 },
      policy,
    });
    expect(decision).toMatchObject({
      kind: "none",
      reason: "below-threshold",
      failed: ["toolCallCorrectness", "regression"],
    });
  });

  test("returns no-thresholds when the policy has none for the stage", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: E,
      policy: { thresholds: {} },
    });
    expect(decision).toEqual({ kind: "none", reason: "no-thresholds" });
  });

  test("production is a terminal stage", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "production",
      evidence: E,
      policy,
    });
    expect(decision).toEqual({ kind: "none", reason: "terminal-stage" });
  });

  test("degraded is refused as degraded, not terminal", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "degraded",
      evidence: E,
      policy,
    });
    expect(decision).toEqual({ kind: "none", reason: "degraded" });
  });

  test("a freeze override blocks promotion", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: E,
      policy,
      overrides: {
        freeze: {
          rel: "m.gguf",
          action: "freeze",
          stage: "",
          author: "op",
          reason: "hold for review",
          updated_at: "",
        },
      },
    });
    expect(decision).toEqual({ kind: "none", reason: "frozen" });
  });

  test("freeze wins over a pin override", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: E,
      policy,
      overrides: {
        freeze: {
          rel: "m.gguf",
          action: "freeze",
          stage: "",
          author: "op",
          reason: "hold for review",
          updated_at: "",
        },
        pin: {
          rel: "m.gguf",
          action: "pin",
          stage: "experimental",
          author: "op",
          reason: "manual pin",
          updated_at: "2026-11-07T00:00:00Z",
        },
      },
    });
    expect(decision).toEqual({ kind: "none", reason: "frozen" });
  });

  test("a pin override blocks promotion", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: E,
      policy,
      overrides: {
        pin: {
          rel: "m.gguf",
          action: "pin",
          stage: "experimental",
          author: "op",
          reason: "manual pin",
          updated_at: "2026-11-07T00:00:00Z",
        },
      },
    });
    expect(decision).toEqual({ kind: "none", reason: "pinned" });
  });

  test("an unhealthy overlay blocks promotion as degraded", async () => {
    const { proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: E,
      policy,
      health: { ok: false, reason: "node unhealthy" },
    });
    expect(decision).toEqual({ kind: "none", reason: "degraded" });
  });
});

describe("qualification.promotion.applyPromotion", () => {
  test("proposes without applying when the policy omits autoApply", async () => {
    const { applyPromotion, proposePromotion } = await loadPromotion();
    const calls: unknown[] = [];
    const apply = (p: unknown): void => {
      calls.push(p);
    };
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: E,
      policy,
    });
    expect(applyPromotion(decision, { policy, apply })).toEqual({ status: "proposed" });
    expect(calls).toHaveLength(0);
  });

  test("proposes without applying when the policy sets autoApply false", async () => {
    const { applyPromotion, proposePromotion } = await loadPromotion();
    const calls: unknown[] = [];
    const apply = (p: unknown): void => {
      calls.push(p);
    };
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: E,
      policy,
    });
    expect(
      applyPromotion(decision, {
        policy: { thresholds: { candidate: T }, autoApply: false },
        apply,
      }),
    ).toEqual({ status: "proposed" });
    expect(calls).toHaveLength(0);
  });

  test("applies the proposal when the policy sets autoApply true", async () => {
    const { applyPromotion, proposePromotion } = await loadPromotion();
    const calls: unknown[] = [];
    const apply = (p: unknown): void => {
      calls.push(p);
    };
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: E,
      policy,
    });
    expect(applyPromotion(decision, { policy: autoPolicy, apply })).toEqual({
      status: "applied",
      to: "candidate",
    });
    expect(calls).toHaveLength(1);
  });

  test("stays proposed when autoApply is true but no writer is injected", async () => {
    const { applyPromotion, proposePromotion } = await loadPromotion();
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: E,
      policy,
    });
    expect(applyPromotion(decision, { policy: autoPolicy })).toEqual({ status: "proposed" });
  });

  test("skips kind-none decisions even with autoApply", async () => {
    const { applyPromotion, proposePromotion } = await loadPromotion();
    const calls: unknown[] = [];
    const apply = (p: unknown): void => {
      calls.push(p);
    };
    const decision = proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: { ...E, evaluatedTasks: 3 },
      policy,
    });
    expect(applyPromotion(decision, { policy: autoPolicy, apply })).toEqual({ status: "skipped" });
    expect(calls).toHaveLength(0);
  });
});

describe("qualification.promotion.schemas", () => {
  test("PromotionPolicySchema defaults autoApply to false", async () => {
    const { PromotionPolicySchema } = await loadPromotion();
    expect(PromotionPolicySchema.parse({ thresholds: { candidate: T } }).autoApply).toBe(false);
  });

  test("PromotionThresholdsSchema rejects out-of-range ratios", async () => {
    const { PromotionThresholdsSchema } = await loadPromotion();
    expect(PromotionThresholdsSchema.safeParse({ ...T, minToolCallCorrectness: 1.5 }).success).toBe(
      false,
    );
  });

  test("PromotionThresholdsSchema requires integer task counts", async () => {
    const { PromotionThresholdsSchema } = await loadPromotion();
    expect(PromotionThresholdsSchema.safeParse({ ...T, minEvaluatedTasks: 2.5 }).success).toBe(
      false,
    );
  });
});
