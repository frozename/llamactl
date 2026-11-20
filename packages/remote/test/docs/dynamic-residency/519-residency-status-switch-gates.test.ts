import { describe, expect, test } from "bun:test";

import {
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  RESIDENCY_CLI,
  sectionBody,
  SECTIONS,
} from "./helpers.js";

// Part of #519
// Kills: the docs not describing the switch-gates status read-out, or the CLI
// renderer being renamed or removed.
describe("#519 residency status switch gates", () => {
  test("knobs section documents the switchGates status block", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    expectPins(knobs, "switchGates status", [
      "`switchGates`",
      "`Switch gates: cooldown <c>s, min residency <m>s (advisory; scope: serving-process)`",
      "`cooldown: active for <t>`",
      "`cooldown: clear (no recorded switch)`",
      "`held MinResidency for <t>`",
      "`min residency met`",
      "`Switch gates: disabled (scope: serving-process)`",
      "`Switch gates: unavailable (<detail>; scope: serving-process)`",
      "`pushSwitchGateLines`",
      "only if the target profile would evict it",
    ]);
    const body = enclosingBody(readOrEmpty(RESIDENCY_CLI), "function pushSwitchGateLines(");
    expect(body).not.toBe("");
    expect(body).toContain("SWITCH_GATES_UNAVAILABLE[");
  });
});
