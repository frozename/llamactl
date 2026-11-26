// #519: the effective-policy line rendered by `llamactl residency status`.
// When the agent's payload carries `effectivePolicy`, the renderer prints one
// `Effective:` line directly after `Policy:` and before `Budget:`, preserving
// the server's knob order and suffixing only defaulted entries with
// ` (default)`. An older agent's payload without the section prints no
// placeholder. At the pinned base the renderer ignores the section, so every
// case fails BY ASSERTION — never by an import or type error.
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

function withEffectivePolicy(effectivePolicy: EffectivePolicySection): unknown {
  return { ...BASE_STATUS, effectivePolicy };
}

describe("llamactl residency status effectivePolicy line (#519)", () => {
  test("CE1: defaulted knobs print in policy order between Policy and Budget", () => {
    const out = render(withEffectivePolicy({ knobs: entries(DEFAULTS, ALL) }));
    expect(out).toContain(
      "Policy:     none\n" +
        "Effective:  idleEvictSeconds 0 (default), minResidencySeconds 0 (default), " +
        "switchCooldownSeconds 0 (default), safetyMarginRatio 0.75 (default), " +
        "residentPreference 0 (default), coldLoadPenaltyMs 0 (default)\n" +
        "Budget:",
    );
  });

  test("CE2: only defaulted knobs carry the default suffix", () => {
    const section = {
      knobs: entries({ ...DEFAULTS, minResidencySeconds: 120, safetyMarginRatio: 0.6 }, [
        "idleEvictSeconds",
        "switchCooldownSeconds",
        "residentPreference",
        "coldLoadPenaltyMs",
      ]),
    };
    const out = render(withEffectivePolicy(section));
    expect(out).toContain(
      "Effective:  idleEvictSeconds 0 (default), minResidencySeconds 120, " +
        "switchCooldownSeconds 0 (default), safetyMarginRatio 0.6, residentPreference 0 (default), " +
        "coldLoadPenaltyMs 0 (default)\n",
    );
  });

  test("CE3: the renderer preserves the server's knob order without a CLI-side list", () => {
    const section = {
      knobs: [
        { name: "zKnob", value: 1, defaulted: false },
        { name: "aKnob", value: 2, defaulted: true },
      ],
    } as unknown as EffectivePolicySection;
    const out = render(withEffectivePolicy(section));
    expect(out).toContain("Effective:  zKnob 1, aKnob 2 (default)\n");
  });

  test("CE4: a payload without the section prints no Effective placeholder", () => {
    const withLine = render(withEffectivePolicy({ knobs: entries(DEFAULTS, ALL) }));
    expect(withLine).toContain("Effective:");
    expect(withLine.replace(/^Effective: {2}[^\n]*\n/m, "")).toBe(render(BASE_STATUS));
    expect(render(BASE_STATUS)).not.toContain("Effective");
  });
});
