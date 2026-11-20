import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  enclosingBody,
  expectPins,
  flat,
  readOrEmpty,
  REPO,
  sectionBody,
  sectionRe,
} from "./helpers.js";

// Part of #520
// Kills: shipping the CLI stop-fence refusal reporting undocumented,
// documenting it without the source helpers, or leaving stopModelRunServer
// unwired.
describe("#520 CLI stop-fence refusal reporting", () => {
  test("session affinity documents the refusal lines; cli source carries the helpers", () => {
    const aff = flat(sectionBody(sectionRe("session affinity")) ?? "");
    expectPins(aff, "session affinity", [
      "`llamactl server stop`",
      "`llamactl delete workload`",
      "server stop: node <node> refused to stop <workload> (<reason>: <ids>); nothing was stopped",
      "delete: node <node> refused to stop (<reason>: <ids>); manifest preserved",
      "`SessionsActive`",
      "`SessionsUnknown`",
      "`llamactl residency release-session <sessionId> --yes --node <name>`",
      "(#520)",
    ]);

    const serverSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/server.ts"));
    const s = enclosingBody(serverSrc, "function stopRefusalLine(");
    expect(s, "stopRefusalLine signature").not.toBe("");
    expectPins(s, "stopRefusalLine", ["nothing was stopped", '.join(", ")']);

    const workloadSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/workload.ts"));
    const w = enclosingBody(workloadSrc, "function modelRunStopRefusalLine(");
    expect(w, "modelRunStopRefusalLine signature").not.toBe("");
    expectPins(w, "modelRunStopRefusalLine", [
      "manifest preserved",
      "pid identity unverifiable",
      ".active",
    ]);

    const stopBody = enclosingBody(workloadSrc, "async function stopModelRunServer(");
    expect(stopBody, "stopModelRunServer signature").not.toBe("");
    expect(stopBody, "stopModelRunServer wiring").toContain("modelRunStopRefusalLine(");
  });
});
