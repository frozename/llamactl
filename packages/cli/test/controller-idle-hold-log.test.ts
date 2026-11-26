import { describe, expect, it } from "bun:test";

import { reduceReconcileReportLog } from "../src/commands/controller.js";

const ISO = "2026-11-20T10:00:00.000Z";
const T0 = Date.parse("2026-11-25T12:00:00.000Z");

const heldModelRun = {
  kind: "ModelRun" as const,
  name: "qwen-idle",
  node: "local",
  action: "unchanged" as const,
  idleEvictedAt: ISO,
};
const busyModelRun = {
  kind: "ModelRun" as const,
  name: "qwen-busy",
  node: "local",
  action: "unchanged" as const,
};
const heldModelHost = {
  kind: "ModelHost" as const,
  name: "mlx-idle",
  node: "mac-mini",
  action: "unchanged" as const,
  idleEvictedAt: ISO,
};

describe("#519 controller idle-hold log", () => {
  it("H1: an unchanged held ModelRun names the idle hold and release verb", () => {
    const step = reduceReconcileReportLog(new Map(), [heldModelRun, busyModelRun], T0);

    expect(step.lines).toEqual([
      {
        stream: "stdout",
        text: "[2026-11-25T12:00:00.000Z] modelrun/qwen-idle on local: unchanged (idle-evicted at 2026-11-20T10:00:00.000Z via llamactl.io/idle-evicted-at; run llamactl residency release-idle qwen-idle to resume)",
      },
      {
        stream: "stdout",
        text: "[2026-11-25T12:00:00.000Z] modelrun/qwen-busy on local: unchanged",
      },
    ]);
  });

  it("H2: an unchanged held ModelHost names the idle hold and release verb", () => {
    const step = reduceReconcileReportLog(new Map(), [heldModelHost], T0);

    expect(step.lines).toEqual([
      {
        stream: "stdout",
        text: "[2026-11-25T12:00:00.000Z] modelhost/mlx-idle on mac-mini: unchanged (idle-evicted at 2026-11-20T10:00:00.000Z via llamactl.io/idle-evicted-at; run llamactl residency release-idle mlx-idle to resume)",
      },
    ]);
  });

  it("H3: a held report keeps the error path and annotates only the recovered outcome", () => {
    const failingHeld = { ...heldModelRun, error: "boom" };
    const first = reduceReconcileReportLog(new Map(), [failingHeld], T0);

    expect(first.lines).toEqual([
      {
        stream: "stderr",
        text: "[2026-11-25T12:00:00.000Z] WARN modelrun/qwen-idle on local: unchanged error=boom",
      },
    ]);

    const second = reduceReconcileReportLog(first.nextState, [heldModelRun], T0 + 10_000);

    expect(second.lines).toEqual([
      {
        stream: "stderr",
        text: "[2026-11-25T12:00:10.000Z] modelrun/qwen-idle on local: recovered after 1 failed pass(es)",
      },
      {
        stream: "stdout",
        text: "[2026-11-25T12:00:10.000Z] modelrun/qwen-idle on local: unchanged (idle-evicted at 2026-11-20T10:00:00.000Z via llamactl.io/idle-evicted-at; run llamactl residency release-idle qwen-idle to resume)",
      },
    ]);
  });
});
