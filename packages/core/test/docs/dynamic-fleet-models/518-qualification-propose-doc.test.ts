import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #518
// Kills: dropping the doc paragraph, leaving the stale "no router, catalog,
// lifecycle or CLI code calls them" claim, unwiring the CLI from
// evaluateQualification, or dropping the strict evidence schema.
describe("#518 qualification propose doc", () => {
  test("demotion section documents the read-only propose CLI", () => {
    const dem = flat(sectionBody(/^### Demotion/) ?? "");
    for (const needle of [
      "`llamactl qualification propose",
      "`PromotionEvidenceSchema`",
      "`parsePromotionEvidence`",
    ]) {
      expect(dem, needle).toContain(needle);
    }
    expect(dem).not.toContain("no router, catalog, lifecycle or CLI code calls them");
    expect(dem.toLowerCase()).toContain("library-only");
  });

  test("propose CLI and evidence schema are wired in source", () => {
    const cli = readOrEmpty(join(REPO, "packages/cli/src/commands/qualification.ts"));
    for (const needle of [
      "parsePromotionEvidence(",
      "evaluateQualification(",
      "applyQualification(",
    ]) {
      expect(cli, needle).toContain(needle);
    }
    const promotion = readOrEmpty(join(REPO, "packages/core/src/qualification/promotion.ts"));
    for (const needle of [
      "export const PromotionEvidenceSchema",
      "export function parsePromotionEvidence",
    ]) {
      expect(promotion, needle).toContain(needle);
    }
  });
});
