import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #518
// Kills: dropping the docs, or unwiring the CLI from the core writer.
describe("#518 qualification apply writer doc", () => {
  test("overrides section documents the applied action and apply/unapply", () => {
    const overrides = flat(sectionBody(/^## Overrides/) ?? "");
    for (const needle of [
      "`applied`",
      "`llamactl qualification apply",
      "`llamactl qualification unapply",
      "a pin wins over an applied stage",
    ]) {
      expect(overrides, needle).toContain(needle);
    }
  });

  test("demotion section drops the pending-writer claim and names apply", () => {
    const demotion = flat(sectionBody(/^### Demotion/) ?? "");
    expect(demotion).not.toContain("writer consumers of the apply path are pending E-14");
    expect(demotion).toContain("`llamactl qualification apply");
  });

  test("the CLI and core writer are wired to writeAppliedStage", () => {
    const cli = readOrEmpty(join(REPO, "packages/cli/src/commands/qualification.ts"));
    expect(cli).toContain("writeAppliedStage(");
    const overrides = readOrEmpty(join(REPO, "packages/core/src/qualification/overrides.ts"));
    expect(overrides).toContain("export function writeAppliedStage");
  });

  // PR #823 review: kills restoring the claim that all three actions
  // reach the library-only checks. The doc quote must stay byte-for-byte
  // identical to the two guard lines in promotion.ts and demotion.ts.
  test("tsv-schemas limits the propose input to the freeze and pin rows", () => {
    const tsv = readOrEmpty(join(REPO, "docs/tsv-schemas.md"));
    expect(tsv).not.toContain("All three actions are consulted");
    const promotion = readOrEmpty(join(REPO, "packages/core/src/qualification/promotion.ts"));
    const demotion = readOrEmpty(join(REPO, "packages/core/src/qualification/demotion.ts"));
    for (const needle of [
      "if (overrides?.freeze !== undefined)",
      "if (overrides?.pin !== undefined)",
    ]) {
      expect(tsv, needle).toContain(needle);
      expect(promotion, needle).toContain(needle);
      expect(demotion, needle).toContain(needle);
    }
    expect(tsv).toContain("`declaredFor`");
  });

  // PR #823 review: kills the claim that the `list` text output reports
  // the applied row, and pins the applied: null json contract.
  test("the operator surface doc scopes the applied row to the json outputs", () => {
    const overrides = flat(sectionBody(/^## Overrides/) ?? "");
    expect(overrides).not.toContain(
      "`llamactl qualification status <rel>` and `llamactl qualification list` report the catalog stage",
    );
    expect(overrides).toContain("`null` when absent, consistent with pin and freeze");
    expect(overrides).toContain("the `list` text output omits the applied row");
  });
});
