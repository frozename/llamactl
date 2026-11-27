// Part of #517. Kills: missing doc sentence; dropping the unstored-ModelRun branch or any of its three identity guards.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

describe("#517 unstored ModelRun proof", () => {
  test("doc and source pin the unstored ModelRun sidecar identity", () => {
    const section = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");
    expect(section).toContain(
      "A ModelRun that the agent started through `serverStart` with no manifest in its own workloads dir (the reconciler or `llamactl expose` stores the manifest on the host that applied it) still records its row under the workload name, and `directWorkloadProvenDown` treats that name as a ModelRun when `startServer`'s `llama-server.state` sidecar exists under it, no `modelhost.pid` or `modelhost.state` file exists under it, and the keep-alive state file does not name it (`unstoredModelRunRecorded` in `packages/remote/src/router.ts`); the same `isServerProvenDown` check then proves it down, so a crashed run's stale `ready` row reconciles before a same-group start and the boot orphan sweep can fail it, while a name with no sidecar, with ModelHost runtime files, or named by the keep-alive state still fails closed (#517).",
    );

    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const directBody = enclosingBody(routerSrc, "function directWorkloadProvenDown(");
    expect(directBody, "directWorkloadProvenDown body").toContain(
      "unstoredModelRunRecorded(model)",
    );

    const unstoredBody = enclosingBody(routerSrc, "function unstoredModelRunRecorded(");
    expect(unstoredBody, "unstoredModelRunRecorded body").not.toBe("");
    for (const pin of [
      "serverMod.readServerState(key)",
      "modelhostPidFile(",
      "modelhostStateFile(",
      "keepAliveMod.readKeepAliveState()?.target !== model",
    ]) {
      expect(unstoredBody, `unstoredModelRunRecorded ${pin}`).toContain(pin);
    }
  });
});
