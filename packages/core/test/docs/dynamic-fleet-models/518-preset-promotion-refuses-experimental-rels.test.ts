import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #518 slice (a): preset promotion refuses experimental rels.
// Kills: the doc paragraph missing, or a guard that does not read
// catalogQualificationStages.
describe("#518 preset promotion refuses experimental rels", () => {
  test("qualification section documents the preset-promotion refusal", () => {
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    for (const needle of [
      "never as a preset default",
      "`writePresetOverride` (`packages/core/src/presets.ts`)",
      "`llamactl catalog promote`",
      "`llamactl.catalog.promote`",
      "`catalogQualificationStages`",
    ]) {
      expect(q, needle).toContain(needle);
    }
    expect(
      readOrEmpty(join(REPO, "packages/core/src/presets.ts")),
      "presets.ts reads catalogQualificationStages",
    ).toContain("catalogQualificationStages");
  });
});
