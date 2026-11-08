import { describe, expect, test } from "bun:test";

import type * as StagesNs from "../../src/qualification/stages.js";

import { QUALIFICATION_STAGES } from "../../src/schemas.js";

type Stages = typeof StagesNs;

async function loadStages(): Promise<Stages> {
  const m: Stages | null = await import("../../src/qualification/stages.js").catch(() => null);
  expect(m).not.toBeNull();
  if (m === null) {
    throw new Error("qualification/stages module missing");
  }
  return m;
}

describe("qualification.stages.PROMOTION_LADDER", () => {
  test("is the experimental-to-production ladder and excludes degraded", async () => {
    const { PROMOTION_LADDER } = await loadStages();
    expect(PROMOTION_LADDER).toEqual(["experimental", "candidate", "validated", "production"]);
    for (const stage of PROMOTION_LADDER) {
      expect(QUALIFICATION_STAGES).toContain(stage);
    }
    expect(PROMOTION_LADDER).not.toContain("degraded");
  });
});

describe("qualification.stages.nextStage", () => {
  test("walks one rung up the ladder", async () => {
    const { nextStage } = await loadStages();
    expect(nextStage("experimental")).toBe("candidate");
    expect(nextStage("candidate")).toBe("validated");
    expect(nextStage("validated")).toBe("production");
  });

  test("returns null at the top of the ladder and for degraded", async () => {
    const { nextStage } = await loadStages();
    expect(nextStage("production")).toBeNull();
    expect(nextStage("degraded")).toBeNull();
  });
});

describe("qualification.stages.effectiveStage", () => {
  test("declared stage passes through unchanged", async () => {
    const { effectiveStage } = await loadStages();
    expect(effectiveStage({ declared: "candidate" })).toEqual({
      stage: "candidate",
      source: "declared",
      baseStage: "candidate",
      degraded: false,
    });
  });

  test("pin overrides the declared stage", async () => {
    const { effectiveStage } = await loadStages();
    expect(effectiveStage({ declared: "experimental", pin: { stage: "validated" } })).toEqual({
      stage: "validated",
      source: "pin",
      baseStage: "validated",
      degraded: false,
    });
  });

  test("unhealthy overlay degrades the effective stage and keeps the reason", async () => {
    const { effectiveStage } = await loadStages();
    expect(
      effectiveStage({
        declared: "production",
        health: { ok: false, reason: "readiness probe failing" },
      }),
    ).toEqual({
      stage: "degraded",
      source: "health",
      baseStage: "production",
      degraded: true,
      reason: "readiness probe failing",
    });
  });

  test("healthy overlay leaves the declared stage in place", async () => {
    const { effectiveStage } = await loadStages();
    expect(effectiveStage({ declared: "production", health: { ok: true } })).toEqual({
      stage: "production",
      source: "declared",
      baseStage: "production",
      degraded: false,
    });
  });

  test("health overlay beats a pin and reports the pinned stage as base", async () => {
    const { effectiveStage } = await loadStages();
    expect(
      effectiveStage({
        declared: "experimental",
        pin: { stage: "production" },
        health: { ok: false, reason: "pin node unhealthy" },
      }),
    ).toMatchObject({
      stage: "degraded",
      source: "health",
      baseStage: "production",
      degraded: true,
    });
  });

  test("declared degraded resolves as degraded", async () => {
    const { effectiveStage } = await loadStages();
    expect(effectiveStage({ declared: "degraded" })).toEqual({
      stage: "degraded",
      source: "declared",
      baseStage: "degraded",
      degraded: true,
    });
  });

  test("pinned degraded resolves as degraded", async () => {
    const { effectiveStage } = await loadStages();
    expect(effectiveStage({ declared: "production", pin: { stage: "degraded" } })).toEqual({
      stage: "degraded",
      source: "pin",
      baseStage: "degraded",
      degraded: true,
    });
  });
});
