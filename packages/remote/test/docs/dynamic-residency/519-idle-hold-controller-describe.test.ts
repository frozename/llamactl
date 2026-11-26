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
// Kills: the docs omitting the controller/describe idle-hold read-out, the
// controller literal moving out of reportOutcome, or describe renderers not
// sharing formatIdleHoldLine.
describe("#519 idle-hold controller and describe read-out", () => {
  test("D1: operator idle-eviction section documents the controller and describe lines", () => {
    const section = flat(sectionBody(SECTIONS.operatorIdleEviction) ?? "");

    expectPins(section, "idle-hold controller/describe", [
      "`llamactl controller serve`",
      "`reportOutcome`",
      "`unchanged (idle-evicted at <iso> via llamactl.io/idle-evicted-at; run llamactl residency release-idle <workload> to resume)`",
      "`llamactl describe workload <name>`",
      "`formatIdleHoldLine`",
      "`IdleHold:`",
      "the controller keeps it down until llamactl residency release-idle <workload>",
      "inactive while the workload is disabled",
    ]);
  });

  test("D2: controller and describe source pins keep the literals in the pinned functions", () => {
    const controller = readOrEmpty(join(REPO, "packages/cli/src/commands/controller.ts"));
    const reportOutcome = enclosingBody(controller, "function reportOutcome(");
    expect(reportOutcome).not.toBe("");
    expect(reportOutcome).toContain("idleEvictedAt");
    expect(reportOutcome).toContain("workloadReconciler.IDLE_EVICTED_AT_ANNOTATION");
    expect(reportOutcome).toContain("release-idle");
    expect(controller).toMatch(/type ReportForLog = Pick<[^;]*"idleEvictedAt"/);

    const workload = readOrEmpty(join(REPO, "packages/cli/src/commands/workload.ts"));
    const formatIdleHoldLine = enclosingBody(workload, "export function formatIdleHoldLine(");
    expect(formatIdleHoldLine).not.toBe("");
    expect(formatIdleHoldLine).toContain("workloadReconciler.IDLE_EVICTED_AT_ANNOTATION");
    expect(formatIdleHoldLine).toContain("release-idle");
    expect(formatIdleHoldLine).toContain("inactive while the workload is disabled");
    expect(enclosingBody(workload, "async function runDescribeWorkload(")).toContain(
      "formatIdleHoldLine(",
    );
    expect(enclosingBody(workload, "async function runDescribeModelHost(")).toContain(
      "formatIdleHoldLine(",
    );
  });
});
