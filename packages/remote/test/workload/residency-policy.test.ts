// #519: ResidencyPolicy lands with the fix. The admission module already
// exists, so the new symbols are read through a Partial cast — namespace
// access yields undefined and each case fails by assertion, not by import.
import * as residencyAdmission from "@llamactl/core/residency/admission";
import { expect, test } from "bun:test";

import { defaultNodeBudgetGiB } from "../../src/workload/admission.js";
import { NodeRunSchema } from "../../src/workload/noderun-schema.js";

const DEFAULTS = (residencyAdmission as Partial<typeof residencyAdmission>)
  .DEFAULT_RESIDENCY_POLICY;
const resolve = (residencyAdmission as Partial<typeof residencyAdmission>).resolveResidencyPolicy;

const EXPECTED_DEFAULTS = {
  idleEvictSeconds: 0,
  minResidencySeconds: 0,
  switchCooldownSeconds: 0,
  safetyMarginRatio: 0.75,
  residentPreference: 0,
  coldLoadPenaltyMs: 0,
};

test("DEFAULT_RESIDENCY_POLICY reproduces today's behaviour", () => {
  expect(DEFAULTS).toEqual(EXPECTED_DEFAULTS);
  expect(DEFAULTS?.safetyMarginRatio).toBe(residencyAdmission.MEMORY_BUDGET_HEADROOM_RATIO);
});

test("resolveResidencyPolicy fills defaults and overrides only given fields", () => {
  expect(typeof resolve).toBe("function");
  expect(resolve!(undefined)).toEqual(EXPECTED_DEFAULTS);
  expect(resolve!({ safetyMarginRatio: 0.5, idleEvictSeconds: 300 })).toEqual({
    ...EXPECTED_DEFAULTS,
    safetyMarginRatio: 0.5,
    idleEvictSeconds: 300,
  });
  expect(resolve!({ safetyMarginRatio: 0 }).safetyMarginRatio).toBe(0.75);
  expect(resolve!({ idleEvictSeconds: -1 }).idleEvictSeconds).toBe(0);
});

test("NodeRun accepts spec.residency and keeps it partial", () => {
  const parsed = NodeRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name: "a" },
    spec: {
      node: "local",
      residency: { safetyMarginRatio: 0.5, idleEvictSeconds: 300 },
    },
  });
  expect((parsed.spec as Record<string, unknown>)["residency"]).toEqual({
    safetyMarginRatio: 0.5,
    idleEvictSeconds: 300,
  });
});

test("NodeRun rejects invalid spec.residency", () => {
  const invalidResidency = [
    { safetyMarginRatio: 0 },
    { safetyMarginRatio: 1.5 },
    { safetyMarginRatio: -0.1 },
    { idleEvictSeconds: -1 },
    { minResidencySeconds: 1.5 },
    { switchCooldownSeconds: -5 },
    { coldLoadPenaltyMs: -1 },
    { residentPreference: -1 },
    { safetyMarginRatio: 0.5, bogus: 1 },
  ];
  for (const residency of invalidResidency) {
    const result = NodeRunSchema.safeParse({
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "a" },
      spec: { node: "local", residency },
    });
    expect(result.success).toBe(false);
  }
});

test("defaultNodeBudgetGiB applies the policy safety margin to node memory", () => {
  const GiB = 1024 ** 3;
  expect(defaultNodeBudgetGiB(undefined, 124 * GiB, { safetyMarginRatio: 0.5 })).toBe(62);
  expect(defaultNodeBudgetGiB(undefined, 124 * GiB, {})).toBe(93);
  expect(defaultNodeBudgetGiB(undefined, 124 * GiB, undefined)).toBe(93);
  expect(defaultNodeBudgetGiB(40, 124 * GiB, { safetyMarginRatio: 0.5 })).toBe(40);
});
