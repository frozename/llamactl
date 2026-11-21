import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #518 slice (b): the preset read-path skip.
// Kills: the doc paragraph missing, or a resolvePreset guard that does not
// read catalogQualificationStages.
describe("#518 preset resolution skips experimental rels", () => {
  test("qualification section documents the preset read-path skip", () => {
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    for (const needle of [
      "`resolvePreset` skips an env or file preset override whose rel is experimental",
      "falls through to the next layer",
      "`skippedExperimental`",
      "the builtin default is returned even when it is pinned experimental",
    ]) {
      expect(q, needle).toContain(needle);
    }
    expect(
      enclosingBody(
        readOrEmpty(join(REPO, "packages/core/src/presets.ts")),
        "export function resolvePreset(",
      ),
      "resolvePreset reads catalogQualificationStages",
    ).toContain("catalogQualificationStages");
  });
});
