import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #517
// Kills: missing or reworded doc sentences; runWorker not passing the
// recorded start/stop pair; runStart or the agent gate not ignoring the
// target's own row; core's cleanup bypassing the stop seam; and
// directWorkloadProvenDown keeping its final `return false` for keep-alive
// targets.
describe("#517 keep-alive worker lifecycle rows", () => {
  test("doc and source pin the worker lifecycle rows, own-row gate and crash proof", () => {
    const section = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");
    for (const sentence of [
      "The detached worker records its own lifecycle row under the keep-alive target rather than the resolved rel: `keepAliveRecordedStart` wraps the engine start in `runDirectResidencyStart` and `keepAliveRecordedStop` wraps the supervisor-exit stop in `runDirectResidencyStop`, taking the group from the catalog row of the resolved rel, so a failed start leaves the target's row `failed` with that group and a confirmed cleanup stop walks it back to `downloaded`.",
      "Because that row belongs to the target rather than to a sandbox copy, `keepAliveLaunchRefusal` takes the resolved rel and the keep-alive target and passes `ignoreModel: target` to `exclusiveGroupLaunchRefusal`: the target's own stale row never refuses its restart, while every other occupying member of the group still does.",
      "`runKeepAliveWorker` carries a `stop` seam beside its `start` seam, and its cleanup invokes exactly `(stop ?? stopServer)({ key, resolved })`; core stays adapter-free while the CLI passes the recorded pair.",
      "A keep-alive target is proven down only when its state file still names that target, its recorded supervisor pid is absent or verifies `dead` or `reused`, and `isServerProvenDown({ name: target })` proves the server keyed by the keep-alive target down (the target name, not the rel the state file records); a missing or mismatched state, a live or unknown supervisor identity, a live server, or a throwing read fails closed.",
      "For a name that is neither a ModelRun nor a ModelHost, `directWorkloadProvenDown` returns `keepAliveWorkloadProvenDown(model)`, so a crashed keep-alive's stale `ready` row reconciles to `downloaded` before a same-group start and the boot orphan sweep can move it to `failed` once it is stale.",
    ]) {
      expect(section, sentence).toContain(sentence);
    }

    const cliSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/keepAlive.ts"));
    const workerBody = enclosingBody(cliSrc, "async function runWorker(");
    expect(workerBody, "runWorker body").not.toBe("");
    for (const pin of [
      "start: keepAliveRecordedStart",
      "stop: keepAliveRecordedStop",
      "keepAliveLaunchRefusal(rel, target)",
    ]) {
      expect(workerBody, `runWorker ${pin}`).toContain(pin);
    }

    const startBody = enclosingBody(cliSrc, "async function runStart(");
    expect(startBody, "runStart body").not.toBe("");
    expect(startBody).toContain("keepAliveLaunchRefusal(resolvedRel, target)");
    expect(cliSrc).toContain("runDirectResidencyStart(");
    expect(cliSrc).toContain("runDirectResidencyStop(");

    const coreSrc = readOrEmpty(join(REPO, "packages/core/src/keepAlive.ts"));
    const cleanupBody = enclosingBody(coreSrc, "async function cleanupWorker(");
    expect(cleanupBody, "cleanupWorker body").not.toBe("");
    expect(cleanupBody).toContain("(stop ?? stopServer)({ key, resolved })");

    const directLifecycleSrc = readOrEmpty(
      join(REPO, "packages/remote/src/residency/direct-lifecycle.ts"),
    );
    expect(directLifecycleSrc).toContain("ignoreModel");

    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const refusalBody = enclosingBody(routerSrc, "function keepAliveStartRefusal(");
    expect(refusalBody, "keepAliveStartRefusal body").not.toBe("");
    expect(refusalBody).toContain("ignoreModel: target");

    const provenDownBody = enclosingBody(routerSrc, "function directWorkloadProvenDown(");
    expect(provenDownBody, "directWorkloadProvenDown body").not.toBe("");
    expect(provenDownBody).toContain("return keepAliveWorkloadProvenDown(model);");

    // The server proof is keyed by the keep-alive target (the row's model),
    // not by the rel the state file records.
    const keepAliveProofBody = enclosingBody(routerSrc, "function keepAliveWorkloadProvenDown(");
    expect(keepAliveProofBody, "keepAliveWorkloadProvenDown body").not.toBe("");
    for (const pin of [
      "serverMod.isServerProvenDown({ name })",
      "if (readState()?.target !== model) {",
      "return serverDown(model);",
    ]) {
      expect(keepAliveProofBody, `keepAliveWorkloadProvenDown ${pin}`).toContain(pin);
    }
  });
});
