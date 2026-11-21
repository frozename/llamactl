import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readdirSync } from "../../../src/safe-fs.js";
import { enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #522
// Kills: shipping the disable stop-fence refusal undocumented in the
// exclusive-window runbook, wiring stopDisabledWorkload without the doc,
// or regressing the ModelHost refusal path / residency CLI surface the
// prose cites. Every doc-side case fails on the base because the runbook
// carries none of the new prose yet; the source guards already pass.
describe("#522 runbook disable stop-fence refusal", () => {
  const runbook = flat(sectionBody(/^## Exclusive-window runbook/) ?? "");

  const REFUSAL_SENTENCE =
    "With the lease registry on (`LLAMACTL_RESIDENCY_LEASES`), the node stop fence can refuse a disable: `llamactl disable` exits 1 with `disable: serverStop refused: <reason>: <ids>` for a ModelRun (the `: <ids>` part is left out when no ids are reported) or `disable: modelHostStop refused: <reason>: <ids>` for a ModelHost, where `<reason>` is `LeasesActive`, `DrainInProgress`, `SessionsActive` or `SessionsUnknown`.";
  const STORED_SENTENCE =
    "The manifest is already stored with `spec.enabled: false`, but nothing was stopped and the engine keeps serving.";
  const SESSION_CHECK_SENTENCE =
    "Before the window, check the `Sessions:` section of `llamactl residency status --node <name>`; the disable never releases sessions, so the overrides are `llamactl residency release-session <sessionId> --yes --node <name>` for an idle binding and `llamactl residency force-unload <workload> --reason <text> --yes --node <name>`, after which run the disable again.";
  const IN_FLIGHT_SENTENCE =
    "An in-flight binding refuses the release as `SessionInFlight` unless `--force` is given, and a forced release leaves its leases held, so the stop still refuses as `LeasesActive`; force-unload is the override then.";
  const STEP9_SENTENCE =
    "The stop fence is separate from this bookkeeping and can refuse the exit-step disable the same way (see step 3).";
  const BOOKKEEPING_SENTENCE =
    'A disable is never blocked by this bookkeeping and at worst logs "not recorded" (#741).';

  const applySrc = readOrEmpty(join(REPO, "packages/remote/src/workload/apply.ts"));
  const setEnabledSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/setEnabled.ts"));
  const stopFenceSrc = readOrEmpty(join(REPO, "packages/remote/src/residency/stop-fence.ts"));
  const agentSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/agent.ts"));
  const residencySrc = readOrEmpty(join(REPO, "packages/cli/src/commands/residency.ts"));
  const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));

  // Kills: documenting the refusal without the stored-disabled-manifest
  // caveat, the session-check override or the in-flight release rule; also
  // guards the pre-existing #741 bookkeeping sentence and bans file:line
  // citations in the runbook prose.
  test("step 3 documents the disable refusal, the stored manifest and the overrides", () => {
    for (const phrase of [
      REFUSAL_SENTENCE,
      STORED_SENTENCE,
      SESSION_CHECK_SENTENCE,
      IN_FLIGHT_SENTENCE,
    ]) {
      expect(runbook, phrase.slice(0, 60)).toContain(phrase);
    }
    expect(runbook, "pre-existing #741 sentence").toContain(BOOKKEEPING_SENTENCE);
    expect(/\.ts:\d/.test(runbook), "no file:line citation").toBe(false);
  });

  // Kills: placing the fence prose outside step 3 — it must sit between
  // "Stop production" and "Diff the template".
  test("the step-3 fence sentences sit inside step 3", () => {
    const stopIdx = runbook.indexOf("Stop production");
    const diffIdx = runbook.indexOf("Diff the template");
    expect(stopIdx, "step 3 anchor").toBeGreaterThanOrEqual(0);
    expect(diffIdx, "step 4 anchor").toBeGreaterThan(stopIdx);
    for (const phrase of [
      REFUSAL_SENTENCE,
      STORED_SENTENCE,
      SESSION_CHECK_SENTENCE,
      IN_FLIGHT_SENTENCE,
    ]) {
      const at = runbook.indexOf(phrase);
      expect(at, `missing: ${phrase.slice(0, 60)}`).toBeGreaterThan(stopIdx);
      expect(at, `missing: ${phrase.slice(0, 60)}`).toBeLessThan(diffIdx);
    }
  });

  // Kills: dropping the step-9 cross-reference or moving it ahead of
  // "Exit the window".
  test("step 9 cross-references the stop fence", () => {
    const exitIdx = runbook.indexOf("Exit the window");
    expect(exitIdx, "step 9 anchor").toBeGreaterThanOrEqual(0);
    const at = runbook.indexOf(STEP9_SENTENCE);
    expect(at, "missing step-9 sentence").toBeGreaterThan(exitIdx);
  });

  // Kills: unwiring the fix — stopDisabledWorkload must still translate a
  // refused serverStop through the shared stopRefusedResult helper, which
  // carries the StopRefused condition and the serverStop refused error
  // string (#815: the wording moved out of the disable body, so the pin
  // follows it into the helper and keeps the call-site wiring).
  test("source: stopDisabledWorkload surfaces serverStop refusals", () => {
    const body = enclosingBody(applySrc, "async function stopDisabledWorkload(");
    expect(body, "stopDisabledWorkload signature").not.toBe("");
    expect(body, "stopDisabledWorkload calls stopRefusedResult").toContain("stopRefusedResult(");
    const helper = enclosingBody(applySrc, "function stopRefusedResult(");
    expect(helper, "stopRefusedResult signature").not.toBe("");
    expect(helper, "serverStop refused prefix").toContain("serverStop refused: ");
    expect(helper, "StopRefused condition").toContain("StopRefused");
  });

  // Guard: the ModelHost sibling already maps a refused modelHostStop.
  test("source: disableModelHost already reports modelHostStop refusals", () => {
    const body = enclosingBody(applySrc, "async function disableModelHost(");
    expect(body, "disableModelHost signature").not.toBe("");
    expect(body, "modelHostStop refused prefix").toContain("modelHostStop refused: ");
  });

  // Guard: the disabled intent is saved before apply for both manifest
  // kinds — the prose's "already stored with spec.enabled: false" relies
  // on exactly these two call sites.
  test("source: setEnabled saves disabled intent before apply, both kinds", () => {
    const occurrences =
      setEnabledSrc.split("if (!manifest.spec.enabled) save(manifest);").length - 1;
    expect(occurrences).toBe(2);
  });

  // Guard: the prose names exactly the four StopFenceRefusal reasons.
  test("source: StopFenceRefusal reason union lists exactly the documented reasons", () => {
    const typeBody = enclosingBody(stopFenceSrc, "export type StopFenceRefusal = {");
    expect(typeBody, "StopFenceRefusal type").not.toBe("");
    const reasonDecl = /reason:\s*([^\s;][^;]*);/.exec(typeBody)?.[1] ?? "";
    const reasons = [...reasonDecl.matchAll(/"([^"]+)"/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    expect([...reasons].sort()).toEqual([
      "DrainInProgress",
      "LeasesActive",
      "SessionsActive",
      "SessionsUnknown",
    ]);
  });

  // Guard: fenceWorkloadStop keeps the null-registry fast path the prose
  // describes (no registry, no refusal).
  test("source: fenceWorkloadStop keeps the null-registry fast path", () => {
    const body = enclosingBody(stopFenceSrc, "export function fenceWorkloadStop");
    expect(body, "fenceWorkloadStop signature").not.toBe("");
    expect(body).toContain("if (registry === null)");
  });

  // Guard: every CLI/source surface the prose cites exists — the agent
  // env knob, the residency USAGE lines and the SessionInFlight refusal.
  test("source: agent, residency CLI and router carry the cited surface", () => {
    expect(agentSrc, "LLAMACTL_RESIDENCY_LEASES").toContain("LLAMACTL_RESIDENCY_LEASES");
    const usage = /const USAGE = `([\s\S]*?)`;/.exec(residencySrc)?.[1] ?? "";
    expect(usage, "release-session usage").toContain("release-session <sessionId> --yes [--force]");
    expect(usage, "force-unload usage").toContain("force-unload <workload> --reason <text> --yes");
    const residencyDir = join(REPO, "packages/remote/src/residency");
    const residencyHasInFlight = readdirSync(residencyDir)
      .filter((file) => file.endsWith(".ts"))
      .some((file) => readOrEmpty(join(residencyDir, file)).includes("SessionInFlight"));
    expect(
      routerSrc.includes("SessionInFlight") || residencyHasInFlight,
      "SessionInFlight refusal",
    ).toBe(true);
  });
});
