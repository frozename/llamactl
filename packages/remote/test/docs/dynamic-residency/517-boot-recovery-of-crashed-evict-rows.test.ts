import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { flat, readOrEmpty, REPO, sectionBody, SECTIONS } from "./helpers.js";

// Part of #517
// Kills: missing or reworded evict-row boot-recovery sentences in
// docs/dynamic-residency.md, a stale "no boot recovery yet" claim left in
// the doc or the boot-recovery / recovery / eviction-operation / apply
// sources, or the `evict:` classifier constants missing from recovery.ts.
describe("#517 boot recovery of crashed evict: rows", () => {
  test("cancel and crash recovery documents evict-row boot recovery", () => {
    const c = flat(sectionBody(SECTIONS.cancelRecovery) ?? "");
    for (const needle of [
      "When no `profile-switch:` row is nonterminal, boot recovery first finishes a crashed eviction's `evict:` operation rows: an `evict:<victim>` row whose `targetState` reads `evicted-by:<replacement>` and that has made no progress for 30 minutes is finished `unknown` with detail `recovered: interrupted-unverified (was <phase>)` under a claim of the apply-profile fence, and the outside-a-switch sweep then runs in the same boot.",
      "A younger `evict:` row defers the whole eviction pass, and a malformed `evict:` row is never finished, so either still keeps the outside-a-switch sweep off; the victim's `llamactl.io/evicted-by` manifest marker is left in place.",
      'When it finished or failed to finish at least one `evict:` row, the agent logs `[residency] eviction boot recovery {"recovered":N,"recordFailures":M}` before any lifecycle line, with counts only and no victim or replacement names (#517).',
    ]) {
      expect(c, needle).toContain(needle);
    }
    expect(c).not.toContain("operation rows have no boot recovery yet");

    const bootRecovery = readOrEmpty(join(REPO, "packages/remote/src/residency/boot-recovery.ts"));
    for (const pin of [
      "[residency] eviction boot recovery ",
      "[residency] eviction boot recovery failed: ",
    ]) {
      expect(bootRecovery, pin).toContain(pin);
    }
    expect(bootRecovery).not.toContain("`evict:` rows have no boot recovery yet");

    const recovery = readOrEmpty(join(REPO, "packages/remote/src/residency/recovery.ts"));
    for (const pin of ['const EVICT_PREFIX = "evict:";', '"evicted-by:"']) {
      expect(recovery, pin).toContain(pin);
    }

    expect(
      readOrEmpty(join(REPO, "packages/remote/src/residency/eviction-operation.ts")),
    ).not.toContain("until `evict:` recovery exists (follow-up)");
    expect(readOrEmpty(join(REPO, "packages/remote/src/workload/apply.ts"))).not.toContain(
      "(`evict:` recovery is a follow-up)",
    );
  });
});
