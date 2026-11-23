import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #517
// Kills: the doc sentences missing or reworded; the launchRefusal gate absent
// or placed after the bench call in maybeTuneAfterPull/maybeVisionBenchAfterPull
// (packages/core/src/autotune.ts) or runPresetStep/runVisionStep
// (packages/core/src/candidateTest.ts); the candidateTestRun/autotuneAfterPull
// subscription procedures (packages/remote/src/router.ts) or the CLI local
// branches runAutotuneAfterPull (packages/cli/src/commands/pull.ts) and
// runTest (packages/cli/src/commands/candidate.ts) dropping
// `launchRefusal: benchLaunchRefusal`.
describe("#517 autotune + candidate-test exclusive-group refusal", () => {
  test("doc and source pin the launchRefusal gate on the post-pull and candidate-test benches", () => {
    const section = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");
    expect(section).toContain(
      "`llamactl pull file` and `llamactl pull candidate` run the post-pull auto-tune through `maybeTuneAfterPull` (`packages/core/src/autotune.ts`): the local branch in `runAutotuneAfterPull` (`packages/cli/src/commands/pull.ts`) and the `autotuneAfterPull` subscription procedure (`packages/remote/src/router.ts`) both pass `launchRefusal: benchLaunchRefusal`, so before `benchPreset` or `benchVision` spawns `llama-bench`/`llama-mtmd-cli` the read-only gate checks the pulled rel's declared-exclusive residency group and an occupied group records the preset or vision step as skipped with kind `exclusive-group-occupied` and the refusal text instead of launching the bench (#517).",
    );
    expect(section).toContain(
      "`llamactl candidate test` gates its bench steps the same way: `candidateTest` (`packages/core/src/candidateTest.ts`) consults `launchRefusal` immediately before `benchPreset` in `runPresetStep` and before `benchVision` in `runVisionStep`, and both the `candidateTestRun` subscription procedure (`packages/remote/src/router.ts`) and the CLI local branch in `runTest` (`packages/cli/src/commands/candidate.ts`) pass `launchRefusal: benchLaunchRefusal`, so an occupied group surfaces as the step's `ran: false` reason — printed as `preset skipped: residency lifecycle refused <rel> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>` — rather than a bench process error; a node with no store file, a rel with no group and a clear gate behave as before (#517).",
    );

    const autotuneSrc = readOrEmpty(join(REPO, "packages/core/src/autotune.ts"));

    const tuneBody = enclosingBody(autotuneSrc, "export async function maybeTuneAfterPull(");
    expect(tuneBody, "maybeTuneAfterPull body").not.toBe("");
    const tuneGateAt = tuneBody.indexOf("launchRefusal");
    expect(tuneGateAt, "maybeTuneAfterPull consults launchRefusal").toBeGreaterThanOrEqual(0);
    expect(tuneGateAt).toBeLessThan(tuneBody.indexOf("benchPreset("));

    const visionBody = enclosingBody(autotuneSrc, "async function maybeVisionBenchAfterPull(");
    expect(visionBody, "maybeVisionBenchAfterPull body").not.toBe("");
    const visionGateAt = visionBody.indexOf("launchRefusal");
    expect(visionGateAt, "maybeVisionBenchAfterPull consults launchRefusal").toBeGreaterThanOrEqual(
      0,
    );
    expect(visionGateAt).toBeLessThan(visionBody.indexOf("benchVision("));

    const candidateSrc = readOrEmpty(join(REPO, "packages/core/src/candidateTest.ts"));

    const presetBody = enclosingBody(candidateSrc, "async function runPresetStep(");
    expect(presetBody, "runPresetStep body").not.toBe("");
    const presetGateAt = presetBody.indexOf("launchRefusal");
    expect(presetGateAt, "runPresetStep consults launchRefusal").toBeGreaterThanOrEqual(0);
    expect(presetGateAt).toBeLessThan(presetBody.indexOf("benchPreset("));

    const stepVisionBody = enclosingBody(candidateSrc, "async function runVisionStep(");
    expect(stepVisionBody, "runVisionStep body").not.toBe("");
    const stepVisionGateAt = stepVisionBody.indexOf("launchRefusal");
    expect(stepVisionGateAt, "runVisionStep consults launchRefusal").toBeGreaterThanOrEqual(0);
    expect(stepVisionGateAt).toBeLessThan(stepVisionBody.indexOf("benchVision("));

    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const candidateStart = routerSrc.indexOf("candidateTestRun: t.procedure");
    const candidateEnd = routerSrc.indexOf("uninstall: t.procedure", candidateStart);
    const candidateBlock =
      candidateStart === -1 || candidateEnd === -1
        ? ""
        : routerSrc.slice(candidateStart, candidateEnd);
    expect(candidateBlock, "candidateTestRun passes launchRefusal").toContain(
      "launchRefusal: benchLaunchRefusal",
    );

    const tuneStart = routerSrc.indexOf("autotuneAfterPull: t.procedure");
    const tuneEnd = routerSrc.indexOf("pullFile: t.procedure", tuneStart);
    const tuneBlock = tuneStart === -1 || tuneEnd === -1 ? "" : routerSrc.slice(tuneStart, tuneEnd);
    expect(tuneBlock, "autotuneAfterPull passes launchRefusal").toContain(
      "launchRefusal: benchLaunchRefusal",
    );

    const pullSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/pull.ts"));
    const pullTuneBody = enclosingBody(pullSrc, "async function runAutotuneAfterPull(");
    expect(pullTuneBody, "runAutotuneAfterPull body").not.toBe("");
    expect(pullTuneBody, "runAutotuneAfterPull passes launchRefusal").toContain(
      "launchRefusal: benchLaunchRefusal",
    );

    const candidateCliSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/candidate.ts"));
    const runTestBody = enclosingBody(candidateCliSrc, "async function runTest(");
    expect(runTestBody, "runTest body").not.toBe("");
    expect(runTestBody, "runTest passes launchRefusal").toContain(
      "launchRefusal: benchLaunchRefusal",
    );
  });
});
