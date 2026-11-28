import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");

describe("#518 scorer degraded tier doc", () => {
  test("D1: qualification docs pin degraded demotion semantics", () => {
    for (const needle of [
      "Bench scorers rank a degraded rel behind every healthy rel",
      "`summarizeBenchForMachine`",
      "falls back to the fastest degraded row only when the machine has no such row",
      "the `promote-fastest-vision-model` runbook ranks a degraded rel behind every healthy rel",
      "A degraded rel is demoted, not excluded",
    ]) {
      expect(q).toContain(needle);
    }
  });

  test("D2: scorer implementations mention the degraded tier", () => {
    expect(readOrEmpty(join(REPO, "packages/remote/src/config/embersynth.ts"))).toContain(
      '"degraded"',
    );
    expect(
      readOrEmpty(join(REPO, "packages/agents/src/runbooks/promote-fastest-vision-model.ts")),
    ).toContain('"degraded"');
  });
});
