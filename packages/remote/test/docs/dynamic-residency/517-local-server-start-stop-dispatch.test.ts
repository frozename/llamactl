import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

// Part of #517
// Kills: fetchStartResult/fetchStopResult keeping their isLocalDispatch()
// branches to core startServer/stopServer (no residency_states row, no
// ExclusiveGroupOccupied refusal on an occupied exclusive group) and
// buildStartManifest hard-coding labels:{}/annotations:{} so the stored
// llamactl.io/residency-group label is wiped before the procedures read it.
describe("#517 local server start/stop dispatch", () => {
  test("doc and source pin local server start/stop residency dispatch", () => {
    const section = flat(sectionBody(sectionRe("direct modelhost start and stop")) ?? "");
    expect(section).toContain(
      "`llamactl server start` and `llamactl server stop` against the local node dispatch through the in-process `serverStart`/`serverStop` procedures instead of calling `startServer`/`stopServer` in the CLI process, so they record the `residency_states` row and refuse an occupied exclusive group exactly as the agent procedures do (#517).",
    );
    expect(section).toContain(
      "When `llamactl server start` rewrites the ModelRun manifest it keeps the stored ModelRun's labels and annotations, including `llamactl.io/residency-group`.",
    );

    const src = readOrEmpty(join(REPO, "packages/cli/src/commands/server.ts"));

    const startBody = enclosingBody(src, "async function fetchStartResult(");
    expect(startBody, "fetchStartResult body").not.toBe("");
    expect(startBody).toContain("getNodeClient().serverStart.subscribe");
    expect(startBody).not.toContain("server.startServer(");

    const stopBody = enclosingBody(src, "async function fetchStopResult(");
    expect(stopBody, "fetchStopResult body").not.toBe("");
    expect(stopBody).toContain("getNodeClient().serverStop.mutate");
    expect(stopBody).not.toContain("server.stopServer(");

    const manifestBody = enclosingBody(src, "function buildStartManifest(");
    expect(manifestBody, "buildStartManifest body").not.toBe("");
    expect(manifestBody).toContain("loadWorkloadByName");
  });
});
