// #519: knob-scope warning lines rendered by `llamactl residency status`.
// They belong with the policy block, before the budget, and an absent or
// empty list prints nothing. At the pinned base the renderer ignores the
// field, so CK1 and CK2 fail BY ASSERTION — never by an import or type error.
import { describe, expect, test } from "bun:test";

import * as residencyMod from "../src/commands/residency.js";

type Knob =
  | "idleEvictSeconds"
  | "minResidencySeconds"
  | "switchCooldownSeconds"
  | "safetyMarginRatio"
  | "residentPreference"
  | "coldLoadPenaltyMs";
type KnobEntry = { name: Knob; value: number; defaulted: boolean };
type EffectivePolicySection = { knobs: KnobEntry[] };

const ALL: Knob[] = [
  "idleEvictSeconds",
  "minResidencySeconds",
  "switchCooldownSeconds",
  "safetyMarginRatio",
  "residentPreference",
  "coldLoadPenaltyMs",
];
const DEFAULTS: Record<Knob, number> = {
  idleEvictSeconds: 0,
  minResidencySeconds: 0,
  switchCooldownSeconds: 0,
  safetyMarginRatio: 0.75,
  residentPreference: 0,
  coldLoadPenaltyMs: 0,
};

function entries(values: Record<Knob, number>, defaulted: readonly Knob[]): KnobEntry[] {
  return ALL.map((name) => ({
    name,
    value: values[name],
    defaulted: defaulted.includes(name),
  }));
}

const BASE_STATUS = {
  node: "gpu1",
  nodeRun: { present: false },
  policy: { present: false },
  budget: { memoryGiB: 24, source: "computed" },
  store: { path: "/tmp/rs/operations.sqlite", present: false, scope: "serving-process" },
  leases: { status: "unavailable", scope: "serving-process" },
};

function render(payload: unknown): string {
  return residencyMod.renderResidencyStatus(
    payload as Parameters<typeof residencyMod.renderResidencyStatus>[0],
    1_000_000,
  );
}

describe("llamactl residency status knobScopeWarnings lines (#519)", () => {
  test("CK1: warnings print between Policy and Budget in payload order", () => {
    const out = render({ ...BASE_STATUS, knobScopeWarnings: ["msg A", "msg B"] });

    expect(out).toContain(
      "Policy:     none\n" + "Warning:    msg A\n" + "Warning:    msg B\n" + "Budget:",
    );
  });

  test("CK2: warnings print directly after Effective and before Budget", () => {
    const effectivePolicy: EffectivePolicySection = { knobs: entries(DEFAULTS, ALL) };
    const out = render({
      ...BASE_STATUS,
      effectivePolicy,
      knobScopeWarnings: ["msg A", "msg B"],
    });

    expect(out).toContain(
      "Effective:  idleEvictSeconds 0 (default), minResidencySeconds 0 (default), " +
        "switchCooldownSeconds 0 (default), safetyMarginRatio 0.75 (default), " +
        "residentPreference 0 (default), coldLoadPenaltyMs 0 (default)\n" +
        "Warning:    msg A\n" +
        "Warning:    msg B\n" +
        "Budget:",
    );
  });

  test("CK3: a payload without knobScopeWarnings prints no Warning lines", () => {
    expect(render(BASE_STATUS)).not.toContain("Warning:");
  });

  test("CK4: an empty knobScopeWarnings list prints no Warning lines", () => {
    expect(render({ ...BASE_STATUS, knobScopeWarnings: [] })).not.toContain("Warning:");
  });
});
