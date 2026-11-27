// Part of #522

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { RESIDENCY_TRANSITIONS } from "../../../src/residency/lifecycle.js";
import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

const PARA_KEEPALIVE =
  "Since #847 (Part of #517) the detached keep-alive worker records its own row through the same wrapper: `keepAliveRecordedStart` and `keepAliveRecordedStop` (`packages/cli/src/commands/keepAlive.ts`) wrap the worker's engine start in `runDirectResidencyStart` and its worker-exit stop in `runDirectResidencyStop`. The row is keyed by the keep-alive target as given, not the resolved rel, and the start takes its group from the catalog `residencyGroup` of the rel being started, so a failed start leaves the row `failed` with that group and only a confirmed stop walks it to `downloaded`. A keep-alive target has no ModelRun or ModelHost manifest, so `directWorkloadProvenDown` (`packages/remote/src/router.ts`) proves it down through `keepAliveWorkloadProvenDown` (see [dynamic-residency.md](dynamic-residency.md#direct-modelhost-start-and-stop)).";
const PARA_READY =
  "The outside-a-switch pass also moves a stale `ready` row to `failed` over the legal `ready` -> `failed` edge once it has made no progress for 30 minutes and its workload is proven down, for example an engine that crashed, or a host that rebooted, while its row read `ready`; the claimed pass never touches `ready` rows (`ORPHAN_LIFECYCLE_STATES` in `packages/remote/src/residency/boot-recovery.ts` is `INTERRUPTED_LIFECYCLE_STATES` plus `ready`). The agent passes `directWorkloadProvenDown` as the proven-down predicate, and without one the pass fails closed and never opens the store. A `ready` row younger than the window, or one beside any nonterminal operation row, stays `ready` until a later boot.";

function sliceThrough(src: string, startNeedle: string, endNeedle: string): string {
  const start = src.indexOf(startNeedle);
  if (start === -1) return "";
  const end = src.indexOf(endNeedle, start + startNeedle.length);
  return end === -1 ? "" : src.slice(start, end + endNeedle.length);
}

function occurrenceCount(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

function citedPackagePaths(text: string): string[] {
  return [...text.matchAll(/`(packages\/[^`\s]+\.ts)`/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe("#522 lifecycle keep-alive writer and ready sweep", () => {
  const S = flat(sectionBody(/^#{2,} .*residency lifecycle states/i) ?? "");
  const cli = readOrEmpty(join(REPO, "packages/cli/src/commands/keepAlive.ts"));
  const core = readOrEmpty(join(REPO, "packages/core/src/keepAlive.ts"));
  const router = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
  const boot = readOrEmpty(join(REPO, "packages/remote/src/residency/boot-recovery.ts"));
  const serve = readOrEmpty(join(REPO, "packages/remote/src/server/serve.ts"));

  // Kills: dropping the #847 writer paragraph; unwrapping
  // keepAliveRecordedStart/Stop from runDirectResidencyStart/Stop; keying the
  // row by the rel instead of o.key.name; dropping the catalog group lookup;
  // unwiring the worker's start/stop seams; removing the keep-alive fallback
  // from directWorkloadProvenDown.
  test("keep-alive worker lifecycle writer (#847)", () => {
    const recordedStart = flat(enclosingBody(cli, "async function keepAliveRecordedStart("));
    expect(recordedStart, "runDirectResidencyStart(").toContain("runDirectResidencyStart(");
    expect(recordedStart, "o.key.name").toContain("o.key.name");
    expect(recordedStart, "catalog.findByRel(o.target)?.residencyGroup").toContain(
      "catalog.findByRel(o.target)?.residencyGroup",
    );

    const recordedStop = flat(enclosingBody(cli, "async function keepAliveRecordedStop("));
    expect(recordedStop, "runDirectResidencyStop(").toContain("runDirectResidencyStop(");
    expect(recordedStop, "ok: s.stopped").toContain("ok: s.stopped");

    const workerCommand = flat(enclosingBody(cli, "async function runWorker("));
    expect(workerCommand, "start: keepAliveRecordedStart,").toContain(
      "start: keepAliveRecordedStart,",
    );
    expect(workerCommand, "stop: keepAliveRecordedStop,").toContain("stop: keepAliveRecordedStop,");

    const worker = flat(enclosingBody(core, "export async function runKeepAliveWorker("));
    expect(worker, "(opts.start ?? startServer)({").toContain("(opts.start ?? startServer)({");
    expect(worker, "target: rel,").toContain("target: rel,");

    const provenDown = flat(enclosingBody(router, "export function directWorkloadProvenDown("));
    expect(provenDown, "return keepAliveWorkloadProvenDown(model);").toContain(
      "return keepAliveWorkloadProvenDown(model);",
    );

    const residencyHeadings = readOrEmpty(join(REPO, "docs/dynamic-residency.md"))
      .split("\n")
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) =>
        line
          .replace(/^#+ /, "")
          .trim()
          .toLowerCase()
          .replaceAll(/[^a-z0-9 -]/g, "")
          .replaceAll(" ", "-"),
      );
    expect(residencyHeadings, "direct-modelhost-start-and-stop").toContain(
      "direct-modelhost-start-and-stop",
    );

    expect(S, "PARA_KEEPALIVE").toContain(PARA_KEEPALIVE);
  });

  // Kills: dropping the ready-row sentence; removing "ready" from
  // ORPHAN_LIFECYCLE_STATES or adding it to INTERRUPTED_LIFECYCLE_STATES (the
  // claimed pass would then fail live ready rows); switching claimAndFailOrphans
  // back to the default states; changing the 30-minute window; letting the
  // orphan pass run beside a nonterminal operation row; unwiring the agent's
  // proven-down predicate.
  test("orphan boot sweep fails stale proven-down ready rows", () => {
    expect(RESIDENCY_TRANSITIONS.ready, 'RESIDENCY_TRANSITIONS.ready contains "failed"').toContain(
      "failed",
    );

    const interrupted = sliceThrough(boot, "export const INTERRUPTED_LIFECYCLE_STATES", "]);");
    for (const needle of ['"loading"', '"warming"', '"draining"', '"unloading"']) {
      expect(interrupted, needle).toContain(needle);
    }
    expect(interrupted, 'INTERRUPTED_LIFECYCLE_STATES excludes "ready"').not.toContain('"ready"');

    const orphan = sliceThrough(boot, "export const ORPHAN_LIFECYCLE_STATES", "]);");
    expect(orphan, "...INTERRUPTED_LIFECYCLE_STATES,").toContain(
      "...INTERRUPTED_LIFECYCLE_STATES,",
    );
    expect(orphan, '"ready"').toContain('"ready"');

    expect(boot, "PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS = 30 * 60_000").toContain(
      "PROFILE_SWITCH_BOOT_RECOVERY_MIN_AGE_MS = 30 * 60_000",
    );

    const staleOrphan = flat(enclosingBody(boot, "function isStaleOrphan("));
    expect(
      staleOrphan,
      "ORPHAN_LIFECYCLE_STATES.has(row.state) && now - row.updatedAtMs >= minStaleAgeMs",
    ).toContain("ORPHAN_LIFECYCLE_STATES.has(row.state) && now - row.updatedAtMs >= minStaleAgeMs");

    const claimAndFail = flat(enclosingBody(boot, "function claimAndFailOrphans("));
    expect(claimAndFail, "ORPHAN_LIFECYCLE_STATES,").toContain("ORPHAN_LIFECYCLE_STATES,");

    const scan = flat(enclosingBody(boot, "function scanWithStore("));
    expect(scan, "failInterruptedLifecycleRows(store, fence.fenceToken, nowMs());").toContain(
      "failInterruptedLifecycleRows(store, fence.fenceToken, nowMs());",
    );
    expect(scan, "scanWithStore excludes ORPHAN_LIFECYCLE_STATES").not.toContain(
      "ORPHAN_LIFECYCLE_STATES",
    );

    const failInterrupted = flat(enclosingBody(boot, "function failInterruptedLifecycleRows("));
    expect(failInterrupted, "states: ReadonlySet<string> = INTERRUPTED_LIFECYCLE_STATES").toContain(
      "states: ReadonlySet<string> = INTERRUPTED_LIFECYCLE_STATES",
    );

    const orphanSweep = flat(enclosingBody(boot, "function sweepOrphanedLifecycleRows("));
    expect(orphanSweep, "if (nonterminal.length !== 0 || lifecycle === undefined) {").toContain(
      "if (nonterminal.length !== 0 || lifecycle === undefined) {",
    );
    expect(orphanSweep, "if (provenDown.size === 0) {").toContain("if (provenDown.size === 0) {");

    expect(
      occurrenceCount(serve, "runProfileSwitchBootRecovery({"),
      "runProfileSwitchBootRecovery({",
    ).toBe(1);
    const bootRecoveryCall = sliceThrough(serve, "runProfileSwitchBootRecovery({", "});");
    expect(bootRecoveryCall, "isProvenDown: directWorkloadProvenDown,").toContain(
      "isProvenDown: directWorkloadProvenDown,",
    );

    expect(S, "PARA_READY").toContain(PARA_READY);
  });

  // Kills: stale line-number citations or a moved or misspelled path.
  test("no file:line citations; cited paths exist", () => {
    expect(PARA_KEEPALIVE, "PARA_KEEPALIVE must not match /.ts:\\d/").not.toMatch(/\.ts:\d/);
    expect(PARA_READY, "PARA_READY must not match /.ts:\\d/").not.toMatch(/\.ts:\d/);

    for (const path of [...citedPackagePaths(PARA_KEEPALIVE), ...citedPackagePaths(PARA_READY)]) {
      expect(readOrEmpty(join(REPO, path)).length, path).toBeGreaterThan(0);
    }
  });
});
