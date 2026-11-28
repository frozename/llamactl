import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #518: recommendations expose the preset skip audit trail.
describe("#518 recommendations copy skippedExperimental", () => {
  test("qualification section documents recommendation-row skips and CLI output", () => {
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    for (const needle of [
      "`recommendationsForProfile` copies `skippedExperimental` onto each recommendation row",
      "`skipped-experimental=<source>:<rel>`",
      "`llamactl recommendations`",
    ]) {
      expect(q, needle).toContain(needle);
    }
  });

  test("recommendationsForProfile reads skippedExperimental from preset resolution", () => {
    expect(
      enclosingBody(
        readOrEmpty(join(REPO, "packages/core/src/recommendations.ts")),
        "export function recommendationsForProfile(",
      ),
    ).toContain("skippedExperimental");
  });
});
