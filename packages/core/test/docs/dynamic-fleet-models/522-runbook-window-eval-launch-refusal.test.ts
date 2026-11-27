import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { OCCUPYING_RESIDENCY_STATES, RESIDENCY_GROUPS } from "../../../src/residency/lifecycle.js";
import {
  DOC,
  enclosingBody,
  exclusiveRows,
  flat,
  readOrEmpty,
  REPO,
  residencyTemplates,
  sectionBody,
} from "./helpers.js";

// Part of #522
// Kills: documenting the eval sandbox-launch refusal with the wrong verb
// shape, dropping the self-occupancy caveat, citing file:line anchors, or
// letting the step-8 prose drift from the gate the source actually runs.
describe("#522 runbook window eval launch refusal", () => {
  const runbook = flat(sectionBody(/^## Exclusive-window runbook/) ?? "");

  const STEP8_URL =
    "Run the eval against the engine the window started, with `--url` pointing at it: `llamactl eval perf --url <http://...> --engine <llamacpp|omlx|gufo|kapitsa> --model <id>` for perf evidence (see [Capturing evidence for an arm](#capturing-evidence-for-an-arm)), or `llamactl eval run <model> --url <http://...>` for the four sub-benches, where `<model>` is only the leaderboard tag and nothing is spawned or killed.";
  const STEP8_REFUSAL =
    "Without `--url`, `llamactl eval run <model>` spawns its own sandbox engine in the CLI process, beside the window's engine, so when the local residency store exists on the host running the eval and the catalog row for `<model>` declares `z13-large-gpu`, it reads that store read-only and exits 1 without spawning: `eval run: residency lifecycle refused <model> downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by <member> in state <state>`.";
  const STEP8_SELF =
    "On the agent host the window's own workload is such a holder: `llamactl enable` in step 6 records its `loading`, `warming` or `ready` row in `z13-large-gpu`, and the check counts every occupying row, so an in-window `eval run` without `--url` refuses there (see [dynamic-residency.md](dynamic-residency.md#direct-modelhost-start-and-stop)).";

  // Kills: shipping #804's gate without runbook prose, dropping the
  // self-occupancy caveat, or stating the gate against the agent's store
  // instead of the local one.
  test("step 8 documents the --url eval and the sandbox launch refusal", () => {
    for (const sentence of [STEP8_URL, STEP8_REFUSAL, STEP8_SELF]) {
      expect(runbook, sentence.slice(0, 60)).toContain(sentence);
    }
    expect(/\.ts:\d/.test(runbook), "no file:line citation").toBe(false);
  });

  // Kills: placing the prose outside step 8.
  test("the step-8 sentences sit inside step 8", () => {
    const lo = runbook.indexOf("8. Run the eval");
    const hi = runbook.indexOf("Exit the window");
    expect(lo, "step 8 anchor").toBeGreaterThanOrEqual(0);
    expect(hi, "step 9 anchor").toBeGreaterThan(lo);
    const step7 = runbook.indexOf("7. Wait for the readiness probe");
    expect(step7, "step 7 anchor").toBeGreaterThanOrEqual(0);
    expect(step7, "step 7 anchor").toBeLessThan(lo);
    for (const sentence of [STEP8_URL, STEP8_REFUSAL, STEP8_SELF]) {
      const at = runbook.indexOf(sentence);
      expect(at, `missing: ${sentence.slice(0, 60)}`).toBeGreaterThanOrEqual(lo);
      expect(at, `missing: ${sentence.slice(0, 60)}`).toBeLessThan(hi);
    }
  });

  // Kills: renaming or dropping the two doc anchors the step-8 prose links to.
  test("the anchors resolve", () => {
    expect(flat(readOrEmpty(DOC)), "### Capturing evidence for an arm").toContain(
      "### Capturing evidence for an arm",
    );
    expect(
      readOrEmpty(join(REPO, "docs/dynamic-residency.md")),
      "## Direct ModelHost start and stop",
    ).toContain("## Direct ModelHost start and stop");
  });

  // Kills: the doc claiming a gate the source dropped, a --url bypass that
  // no longer holds, or a store path that is no longer the CLI-local default.
  test("source: eval run gates only sandbox launches, against the local store", () => {
    const evalSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval.ts"));

    const groupBody = enclosingBody(evalSrc, "function evalSandboxLaunchGroup");
    expect(groupBody, "evalSandboxLaunchGroup signature").not.toBe("");
    expect(groupBody).toContain("remoteUrl ? undefined : catalog.findByRel(model)?.residencyGroup");

    const runBody = enclosingBody(evalSrc, "async function runEvalRun");
    expect(runBody, "runEvalRun signature").not.toBe("");
    expect(runBody).toContain("exclusiveGroupLaunchRefusal(");
    expect(runBody).toContain("storePath: defaultResidencyStorePath(),");
    expect(runBody).toContain("`eval run: ${refusal}\\n`");

    const refusalIdx = runBody.indexOf("exclusiveGroupLaunchRefusal(");
    const rootIdx = runBody.indexOf("ensureEvalRoot()");
    expect(refusalIdx, "refusal gate call").toBeGreaterThanOrEqual(0);
    expect(rootIdx, "ensureEvalRoot call").toBeGreaterThanOrEqual(0);
    expect(refusalIdx, "gate before eval root").toBeLessThan(rootIdx);

    const usage = /const USAGE = `([\s\S]*?)`;/.exec(evalSrc)?.[1] ?? "";
    expect(usage, "eval run usage line").toContain(
      "run <model> [--node <name>] [--ub <256|512>] [--all] [--url <http://...>]",
    );
    expect(usage, "model arg becomes tag").toContain("model arg becomes");
  });

  // Kills: a renamed refusal, or a gate that excludes rows.
  test("source: refusal text and occupancy", () => {
    const lifecycleSrc = readOrEmpty(
      join(REPO, "packages/remote/src/residency/direct-lifecycle.ts"),
    );

    const body = enclosingBody(lifecycleSrc, "export function exclusiveGroupLaunchRefusal");
    expect(body, "exclusiveGroupLaunchRefusal signature").not.toBe("");
    expect(body).toContain(
      "`residency lifecycle refused ${opts.id} downloaded -> loading: ExclusiveGroupOccupied: exclusive group ${group} is held by ${holder.model} in state ${holder.state}`",
    );
    expect(body).toContain("isOccupyingResidencyState(row.state)");
    expect(body).not.toContain("!== opts.id");

    expect([...OCCUPYING_RESIDENCY_STATES]).toEqual(["loading", "warming", "ready"]);
    expect(RESIDENCY_GROUPS).toContainEqual({ name: "z13-large-gpu", exclusive: true });
    expect(exclusiveRows.length).toBeGreaterThan(0);
    expect(residencyTemplates.length).toBeGreaterThan(0);
  });

  // Kills: the self-occupancy claim going stale.
  test("source: enable records the template group", () => {
    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const applySrc = readOrEmpty(join(REPO, "packages/remote/src/workload/apply.ts"));

    const optsBody = enclosingBody(routerSrc, "function directResidencyOpts");
    expect(optsBody, "directResidencyOpts signature").not.toBe("");
    expect(optsBody).toContain("group: directResidencyGroup(workload, labels)");
    expect(routerSrc).toContain("directResidencyOpts(input.workload, manifest?.metadata.labels)");

    const startBody = enclosingBody(applySrc, "async function startModelHostProcess");
    expect(startBody, "startModelHostProcess signature").not.toBe("");
    expect(startBody).toContain(
      "const { annotations: _wireAnnotations, ...wireMetadata } = manifest.metadata;",
    );
  });
});
