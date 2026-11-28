import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #518: the /v1/models degraded report-only flags.
describe("#518 models listing degraded flag", () => {
  test("D1: qualification section documents the degraded listing flags", () => {
    const q = flat(sectionBody(/^## Qualification and promotion/) ?? "");
    for (const needle of [
      "a `data` entry whose winning route is degraded carries `degraded: true`",
      "a `declared` entry whose id's routing stage is degraded carries `degraded: true`",
      "an experimental route or stage never also carries `degraded`",
      "only when no healthy route serves the id",
    ]) {
      expect(q, needle).toContain(needle);
    }
  });

  test("D2: both model listing builders join the degraded route stage", () => {
    const src = readOrEmpty(join(REPO, "packages/core/src/openaiProxy.ts"));
    expect(
      enclosingBody(src, "function buildListOpenAIModels("),
      "buildListOpenAIModels reads the degraded route predicate",
    ).toContain("isDegradedRoute");
    expect(
      enclosingBody(src, "function declaredModelInfos("),
      "declaredModelInfos emits the degraded flag",
    ).toContain('"degraded"');
  });
});
