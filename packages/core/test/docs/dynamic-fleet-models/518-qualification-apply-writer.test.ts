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
});
