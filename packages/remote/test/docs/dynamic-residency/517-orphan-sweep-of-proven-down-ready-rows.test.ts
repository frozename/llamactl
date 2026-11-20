import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { INTERRUPTED_LIFECYCLE_STATES } from "../../../src/residency/boot-recovery.js";
import { flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #517
// Kills: missing doc sentence, `ready` added to the claimed-pass state set
// (INTERRUPTED_LIFECYCLE_STATES grows a fifth state or ORPHAN_LIFECYCLE_STATES
// loses "ready"), and a stale header comment still claiming ready rows are
// remaining scope.
describe("#517 orphan sweep of proven-down ready rows", () => {
  test("cancel and crash recovery documents the ready-row orphan sweep", () => {
    const c = flat(sectionBody(SECTIONS.cancelRecovery) ?? "");
    expect(c).toContain(
      "The same outside-a-switch sweep also moves a `ready` lifecycle row to `failed` once it has made no progress for 30 minutes and `directWorkloadProvenDown` proves its workload down (for example an engine that crashed, or a host that rebooted, while its row read `ready`); the claimed profile-switch pass never touches `ready` rows.",
    );

    const bootRecovery = readOrEmpty(join(REPO, "packages/remote/src/residency/boot-recovery.ts"));
    const orphanStart = bootRecovery.indexOf("export const ORPHAN_LIFECYCLE_STATES");
    expect(orphanStart, "ORPHAN_LIFECYCLE_STATES export").toBeGreaterThanOrEqual(0);
    const orphanDecl = bootRecovery.slice(orphanStart, bootRecovery.indexOf(";", orphanStart));
    expect(orphanDecl).toContain('"ready"');
    expect([...INTERRUPTED_LIFECYCLE_STATES].sort()).toEqual([
      "draining",
      "loading",
      "unloading",
      "warming",
    ]);
    expect(bootRecovery).not.toContain("Still remaining: `ready` rows");
  });
});
