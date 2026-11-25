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
// Kills: shipping the ops-chat stop-fence refusal mapping undocumented, or
// implementing it without the shared dispatch helper being wired into
// dispatchOpsChatTool.
describe("#520 ops-chat stop-fence refusal", () => {
  test("D1 session affinity documents the ops-chat refusal contract", () => {
    const affinity = flat(sectionBody(sectionRe("session affinity")) ?? "");
    expectPins(affinity, "session affinity", [
      "`llamactl.server.stop`",
      "`llamactl.workload.delete`",
      "`llamactl.composite.destroy`",
      "operatorRunTool",
      "`stop_refused`",
      "`delete_refused`",
      "`destroy_refused`",
      "serverStop refused by the node stop fence (<reason>: <ids>); nothing was stopped",
    ]);
  });

  test("D2 dispatch source carries and wires the stop-refusal helper", () => {
    const src = readOrEmpty(join(REPO, "packages/remote/src/ops-chat/dispatch.ts"));

    const helper = enclosingBody(src, "function opsChatStopRefusal(");
    expect(helper, "opsChatStopRefusal signature").not.toBe("");
    expectPins(helper, "opsChatStopRefusal", [
      'code: "stop_refused"',
      'code: "delete_refused"',
      'code: "destroy_refused"',
      "manifestPreserved",
    ]);

    const dispatch = enclosingBody(src, "export async function dispatchOpsChatTool(");
    expect(dispatch, "dispatchOpsChatTool signature").not.toBe("");
    expect(dispatch, "dispatchOpsChatTool wiring").toContain("opsChatStopRefusal(");
  });
});
