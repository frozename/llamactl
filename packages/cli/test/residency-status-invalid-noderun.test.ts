// #519: invalid-NodeRun warning lines rendered by `llamactl residency status`.
// They share the Warning: line form with knob-scope warnings and belong before
// Budget:. At the pinned base the renderer ignores the field, so CI1 and CI2
// fail BY ASSERTION — never by an import or type error.
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

function lineIndex(rows: string[], prefix: string): number {
  return rows.findIndex((line) => line.startsWith(prefix));
}

describe("llamactl residency status invalidNodeRunWarnings lines (#519)", () => {
  test("CI1: an invalid-NodeRun warning prints exactly and before Budget", () => {
    const out = render({ ...BASE_STATUS, invalidNodeRunWarnings: ["W1"] });
    const rows = out.split("\n");

    expect(rows).toContain("Warning:    W1");
    const warningIndex = rows.indexOf("Warning:    W1");
    const budgetIndex = lineIndex(rows, "Budget:");
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(budgetIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(budgetIndex);

    const effectivePolicy: EffectivePolicySection = { knobs: entries(DEFAULTS, ALL) };
    const withEffective = render({
      ...BASE_STATUS,
      effectivePolicy,
      invalidNodeRunWarnings: ["W1"],
    });
    const effectiveRows = withEffective.split("\n");
    expect(effectiveRows.indexOf("Warning:    W1")).toBeGreaterThan(
      lineIndex(effectiveRows, "Effective:"),
    );
    expect(effectiveRows.indexOf("Warning:    W1")).toBeLessThan(
      lineIndex(effectiveRows, "Budget:"),
    );
  });

  test("CI2: knob-scope warnings print before invalid-NodeRun warnings and both before Budget", () => {
    const out = render({
      ...BASE_STATUS,
      knobScopeWarnings: ["K"],
      invalidNodeRunWarnings: ["W"],
    });
    const rows = out.split("\n");

    expect(rows).toContain("Warning:    K");
    expect(rows).toContain("Warning:    W");
    const knobIndex = rows.indexOf("Warning:    K");
    const invalidIndex = rows.indexOf("Warning:    W");
    const budgetIndex = lineIndex(rows, "Budget:");
    expect(knobIndex).toBeGreaterThanOrEqual(0);
    expect(invalidIndex).toBeGreaterThan(knobIndex);
    expect(invalidIndex).toBeLessThan(budgetIndex);
  });

  test("CI3: absent or empty invalidNodeRunWarnings print no Warning lines", () => {
    expect(render(BASE_STATUS)).not.toContain("Warning:");
    expect(render({ ...BASE_STATUS, invalidNodeRunWarnings: [] })).not.toContain("Warning:");
  });
});
