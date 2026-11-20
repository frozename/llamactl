import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

describe("#520 apply-profile dry-run session detail", () => {
  test("dry-run annotates the bound victim fence step; doc and source stay pinned", () => {
    const s = flat(sectionBody(SECTIONS.statusPlanApply) ?? "");
    for (const needle of ["dry run", "`SessionsActive: <ids>`", "planned", "advisory", "(#520)"]) {
      expect(s, needle).toContain(needle);
    }
    const profileTransition = readOrEmpty(
      join(REPO, "packages/remote/src/residency/profile-transition.ts"),
    );
    const dryRunSteps = enclosingBody(profileTransition, "function dryRunSteps(");
    expect(dryRunSteps, "dryRunSteps signature").not.toBe("");
    for (const pin of ["sessionRefusal(", "fenced"]) {
      expect(dryRunSteps, pin).toContain(pin);
    }
  });
});
