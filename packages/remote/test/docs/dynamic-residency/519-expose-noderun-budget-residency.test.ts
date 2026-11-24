import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #519. Kills: the knobs section not documenting the expose charge,
// or applyExposeManifest not wiring the NodeRun budget/residency lookups.
describe("#519 expose NodeRun budget/residency", () => {
  test("D1: knobs section documents the expose workload charge", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    for (const pin of [
      "`llamactl expose`",
      "`applyExposeManifest`",
      "charged the same NodeRun admission budget",
    ]) {
      expect(knobs, `knobs section pin ${pin}`).toContain(pin);
    }
  });

  test("D2: applyExposeManifest wires the NodeRun budget and residency lookups", () => {
    // Indentation-insensitive: the pins are matched against trimmed lines so
    // reformatting cannot dodge them, while the `&& undefined` short-circuit
    // and dropped-wiring mutants still change the line content and die.
    const src = readOrEmpty(join(REPO, "packages/cli/src/commands/expose.ts"));
    const start = src.indexOf("async function applyExposeManifest(");
    const end = src.indexOf("async function fetchAdvertisedEndpoint(");
    expect(start, "applyExposeManifest not found").toBeGreaterThanOrEqual(0);
    expect(end, "fetchAdvertisedEndpoint not found").toBeGreaterThan(start);
    const lines = src
      .slice(start, end)
      .split("\n")
      .map((line) => line.trim());
    expect(lines).toContain("getNodeBudgetGiB: nodeRunBudgetLookup(deps.listNodeRuns),");
    expect(lines).toContain("getNodeResidency: nodeRunResidencyLookup(deps.listNodeRuns),");
  });
});
