import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #519. Kills: composite apply skipping NodeRun budget/residency, or
// compositeApply not wiring the lookups.
describe("#519 composite apply NodeRun budget/residency", () => {
  test("D1: knobs section documents the composite workload charge", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    for (const pin of [
      "`compositeApply`",
      "`applyWorkloadComponent`",
      "composite workload is charged",
    ]) {
      expect(knobs, `knobs section pin ${pin}`).toContain(pin);
    }
  });

  test("D2: compositeApply wires the NodeRun budget and residency lookups", () => {
    const src = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const start = src.indexOf("compositeApply: t.procedure");
    const end = src.indexOf("compositeDestroy: t.procedure");
    expect(start, "compositeApply: t.procedure not found").toBeGreaterThanOrEqual(0);
    expect(end, "compositeDestroy: t.procedure not found").toBeGreaterThan(start);
    const slice = src.slice(start, end);
    for (const pin of [
      "getNodeBudgetGiB: (nodeName) => nodeRunBudgetGiB(nodeName, workloadsDir)",
      "getNodeResidency: (nodeName) => nodeRunResidency(nodeName, workloadsDir)",
    ]) {
      expect(slice, `compositeApply slice pin ${pin}`).toContain(pin);
    }
  });
});
