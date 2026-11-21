import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #519.
// Kills: shipping the controller-reconcile min-residency wiring
// undocumented, or reverting the getNodeResidency forward in
// reconcileModelRun.
describe("#519 controller reconcile evict minResidencySeconds", () => {
  test("D1: the knobs section documents the reconcile-pass residency forward", () => {
    const knobs = flat(sectionBody(SECTIONS.knobs) ?? "");
    expect(knobs).toContain("controller reconcile pass forwards");
    expect(knobs).toContain("`reconcileModelRun`");
  });

  test("D2: reconcileModelRun forwards getNodeResidency to applyOne", () => {
    const body = enclosingBody(
      readOrEmpty(join(REPO, "packages/remote/src/workload/reconciler.ts")),
      "async function reconcileModelRun(",
    );
    expect(body).toContain(
      "getNodeResidency: (nodeName) => nodeBudget.residencyByName.get(nodeName)",
    );
  });
});
