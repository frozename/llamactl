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
    // Pins the compositeApply wet-run wiring as EXACT full lines (leading
    // indentation and trailing comma included) so the gate's mutants die:
    // reassigning `workloadsDir` to a bogus path, and the `nodeRunBudgetGiB(...)
    // && undefined` / `nodeRunResidency(...) && undefined` short-circuits, all
    // leave the previous substring intact yet change behaviour. A whole-line
    // equality match, not a substring, is what forces `&& undefined` and the
    // `workloadsDir` swap to fail the pin.
    const src = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const start = src.indexOf("compositeApply: t.procedure");
    const end = src.indexOf("compositeDestroy: t.procedure");
    expect(start, "compositeApply: t.procedure not found").toBeGreaterThanOrEqual(0);
    expect(end, "compositeDestroy: t.procedure not found").toBeGreaterThan(start);
    const lines = src.slice(start, end).split("\n");
    const pins = [
      "        const workloadsDir = workloadStoreMod.defaultWorkloadsDir();",
      "        const result = await applyComposite({",
      "          getNodeBudgetGiB: (nodeName) => nodeRunBudgetGiB(nodeName, workloadsDir),",
      "          getNodeResidency: (nodeName) => nodeRunResidency(nodeName, workloadsDir),",
    ];
    for (const pin of pins) {
      expect(lines, `compositeApply slice line ${pin}`).toContain(pin);
    }
  });

  test("D3: explicit NodeRun budget still wins on the ModelHost verified path", () => {
    // applyComposite charges workloads through applyOne, but the sibling
    // resolveModelHostBudgetGiB keeps its own copy of the "explicit wins once
    // verified" rule. The gate's `residency ? verified : (explicit ?? verified)`
    // mutant lands there and no composite path reaches it, so pin the exact
    // line scoped to that function. Line 2274 in resolveAdmissionBudgetGiB is
    // byte-identical, so the slice must exclude it; anchoring the start on the
    // function signature and the end on the next top-level binding does that.
    const src = readOrEmpty(join(REPO, "packages/remote/src/workload/apply.ts"));
    const start = src.indexOf("async function resolveModelHostBudgetGiB(");
    const end = src.indexOf("const NO_VERIFIED_EVICT_VICTIMS");
    expect(start, "resolveModelHostBudgetGiB not found").toBeGreaterThanOrEqual(0);
    expect(end, "resolveModelHostBudgetGiB end anchor not found").toBeGreaterThan(start);
    const lines = src.slice(start, end).split("\n");
    expect(lines).toContain("    return explicit ?? verified;");
    expect(src.slice(start, end)).not.toContain("residency ? verified : (explicit ?? verified)");
  });
});
