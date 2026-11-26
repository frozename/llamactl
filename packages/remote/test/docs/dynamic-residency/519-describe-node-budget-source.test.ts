import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  REPO,
  sectionBody,
  SECTIONS,
} from "./helpers.js";

// Part of #519.

describe("#519 describe node budget source", () => {
  // Kills: the docs omitting the read-out, or claiming the computed budget is always the named node's RAM.
  test("D1: the knobs section documents describe node budget-source output", () => {
    const section = flat(sectionBody(SECTIONS.knobs) ?? "");
    expectPins(section, "describe node budget source", [
      "`llamactl describe node <name>`",
      "`nodeBudget`",
      "`budgetSource`",
      "`safetyMarginRatio`",
      "`renderNodeBudget`",
      "`formatNodeBudgetSource`",
      "`(spec.budget.memoryGiB)`",
      "`(computed from node memory x safetyMarginRatio <r>)`",
      "` (default)`",
      "`llamactl.node.budget`",
      "older agent",
      "the memory of the process that answers",
    ]);
  });

  // Kills: the literals living in renderNodeBudget instead of the shared helper, a hand-rolled default marker, and nodeBudget resolving the ratio with a second resolver.
  test("D2: source pins route budget-source formatting and ratio resolution through shared helpers", () => {
    const h = readOrEmpty(join(REPO, "packages/cli/src/commands/noderun-helpers.ts"));
    const src = enclosingBody(h, "export function formatNodeBudgetSource(");
    expect(src).not.toBe("");
    expect(src).toContain("spec.budget.memoryGiB");
    expect(src).toContain("computed from node memory x ");
    expect(src).toContain("formatResidencyKnobs(");
    expect(src).toContain("formatNodeRunBudget(");
    expect(src).not.toContain(" (default)");

    const w = readOrEmpty(join(REPO, "packages/cli/src/commands/workload.ts"));
    const body = enclosingBody(w, "export function renderNodeBudget(");
    expect(body).not.toBe("");
    expect(body).toContain("formatNodeBudgetSource(");
    expect(body).toContain("budgetSource");
    expect(body).not.toContain("computed from node memory");
    expect(body).not.toContain("spec.budget.memoryGiB");

    const r = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const i = r.indexOf("nodeBudget: t.procedure");
    const j = r.indexOf("residencyStatus: t.procedure");
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(r.slice(i, j)).toContain("effectiveResidencyPolicy(");
    expect(r.slice(i, j)).toContain("budgetSource");

    const reads = readOrEmpty(join(REPO, "packages/mcp/src/tools/reads.ts"));
    expect(reads).toContain("budgetSource");
    expect(reads).toContain("process that answers");
  });
});
