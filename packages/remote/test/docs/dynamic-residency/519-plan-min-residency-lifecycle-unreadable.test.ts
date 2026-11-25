import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #519
// Kills: shipping the residencyPlan LifecycleUnreadable refusal undocumented,
// or documenting it without the minResidencyLifecycleRefusal helper wired
// into buildResidencyPlan.
describe("#519 residencyPlan min-residency lifecycle-unreadable refusal", () => {
  test("D1: the knobs section documents the refusal and its scope", () => {
    // kills: shipping the refusal undocumented, or leaving the stale
    // fail-open sentence.
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    for (const pin of [
      "refuse with `LifecycleUnreadable` when the serving node's lifecycle rows cannot be read",
      "a switch with no victims",
    ]) {
      expect(knobs, `knobs pin ${pin}`).toContain(pin);
    }
    expect(knobs).not.toContain("`residencyPlan` protects nothing");
  });

  test("D2: procedures.ts implements the refusal inside buildResidencyPlan", () => {
    // kills: the documented refusal having no implementing helper, or the
    // helper not being called from buildResidencyPlan.
    const src = readOrEmpty(join(REPO, "packages/remote/src/residency/procedures.ts"));
    const helper = enclosingBody(src, "function minResidencyLifecycleRefusal(");
    for (const pin of [
      '"LifecycleUnreadable"',
      "lifecycleError",
      "minResidencySeconds",
      "victims",
    ]) {
      expect(helper, `helper pin ${pin}`).toContain(pin);
    }
    const plan = enclosingBody(src, "export function buildResidencyPlan(");
    expect(plan).toContain("minResidencyLifecycleRefusal(");
  });
});
