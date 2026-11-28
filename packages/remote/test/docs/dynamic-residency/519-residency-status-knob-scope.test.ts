import { describe, test } from "bun:test";
import { join } from "node:path";

import { expectPins, flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #519: the docs and implementation surfaces must agree that
// residencyStatus carries plural knob-scope warnings, the CLI renders each as
// a Warning line, and the MCP projection exposes the field.
describe("#519 residency status knob scope", () => {
  test("D1: the knobs section documents knobScopeWarnings and their status rendering", () => {
    expectPins(flat(sectionBody(SECTIONS.knobs) ?? ""), "knobs", [
      "`knobScopeWarnings`",
      "`llamactl residency status --node <name>` prints each as a `Warning:` line",
      "`llamactl.residency.status`",
    ]);
  });

  test("D2: source pins wire the mismatch helper through remote, CLI and MCP", () => {
    const procedures = readOrEmpty(join(REPO, "packages/remote/src/residency/procedures.ts"));
    expectPins(procedures, "procedures", ["nodeRunKnobScopeMismatch(", "knobScopeWarnings"]);

    const cli = readOrEmpty(join(REPO, "packages/cli/src/commands/residency.ts"));
    expectPins(cli, "cli", ["knobScopeWarnings"]);

    const mcp = readOrEmpty(join(REPO, "packages/mcp/src/tools/residency.ts"));
    expectPins(mcp, "mcp", ["knobScopeWarnings"]);
  });
});
