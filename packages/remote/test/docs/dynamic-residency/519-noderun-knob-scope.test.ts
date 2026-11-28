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

// Part of #519

describe("#519 noderun knob scope", () => {
  // Kills: the docs omitting how node-scoped knobs behave on an infra NodeRun.
  test("D1: the knobs section documents the NodeRun name/node scope rule", () => {
    const section = flat(sectionBody(SECTIONS.knobs) ?? "");
    expectPins(section, "noderun knob scope", [
      "`nodeRunKnobScopeMismatch`",
      "`metadata.name`",
      "`spec.node`",
      "`apply: NodeRun manifest rejected:`",
      "`Warning:`",
      "`knobScopeWarning`",
      "keyed by",
    ]);
  });

  // Kills: the helper existing in docs only, or one CLI surface skipping it.
  test("D2: source pins name the shared mismatch helper at apply and describe", () => {
    const workloadSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/workload.ts"));
    const applyNodeRun = enclosingBody(workloadSrc, "async function applyNodeRunFromRaw(");
    expect(applyNodeRun).not.toBe("");
    expect(applyNodeRun).toContain("nodeRunKnobScopeMismatch(");

    const describeNodeRun = enclosingBody(workloadSrc, "async function runDescribeNodeRun(");
    expect(describeNodeRun).not.toBe("");
    expect(describeNodeRun).toContain("nodeRunKnobScopeMismatch(");

    const schemaSrc = readOrEmpty(join(REPO, "packages/remote/src/workload/noderun-schema.ts"));
    expect(schemaSrc).toContain("export function nodeRunKnobScopeMismatch(");
  });
});
