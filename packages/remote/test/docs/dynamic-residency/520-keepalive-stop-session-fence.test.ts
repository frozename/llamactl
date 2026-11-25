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
// Kills: shipping the keep-alive stop-fence refusal undocumented, documenting
// it without the router fence or the CLI reporting helpers, or wiring
// keepAliveStopRefusalLine nowhere.
describe("#520 keep-alive stop session fence", () => {
  test("session affinity documents keep-alive stop; router and cli carry the fence", () => {
    const body = flat(sectionBody(sectionRe("session affinity")) ?? "");
    expectPins(body, "session affinity", [
      "`llamactl keep-alive stop`",
      "keepAliveStop",
      "keep-alive stop: node <node> refused to stop <workload> (<reason>: <ids>); nothing was stopped",
      "whether or not a supervisor is tracked",
    ]);

    const routerSrc = readOrEmpty(join(REPO, "packages/remote/src/router.ts"));
    const procStart = routerSrc.indexOf("keepAliveStop: t.procedure");
    const procEnd = routerSrc.indexOf("keepAliveStart: t.procedure");
    const slice = procStart === -1 || procEnd === -1 ? "" : routerSrc.slice(procStart, procEnd);
    expectPins(slice, "keepAliveStop procedure", [
      "fenceWorkloadStop",
      "stopKeepAlive",
      "r.pid !== null",
    ]);

    const cliSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/keepAlive.ts"));
    const refusalBody = enclosingBody(cliSrc, "function keepAliveStopRefusalLine(");
    expect(refusalBody, "keepAliveStopRefusalLine signature").not.toBe("");
    expectPins(refusalBody, "keepAliveStopRefusalLine", ["nothing was stopped", '.join(", ")']);

    const stopBody = enclosingBody(cliSrc, "async function runStop(");
    expect(stopBody, "runStop signature").not.toBe("");
    expect(stopBody, "runStop wiring").toContain("keepAliveStopRefusalLine(");
  });
});
