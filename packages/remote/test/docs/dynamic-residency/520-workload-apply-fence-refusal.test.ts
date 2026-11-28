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
// Kills: shipping the workload.apply fence-refusal mapping undocumented, or
// implementing it outside the shared ops-chat refusal helper.
describe("#520 workload.apply fence refusal", () => {
  test("D1 session affinity documents the workload.apply refusal contract", () => {
    const affinity = flat(sectionBody(sectionRe("session affinity")) ?? "");
    expectPins(affinity, "session affinity", [
      "`llamactl.workload.apply`",
      "`apply_refused`",
      "workloadApply refused by the node stop fence (<reason>): <message>",
      "`StopRefused`",
      "`EvictSessionActive`",
      "`EvictSessionUnknown`",
      "`EvictVictimBusy`",
    ]);
  });

  test("D2 the shared ops-chat refusal helper carries the workload.apply mapping", () => {
    const src = readOrEmpty(join(REPO, "packages/remote/src/ops-chat/dispatch.ts"));

    const helper = enclosingBody(src, "function opsChatStopRefusal(");
    expect(helper, "opsChatStopRefusal signature").not.toBe("");
    expectPins(helper, "opsChatStopRefusal", [
      'code: "apply_refused"',
      '"llamactl.workload.apply"',
    ]);
  });
});
