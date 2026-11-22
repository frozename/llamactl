import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #517
// Kills: the doc sentences missing or reworded; the gate absent or placed
// after the bench call in either the CLI local branch (runPreset/runVision
// in packages/cli/src/commands/bench.ts) or the agent subscription
// procedures (benchPresetRun/benchVisionRun in packages/remote/src/router.ts,
// the scheduler + remote-dispatch path); benchLaunchRefusal missing
// resolveTarget or exclusiveGroupLaunchRefusal; gating the raw target
// instead of the resolved rel.
describe("#517 bench launch exclusive-group refusal", () => {
  test("doc and source pin the pre-spawn exclusive-group refusal for bench preset and vision", () => {
    const section = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");
    expect(section).toContain(
      "`llamactl bench preset <target>` and `llamactl bench vision <target>` spawn `llama-bench` and `llama-mtmd-cli` and record no `residency_states` row, but before spawning they resolve `<target>` to a catalog rel and read the local residency store read-only through `benchLaunchRefusal` (`packages/cli/src/commands/bench.ts`), exiting 1 without spawning when the rel's declared-exclusive residency group is occupied (#517).",
    );
    expect(section).toContain(
      "The rel comes from `resolveTarget` (`packages/core/src/target.ts`), so the default target `current` and aliases are checked under the rel they resolve to and the refusal names that rel; a target that does not resolve keeps core's `Unknown bench target: <target>` error, and a resolved rel with no catalog row launches as before.",
    );
    expect(section).toContain(
      "`benchLaunchRefusal` takes the group from the catalog row whose `rel` is the resolved target and delegates to `exclusiveGroupLaunchRefusal` (`packages/remote/src/residency/direct-lifecycle.ts`); the refusal prints as `bench preset: residency lifecycle refused <rel> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>` — `bench vision: ` for the vision bench — with the same profile-switch and store-unavailable forms as the sandbox launches, and a node with no store file launches as before.",
    );
    expect(section).toContain(
      "The agent's `benchPresetRun` and `benchVisionRun` subscription procedures (`packages/remote/src/router.ts`), which serve `bench preset`/`bench vision` on remote dispatch and every scheduled bench, run the same gate before `bench.benchPreset`/`bench.benchVision`, so the refusal reaches remote callers as a stream error; like the other launch gates it is read-only, unfenced and never reconciles a proven-down peer.",
    );

    const cliSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/bench.ts"));

    const presetBody = enclosingBody(cliSrc, "async function runPreset(");
    expect(presetBody, "runPreset body").not.toBe("");
    const presetGateAt = presetBody.indexOf("benchLaunchRefusal(");
    expect(presetGateAt, "runPreset calls benchLaunchRefusal").toBeGreaterThanOrEqual(0);
    expect(presetGateAt).toBeLessThan(presetBody.indexOf("bench.benchPreset("));

    const visionBody = enclosingBody(cliSrc, "async function runVision(");
    expect(visionBody, "runVision body").not.toBe("");
    const visionGateAt = visionBody.indexOf("benchLaunchRefusal(");
    expect(visionGateAt, "runVision calls benchLaunchRefusal").toBeGreaterThanOrEqual(0);
    expect(visionGateAt).toBeLessThan(visionBody.indexOf("bench.benchVision("));

    const helperBody = enclosingBody(cliSrc, "function benchLaunchRefusal(");
    expect(helperBody, "benchLaunchRefusal body").not.toBe("");
    expect(helperBody).toContain("exclusiveGroupLaunchRefusal(");
    expect(helperBody).toContain("resolveTarget(");

    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const presetStart = routerSrc.indexOf("benchPresetRun: t.procedure");
    const presetEnd = routerSrc.indexOf("benchVisionRun: t.procedure", presetStart);
    const presetBlock =
      presetStart === -1 || presetEnd === -1 ? "" : routerSrc.slice(presetStart, presetEnd);
    const routerPresetGateAt = presetBlock.indexOf("benchLaunchRefusal(");
    expect(routerPresetGateAt, "benchPresetRun calls benchLaunchRefusal").toBeGreaterThanOrEqual(0);
    expect(routerPresetGateAt).toBeLessThan(presetBlock.indexOf("bench.benchPreset("));

    const visionStart = routerSrc.indexOf("benchVisionRun: t.procedure");
    const visionEnd = routerSrc.indexOf("pullCandidate: t.procedure", visionStart);
    const visionBlock =
      visionStart === -1
        ? ""
        : routerSrc.slice(visionStart, visionEnd === -1 ? routerSrc.length : visionEnd);
    const routerVisionGateAt = visionBlock.indexOf("benchLaunchRefusal(");
    expect(routerVisionGateAt, "benchVisionRun calls benchLaunchRefusal").toBeGreaterThanOrEqual(0);
    expect(routerVisionGateAt).toBeLessThan(visionBlock.indexOf("bench.benchVision("));
  });
});
