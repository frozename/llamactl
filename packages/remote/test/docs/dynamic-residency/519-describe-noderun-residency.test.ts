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

describe("#519 describe noderun residency", () => {
  // Kills: the docs omitting the describe noderun read-out.
  test("D1: the knobs section documents describe noderun residency output", () => {
    const section = flat(sectionBody(SECTIONS.knobs) ?? "");
    expectPins(section, "describe noderun residency", [
      "`llamactl describe noderun <name>`",
      "`Residency:`",
      "`Budget:`",
      "`formatResidencyKnobs`",
      "`effectiveResidencyPolicy`",
      "`computed from node memory x safetyMarginRatio`",
      "`<n> GiB (spec.budget.memoryGiB)`",
      "`effectivePolicy`",
      "without a reachable agent",
    ]);
  });

  // Kills: a second formatter diverging from residency status, or the literals moving out of the pinned helpers.
  test("D2: source pins name the describe and shared formatting helpers", () => {
    const workloadSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/workload.ts"));
    const describeNodeRun = enclosingBody(workloadSrc, "async function runDescribeNodeRun(");
    expect(describeNodeRun).not.toBe("");
    expect(describeNodeRun).toContain("effectiveResidencyPolicy(");
    expect(describeNodeRun).toContain("formatResidencyKnobs(");
    expect(describeNodeRun).toContain("formatNodeRunBudget(");
    expect(describeNodeRun).toContain("Residency:  ");
    expect(describeNodeRun).toContain("effectivePolicy");

    const helperSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/noderun-helpers.ts"));
    const formatResidency = enclosingBody(helperSrc, "export function formatResidencyKnobs(");
    expect(formatResidency).not.toBe("");
    expect(formatResidency).toContain(" (default)");
    const formatBudget = enclosingBody(helperSrc, "export function formatNodeRunBudget(");
    expect(formatBudget).not.toBe("");
    expect(formatBudget).toContain("spec.budget.memoryGiB");
    expect(formatBudget).toContain("computed from node memory x safetyMarginRatio");

    const residencyCliSrc = readOrEmpty(RESIDENCY_CLI);
    const pushEffectivePolicy = enclosingBody(residencyCliSrc, "function pushEffectivePolicyLine(");
    expect(pushEffectivePolicy).toContain("formatResidencyKnobs(");
    expect(pushEffectivePolicy).not.toContain(" (default)");

    const remoteIndex = readOrEmpty(join(REPO, "packages/remote/src/index.ts"));
    expect(remoteIndex).toMatch(
      /export \{[^}]*effectiveResidencyPolicy[^}]*\} from "\.\/residency\/procedures\.js"/,
    );
  });
});
