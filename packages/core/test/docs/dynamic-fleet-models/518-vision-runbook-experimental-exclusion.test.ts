import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

describe("#518 vision runbook experimental exclusion", () => {
  test("qualification section documents benchCompare stages and runbook exclusion", () => {
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    // Kills: the doc paragraph is missing, or the wiring is absent.
    for (const needle of [
      "`benchCompare` (`packages/core/src/bench/compare.ts`) carries each row's routing stage as `qualificationStage`, read through `catalogQualificationStages`",
      "the `promote-fastest-vision-model` runbook never picks an experimental rel",
      "every benched installed multimodal rel is experimental",
      "a refused `llamactl.catalog.promote` step fails the runbook before `llamactl.embersynth.sync`",
    ]) {
      expect(q, needle).toContain(needle);
    }

    const compareSource = readOrEmpty(join(REPO, "packages/core/src/bench/compare.ts"));
    expect(
      enclosingBody(compareSource, "export function benchCompare("),
      "benchCompare reads catalogQualificationStages",
    ).toContain("catalogQualificationStages");

    expect(
      readOrEmpty(join(REPO, "packages/agents/src/runbooks/promote-fastest-vision-model.ts")),
      "vision runbook reads qualificationStage",
    ).toContain("qualificationStage");
  });
});
