import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #518 slice: the /v1/models declared-listing qualification flags.
// Kills: the doc paragraph missing, or either listing function not reading
// catalogQualificationStages.
describe("#518 models listing qualification flags", () => {
  test("qualification section documents the /v1/models declared-listing stages", () => {
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    for (const needle of [
      "`/v1/models?include=declared` reads the same stages",
      "each `unavailable` entry's `qualification.stage` is the routing stage from `catalogQualificationStages`",
      "a `declared` entry whose id's routing stage is experimental carries `experimental: true`",
      "Neither array is routable, so the flags only report",
    ]) {
      expect(q, needle).toContain(needle);
    }
    const src = readOrEmpty(join(REPO, "packages/core/src/openaiProxy.ts"));
    expect(
      enclosingBody(src, "function unavailableModelEntries("),
      "unavailableModelEntries reads catalogQualificationStages",
    ).toContain("catalogQualificationStages");
    expect(
      enclosingBody(src, "function declaredModelInfos("),
      "declaredModelInfos reads catalogQualificationStages",
    ).toContain("catalogQualificationStages");
  });
});
