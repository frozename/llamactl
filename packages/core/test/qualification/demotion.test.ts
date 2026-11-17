// RED tests for frozename/llamactl#518 routing (b): the entry path into
// `degraded`. They pin the demotion surface — the `demotion` policy
// block on PromotionPolicySchema, proposeDemotion's configured-floor
// semantics, the evaluateQualification fallthrough and the
// applyQualification autoApply gate. Repo files and injected fakes
// only: no network, no processes, no live state, so every case fails
// by assertion at the pinned base rather than by a resolution error.
import { describe, expect, test } from "bun:test";

import type * as DemotionNs from "../../src/qualification/demotion.js";

import * as P from "../../src/qualification/promotion.js";

type Demotion = typeof DemotionNs;
type PromotionMetric = (typeof P.PROMOTION_METRICS)[number];

// New promotion.js exports are reached through a widened view: a named
// import of a symbol that does not exist yet is a link-time error.
const PX = P as unknown as Record<string, unknown>;

async function loadDemotion(): Promise<Demotion> {
  const m: Demotion | null = await import("../../src/qualification/demotion.js").catch(() => null);
  expect(m).not.toBeNull();
  if (m === null) {
    throw new Error("qualification/demotion module missing");
  }
  return m;
}

const D = {
  minEvaluatedTasks: 10,
  maxRegression: 0.1,
  minFirstAttemptSuccess: 0.6,
  minRepairSuccess: 0.3,
  minToolCallCorrectness: 0.7,
  minStructuredOutputValidity: 0.7,
  minImprovement: -0.2,
  minMemoryStability: 0.7,
  minRuntimeReliability: 0.8,
};

// The promotion threshold set and healthy evidence, copied from
// promotion.test.ts so both decision paths see identical inputs.
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

const freezeRow = {
  rel: "m.gguf",
  action: "freeze",
  stage: "",
  author: "op",
  reason: "r",
  updated_at: "",
} as const;

const pinRow = {
  rel: "m.gguf",
  action: "pin",
  stage: "production",
  author: "op",
  reason: "r",
  updated_at: "2026-11-16T00:00:00Z",
} as const;

const BREACHING = { ...E, regression: 0.2 };
const demotionPolicy = { thresholds: {}, demotion: D };

describe("qualification.promotion.PromotionPolicySchema demotion block", () => {
  test("parses and preserves the demotion threshold block", () => {
    // kills: `demotion` key missing from PromotionPolicySchema — zod
    // strips the unknown key, so the parsed policy loses it.
    const parsed = P.PromotionPolicySchema.parse({
      thresholds: {},
      demotion: D,
    }) as Record<string, unknown>;
    expect(parsed["demotion"]).toEqual(D);
  });

  test("demotion thresholds are strict and bounded", () => {
    // kills: dropping .strict(), the ratio bound on maxRegression, or
    // min(-1) on minImprovement. Every input carries thresholds: {} so
    // only the demotion block can fail the parse.
    const control = P.PromotionPolicySchema.safeParse({ thresholds: {}, demotion: D });
    expect(control.success).toBe(true);
    if (control.success) {
      expect((control.data as Record<string, unknown>)["demotion"]).toEqual(D);
    }
    expect(
      P.PromotionPolicySchema.safeParse({ thresholds: {}, demotion: { ...D, bogus: 1 } }).success,
    ).toBe(false);
    expect(
      P.PromotionPolicySchema.safeParse({
        thresholds: {},
        demotion: { ...D, maxRegression: 1.5 },
      }).success,
    ).toBe(false);
    expect(
      P.PromotionPolicySchema.safeParse({
        thresholds: {},
        demotion: { ...D, minImprovement: -2 },
      }).success,
    ).toBe(false);
    expect(
      P.PromotionPolicySchema.safeParse({
        thresholds: {},
        demotion: { ...D, minImprovement: -0.5 },
      }).success,
    ).toBe(true);
    expect(typeof PX["DemotionThresholdsSchema"]).toBe("object");
  });

  test("minEvaluatedTasks is required and a nonnegative integer", () => {
    // kills: making minEvaluatedTasks optional, dropping .nonnegative(),
    // or dropping .int() on the shared evidence gate.
    expect(
      P.PromotionPolicySchema.safeParse({ thresholds: {}, demotion: { maxRegression: 0.1 } })
        .success,
    ).toBe(false);
    expect(
      P.PromotionPolicySchema.safeParse({
        thresholds: {},
        demotion: { ...D, minEvaluatedTasks: -1 },
      }).success,
    ).toBe(false);
    expect(
      P.PromotionPolicySchema.safeParse({
        thresholds: {},
        demotion: { ...D, minEvaluatedTasks: 1.5 },
      }).success,
    ).toBe(false);
    expect(
      P.PromotionPolicySchema.safeParse({
        thresholds: {},
        demotion: { ...D, minEvaluatedTasks: 0 },
      }).success,
    ).toBe(true);
  });

  for (const key of [
    "minFirstAttemptSuccess",
    "minRepairSuccess",
    "minToolCallCorrectness",
    "minStructuredOutputValidity",
    "minMemoryStability",
    "minRuntimeReliability",
  ] as const) {
    test(`${key} is bounded to [0, 1]`, () => {
      // kills: replacing the ratio bound on this min floor.
      for (const bad of [1.5, -0.1]) {
        expect(
          P.PromotionPolicySchema.safeParse({
            thresholds: {},
            demotion: { ...D, [key]: bad },
          }).success,
        ).toBe(false);
      }
    });
  }

  test("minImprovement is bounded above by 1", () => {
    // kills: dropping max(1) on minImprovement.
    expect(
      P.PromotionPolicySchema.safeParse({
        thresholds: {},
        demotion: { ...D, minImprovement: 1.5 },
      }).success,
    ).toBe(false);
    expect(
      P.PromotionPolicySchema.safeParse({
        thresholds: {},
        demotion: { ...D, minImprovement: 1 },
      }).success,
    ).toBe(true);
  });
});

describe("qualification.demotion.proposeDemotion", () => {
  test("proposes degraded for a production rel past a floor", async () => {
    // kills: a flipped comparator or a wrong from/to on the proposal.
    const { proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: BREACHING,
      policy: demotionPolicy,
    });
    expect(decision).toEqual({
      kind: "demotion",
      proposal: {
        rel: "m.gguf",
        from: "production",
        to: "degraded",
        breached: ["regression"],
        metrics: {
          firstAttemptSuccess: 0.85,
          repairSuccess: 0.6,
          toolCallCorrectness: 0.95,
          structuredOutputValidity: 0.95,
          regression: 0.2,
          improvement: 0.02,
          memoryStability: 0.95,
          runtimeReliability: 0.99,
        },
        evidenceRef: "eval-run-1",
      },
    });
  });

  // Floor-to-metric map: maxRegression -> regression, minImprovement ->
  // improvement, minX -> x. Floor values come from D; breach values are
  // literals 0.01 past the floor so no float arithmetic drifts across
  // the boundary.
  const EDGE: readonly (readonly [PromotionMetric, number, number])[] = [
    ["firstAttemptSuccess", D.minFirstAttemptSuccess, 0.59],
    ["repairSuccess", D.minRepairSuccess, 0.29],
    ["toolCallCorrectness", D.minToolCallCorrectness, 0.69],
    ["structuredOutputValidity", D.minStructuredOutputValidity, 0.69],
    ["regression", D.maxRegression, 0.11],
    ["improvement", D.minImprovement, -0.21],
    ["memoryStability", D.minMemoryStability, 0.69],
    ["runtimeReliability", D.minRuntimeReliability, 0.79],
  ];

  for (const [metric, floor, breach] of EDGE) {
    test(`${metric} exactly at its floor stays within tolerance`, async () => {
      // kills: >= vs > and <= vs < — a metric sitting exactly on its
      // floor (or exactly on maxRegression) must not breach.
      const { proposeDemotion } = await loadDemotion();
      const evidence: P.PromotionEvidence = { ...E };
      evidence[metric] = floor;
      const decision = proposeDemotion({
        rel: "m.gguf",
        declared: "production",
        evidence,
        policy: demotionPolicy,
      });
      expect(decision).toEqual({ kind: "none", reason: "within-tolerance" });
    });

    test(`${metric} 0.01 past its floor breaches alone`, async () => {
      // kills: a comparator that never fires, or one that sweeps
      // neighbouring metrics into breached.
      const { proposeDemotion } = await loadDemotion();
      const evidence: P.PromotionEvidence = { ...E };
      evidence[metric] = breach;
      const decision = proposeDemotion({
        rel: "m.gguf",
        declared: "production",
        evidence,
        policy: demotionPolicy,
      });
      expect(decision).toMatchObject({
        kind: "demotion",
        proposal: { from: "production", to: "degraded", breached: [metric] },
      });
    });
  }

  test("checks only the configured floors", async () => {
    // kills: requiring every PROMOTION_METRICS value even when the
    // policy configures a subset.
    const { proposeDemotion } = await loadDemotion();
    const { toolCallCorrectness: _dropped, ...withoutToolCall } = E;
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: withoutToolCall,
      policy: { thresholds: {}, demotion: { minEvaluatedTasks: 10, maxRegression: 0.1 } },
    });
    expect(decision).toEqual({ kind: "none", reason: "within-tolerance" });
  });

  test("a configured floor whose metric is absent or NaN is insufficient evidence", async () => {
    // kills: treating a missing configured metric as within-tolerance.
    const { proposeDemotion } = await loadDemotion();
    const { regression: _dropped, ...withoutRegression } = E;
    const policy = { thresholds: {}, demotion: { minEvaluatedTasks: 10, maxRegression: 0.1 } };
    expect(
      proposeDemotion({
        rel: "m.gguf",
        declared: "production",
        evidence: withoutRegression,
        policy,
      }),
    ).toEqual({ kind: "none", reason: "insufficient-evidence" });
    expect(
      proposeDemotion({
        rel: "m.gguf",
        declared: "production",
        evidence: { ...E, regression: NaN },
        policy,
      }),
    ).toEqual({ kind: "none", reason: "insufficient-evidence" });
  });

  test("minEvaluatedTasks is an inclusive floor", async () => {
    // kills: <= on minEvaluatedTasks, which would reject exactly-10.
    const { proposeDemotion } = await loadDemotion();
    const policy = { thresholds: {}, demotion: { minEvaluatedTasks: 10, maxRegression: 0.1 } };
    expect(
      proposeDemotion({
        rel: "m.gguf",
        declared: "production",
        evidence: { ...E, evaluatedTasks: 9 },
        policy,
      }),
    ).toEqual({ kind: "none", reason: "insufficient-evidence" });
    expect(
      proposeDemotion({
        rel: "m.gguf",
        declared: "production",
        evidence: { ...E, evaluatedTasks: 10 },
        policy,
      }),
    ).toEqual({ kind: "none", reason: "within-tolerance" });
  });

  test("a policy with no demotion block reports no-thresholds", async () => {
    // kills: treating an absent demotion block as within-tolerance or
    // as licence to demote on every metric.
    const { proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: BREACHING,
      policy: { thresholds: {} },
    });
    expect(decision).toEqual({ kind: "none", reason: "no-thresholds" });
  });

  test("a demotion block with only minEvaluatedTasks reports no-thresholds", async () => {
    // kills: counting the task gate as a configured floor.
    const { proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: BREACHING,
      policy: { thresholds: {}, demotion: { minEvaluatedTasks: 10 } },
    });
    expect(decision).toEqual({ kind: "none", reason: "no-thresholds" });
  });

  test("no-thresholds is checked before insufficient evidence", async () => {
    // kills: testing the task gate before the floor-less check.
    const { proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: { ...BREACHING, evaluatedTasks: 9 },
      policy: { thresholds: {}, demotion: { minEvaluatedTasks: 10 } },
    });
    expect(decision).toEqual({ kind: "none", reason: "no-thresholds" });
  });

  test("a proposal reports only the configured floors' metrics", async () => {
    // kills: copying every evidence metric into proposal.metrics.
    const { proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: BREACHING,
      policy: { thresholds: {}, demotion: { minEvaluatedTasks: 10, maxRegression: 0.1 } },
    });
    expect(decision.kind).toBe("demotion");
    if (decision.kind !== "demotion") throw new Error("expected a demotion");
    expect(decision.proposal.metrics).toEqual({ regression: 0.2 });
  });

  test("a freeze override blocks demotion", async () => {
    // kills: reordering the override checks so pin is consulted first,
    // or skipping overrides entirely on the demotion path.
    const { proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: BREACHING,
      policy: demotionPolicy,
      overrides: { freeze: freezeRow },
    });
    expect(decision).toEqual({ kind: "none", reason: "frozen" });
  });

  test("a pin override blocks demotion", async () => {
    // kills: ignoring pin rows on the demotion path.
    const { proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: BREACHING,
      policy: demotionPolicy,
      overrides: { pin: pinRow },
    });
    expect(decision).toEqual({ kind: "none", reason: "pinned" });
  });

  test("freeze wins over pin on the demotion path", async () => {
    // kills: consulting pin before freeze.
    const { proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: BREACHING,
      policy: demotionPolicy,
      overrides: { freeze: freezeRow, pin: pinRow },
    });
    expect(decision).toEqual({ kind: "none", reason: "frozen" });
  });

  test("declared degraded is already-degraded, not a demotion", async () => {
    // kills: re-demoting an already-degraded rel or reporting
    // within-tolerance for it.
    const { proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "degraded",
      evidence: BREACHING,
      policy: demotionPolicy,
    });
    expect(decision).toEqual({ kind: "none", reason: "already-degraded" });
  });

  test("declared experimental is not demotable", async () => {
    // kills: demoting a stage that never reached production.
    const { proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: BREACHING,
      policy: demotionPolicy,
    });
    expect(decision).toEqual({ kind: "none", reason: "not-demotable" });
  });

  test("declared candidate demotes from candidate", async () => {
    // kills: hard-coding from: "production" instead of the declared
    // stage.
    const { proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "candidate",
      evidence: BREACHING,
      policy: demotionPolicy,
    });
    expect(decision).toMatchObject({
      kind: "demotion",
      proposal: { rel: "m.gguf", from: "candidate", to: "degraded" },
    });
  });

  test("declared validated demotes from validated", async () => {
    // kills: excluding validated from the demotable set.
    const { proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "validated",
      evidence: BREACHING,
      policy: demotionPolicy,
    });
    expect(decision).toMatchObject({
      kind: "demotion",
      proposal: { rel: "m.gguf", from: "validated", to: "degraded" },
    });
  });

  test("multiple breaches report in PROMOTION_METRICS order", async () => {
    // kills: unordered or first-only breached reporting.
    const { proposeDemotion } = await loadDemotion();
    const breached = new Set(["firstAttemptSuccess", "regression", "runtimeReliability"]);
    const expected = P.PROMOTION_METRICS.filter((metric) => breached.has(metric));
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: { ...E, firstAttemptSuccess: 0.5, regression: 0.2, runtimeReliability: 0.7 },
      policy: demotionPolicy,
    });
    expect(decision).toMatchObject({
      kind: "demotion",
      proposal: { from: "production", to: "degraded", breached: expected },
    });
  });

  test("a deep-frozen input is neither mutated nor nondeterministic", async () => {
    // kills: input mutation (e.g. sorting breached in place) or
    // order-dependent state between calls.
    const { proposeDemotion } = await loadDemotion();
    const deepFreeze = <V>(value: V): V => {
      if (value !== null && typeof value === "object") {
        for (const inner of Object.values(value)) deepFreeze(inner);
        Object.freeze(value);
      }
      return value;
    };
    const input = deepFreeze({
      rel: "m.gguf",
      declared: "production" as const,
      evidence: BREACHING,
      policy: demotionPolicy,
      overrides: {},
    });
    const first = proposeDemotion(input);
    const second = proposeDemotion(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: "demotion",
      proposal: { from: "production", to: "degraded" },
    });
  });
});

describe("qualification.demotion.evaluateQualification", () => {
  const evalPolicy = {
    thresholds: { candidate: T, validated: T },
    demotion: { minEvaluatedTasks: 10, minRuntimeReliability: 0.995 },
  };
  const promotionOnlyPolicy = { thresholds: { candidate: T, validated: T } };

  test("experimental falls through to promotion untouched", async () => {
    // kills: demotion evaluated before the stage gate, or a fallthrough
    // that rewrites the promotion decision.
    const { evaluateQualification } = await loadDemotion();
    const input = {
      rel: "m.gguf",
      declared: "experimental" as const,
      evidence: E,
      policy: evalPolicy,
    };
    expect(evaluateQualification(input)).toEqual(P.proposePromotion(input));
  });

  test("a demotable stage breaching a floor demotes before promotion", async () => {
    // kills: promotion evaluated before demotion — candidate would
    // otherwise propose validated and never reach degraded.
    const { evaluateQualification } = await loadDemotion();
    const decision = evaluateQualification({
      rel: "m.gguf",
      declared: "candidate",
      evidence: { ...E, runtimeReliability: 0.99 },
      policy: evalPolicy,
    });
    expect(decision).toMatchObject({
      kind: "demotion",
      proposal: { rel: "m.gguf", from: "candidate", to: "degraded" },
    });
  });

  test("within tolerance falls through to promotion", async () => {
    // kills: returning the demotion none-decision instead of the
    // promotion result once floors pass.
    const { evaluateQualification } = await loadDemotion();
    const input = {
      rel: "m.gguf",
      declared: "production" as const,
      evidence: { ...E, runtimeReliability: 0.996 },
      policy: evalPolicy,
    };
    expect(evaluateQualification(input)).toEqual(P.proposePromotion(input));
  });

  test("with no demotion block it matches proposePromotion on every refusal", async () => {
    // kills: a demotion short-circuit (no-thresholds, frozen, pinned,
    // degraded) firing ahead of the promotion checks.
    const { evaluateQualification } = await loadDemotion();
    const inputs = [
      {
        rel: "m.gguf",
        declared: "experimental" as const,
        evidence: E,
        policy: promotionOnlyPolicy,
        overrides: { freeze: freezeRow },
      },
      {
        rel: "m.gguf",
        declared: "experimental" as const,
        evidence: E,
        policy: promotionOnlyPolicy,
        overrides: { pin: pinRow },
      },
      {
        rel: "m.gguf",
        declared: "experimental" as const,
        evidence: E,
        policy: promotionOnlyPolicy,
        health: { ok: false, reason: "node unhealthy" },
      },
      {
        rel: "m.gguf",
        declared: "experimental" as const,
        evidence: { ...E, toolCallCorrectness: 0.5 },
        policy: promotionOnlyPolicy,
      },
      {
        rel: "m.gguf",
        declared: "experimental" as const,
        evidence: E,
        policy: promotionOnlyPolicy,
      },
    ];
    for (const input of inputs) {
      expect(evaluateQualification(input)).toEqual(P.proposePromotion(input));
    }
  });
});

describe("qualification.demotion.applyQualification", () => {
  const autoDemotionPolicy = { thresholds: {}, demotion: D, autoApply: true };
  const autoPromotionPolicy = { thresholds: { candidate: T }, autoApply: true };

  test("a demotion decision stays proposed without autoApply", async () => {
    // kills: autoApply ignored or a writer invoked while the policy
    // leaves it off.
    const { applyQualification, proposeDemotion } = await loadDemotion();
    const calls: unknown[] = [];
    const apply = (proposal: unknown): void => {
      calls.push(proposal);
    };
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: BREACHING,
      policy: demotionPolicy,
    });
    expect(applyQualification(decision, { policy: demotionPolicy, apply })).toEqual({
      status: "proposed",
    });
    expect(calls).toHaveLength(0);
  });

  test("autoApply writes the demotion proposal to degraded", async () => {
    // kills: a wrong `to` on the applied result or the writer receiving
    // anything but the demotion proposal.
    const { applyQualification, proposeDemotion } = await loadDemotion();
    const calls: unknown[] = [];
    const apply = (proposal: unknown): void => {
      calls.push(proposal);
    };
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: BREACHING,
      policy: demotionPolicy,
    });
    expect(decision.kind).toBe("demotion");
    if (decision.kind !== "demotion") {
      throw new Error("expected a demotion decision");
    }
    expect(applyQualification(decision, { policy: autoDemotionPolicy, apply })).toEqual({
      status: "applied",
      to: "degraded",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(decision.proposal);
  });

  test("autoApply without a writer stays proposed", async () => {
    // kills: reporting applied when no catalog writer was injected.
    const { applyQualification, proposeDemotion } = await loadDemotion();
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: BREACHING,
      policy: demotionPolicy,
    });
    expect(applyQualification(decision, { policy: autoDemotionPolicy })).toEqual({
      status: "proposed",
    });
  });

  test("a promotion proposal still applies to its rung", async () => {
    // kills: applyQualification refusing non-demotion decisions.
    const { applyQualification } = await loadDemotion();
    const calls: unknown[] = [];
    const apply = (proposal: unknown): void => {
      calls.push(proposal);
    };
    const decision = P.proposePromotion({
      rel: "m.gguf",
      declared: "experimental",
      evidence: E,
      policy: { thresholds: { candidate: T } },
    });
    expect(applyQualification(decision, { policy: autoPromotionPolicy, apply })).toEqual({
      status: "applied",
      to: "candidate",
    });
    expect(calls).toHaveLength(1);
  });

  test("a none decision is skipped even with autoApply", async () => {
    // kills: writing on a refusal decision.
    const { applyQualification, proposeDemotion } = await loadDemotion();
    const calls: unknown[] = [];
    const apply = (proposal: unknown): void => {
      calls.push(proposal);
    };
    const decision = proposeDemotion({
      rel: "m.gguf",
      declared: "production",
      evidence: E,
      policy: demotionPolicy,
    });
    expect(applyQualification(decision, { policy: autoDemotionPolicy, apply })).toEqual({
      status: "skipped",
    });
    expect(calls).toHaveLength(0);
  });
});
