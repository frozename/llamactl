import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  REPO,
  RESIDENCY_CLI,
  sectionBody,
  SECTIONS,
} from "./helpers.js";

// Part of #519
// Kills: shipping the cooldown-charged and operational-tier read-out
// undocumented, or leaving the CLI renderer body or the MCP tool
// description stale.
describe("#519 residency status ranking cooldown", () => {
  test("knobs section documents the cooldown-charged and tier fields", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    expectPins(knobs, "ranking cooldown status", [
      "`cooldownCharged`",
      "`drainTier`",
      "`degradedTier`",
      "`cooldown charged: <workload> for <t>`",
      "`drain tier: <workloads>`",
      "`degraded tier: <workloads>`",
      "`disabled` when every ranking knob is 0",
      "`resident` and `drainCharged` are empty when `residentPreference` and `coldLoadPenaltyMs` are both 0",
    ]);
  });

  test("the CLI renderer prints the cooldown and tier lines", () => {
    const body = enclosingBody(readOrEmpty(RESIDENCY_CLI), "function pushRankingLines(");
    expect(body).not.toBe("");
    expect(body).toContain("cooldown charged:");
  });

  test("the MCP residency status description covers the ranking section", () => {
    const src = readOrEmpty(join(REPO, "packages/mcp/src/tools/residency.ts"));
    expect(src).toContain("The ranking section");
  });
});
