import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  REPO,
  RESIDENCY_CLI,
  sectionBody,
  SECTIONS,
} from "./helpers.js";

// Part of #519
// Kills: docs that do not describe the section, the helper being renamed,
// inlined or unwired, and a CLI-side knob list.

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

const PROCEDURES = join(REPO, "packages/remote/src/residency/procedures.ts");

// The section shape is structural in the runtime tests; mentioning it here
// keeps this doc pin tied to the same contract without depending on the
// implementation type landing first.
const sectionContract: EffectivePolicySection = { knobs: entries(DEFAULTS, ALL) };

describe("#519 residency status effective policy", () => {
  test("D1: the knobs section documents the effectivePolicy status block", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    expectPins(knobs, "effective policy", [
      "The `effectivePolicy` section of `residencyStatus`",
      "`effectiveResidencyPolicy`",
      "`RESIDENCY_POLICY_KNOBS`",
      "`resolveResidencyPolicy`",
      "`knobs`",
      "`defaulted`",
      "`DEFAULT_RESIDENCY_POLICY`",
      "`pushEffectivePolicyLine`",
      "`Effective: idleEvictSeconds <n>, minResidencySeconds <n>, switchCooldownSeconds <n>, safetyMarginRatio <r>, residentPreference <p>, coldLoadPenaltyMs <n>`",
      "` (default)`",
      "prints no `Effective:` line",
    ]);
  });

  test("D2: source pins name the resolver, status assembly and CLI renderer helper", () => {
    const procedures = readOrEmpty(PROCEDURES);
    const effective = enclosingBody(procedures, "export function effectiveResidencyPolicy(");
    expect(effective).not.toBe("");
    expect(effective).toContain("resolveResidencyPolicy(");
    expect(effective).toContain("RESIDENCY_POLICY_KNOBS");
    expect(effective).toContain("defaulted");

    const build = enclosingBody(procedures, "export function buildResidencyStatus(");
    expect(build).toContain("effectivePolicy: effectiveResidencyPolicy(");

    const cli = readOrEmpty(RESIDENCY_CLI);
    const cliHelper = enclosingBody(cli, "function pushEffectivePolicyLine(");
    expect(cliHelper).not.toBe("");
    expect(cliHelper).toContain("Effective:  ");
    expect(cliHelper).toContain(" (default)");
    for (const entry of sectionContract.knobs) {
      expect(cliHelper).not.toContain(entry.name);
    }

    const render = enclosingBody(cli, "export function renderResidencyStatus(");
    expect(render).toContain("pushEffectivePolicyLine(lines");
  });
});
