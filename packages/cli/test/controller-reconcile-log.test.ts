import { describe, expect, it } from "bun:test";

import {
  RECONCILE_ERROR_REMINDER_MS,
  type ReconcileErrorLog,
  reduceReconcileReportLog,
} from "../src/commands/controller.js";

/**
 * Unit coverage for the controller's pass-to-pass log state: reconcile-error
 * dedup (#197). The reducer is pure, so the serve loop is exercised here pass
 * by pass without spawning a controller.
 */

const T0 = Date.parse("2026-10-21T14:07:00.000Z");
const PASS_MS = 10_000;
const MISMATCH = "strata run-config /cfg/run.json --native must be /m/q3.gguf; got /m/q4.gguf";
("/user.slice/user-1000.slice/user@1000.service/app.slice/llamactl-controller.service");

const failing = {
  kind: "ModelHost" as const,
  name: "strata-qwen38-mtp",
  node: "local",
  action: "unchanged" as const,
  error: MISMATCH,
};
const healthy = { kind: "ModelHost" as const, name: "strata-qwen38-mtp", node: "local" };

function runPasses(
  passes: { reports: Parameters<typeof reduceReconcileReportLog>[1]; atMs: number }[],
): { stream: string; text: string }[][] {
  let state: ReconcileErrorLog = new Map();
  return passes.map(({ reports, atMs }) => {
    const step = reduceReconcileReportLog(state, reports, atMs);
    state = step.nextState;
    return step.lines;
  });
}

describe("reduceReconcileReportLog", () => {
  it("logs a repeating error once, not every pass", () => {
    const passes = Array.from({ length: 6 }, (_, i) => ({
      reports: [failing],
      atMs: T0 + i * PASS_MS,
    }));
    const lines = runPasses(passes);
    expect(lines[0]).toEqual([
      {
        stream: "stderr",
        text: `[2026-10-21T14:07:00.000Z] WARN modelhost/strata-qwen38-mtp on local: unchanged error=${MISMATCH}`,
      },
    ]);
    expect(lines.slice(1).flat()).toEqual([]);
  });

  it("reminds at most once per reminder interval while the error persists", () => {
    const reminderPass = RECONCILE_ERROR_REMINDER_MS / PASS_MS;
    const passes = Array.from({ length: reminderPass * 2 + 1 }, (_, i) => ({
      reports: [failing],
      atMs: T0 + i * PASS_MS,
    }));
    const lines = runPasses(passes);
    const logged = lines.flatMap((l, i) => (l.length > 0 ? [i] : []));
    expect(logged).toEqual([0, reminderPass, reminderPass * 2]);
    expect(lines[reminderPass]?.[0]?.text).toBe(
      `[2026-10-21T14:17:00.000Z] WARN modelhost/strata-qwen38-mtp on local: still failing (${String(reminderPass + 1)} passes since 2026-10-21T14:07:00.000Z) error=${MISMATCH}`,
    );
  });

  it("logs again at once when the message changes", () => {
    const changed = { ...failing, error: "strata native model file does not exist: /m/q4.gguf" };
    const lines = runPasses([
      { reports: [failing], atMs: T0 },
      { reports: [failing], atMs: T0 + PASS_MS },
      { reports: [changed], atMs: T0 + 2 * PASS_MS },
    ]);
    expect(lines[1]).toEqual([]);
    expect(lines[2]?.[0]?.text).toContain(`error=${changed.error}`);
  });

  it("logs one recovery line, then resumes the per-pass line", () => {
    const lines = runPasses([
      { reports: [failing], atMs: T0 },
      { reports: [failing], atMs: T0 + PASS_MS },
      { reports: [{ ...healthy, action: "started" }], atMs: T0 + 2 * PASS_MS },
      { reports: [{ ...healthy, action: "unchanged" }], atMs: T0 + 3 * PASS_MS },
    ]);
    expect(lines[2]).toEqual([
      {
        stream: "stderr",
        text: "[2026-10-21T14:07:20.000Z] modelhost/strata-qwen38-mtp on local: recovered after 2 failed pass(es)",
      },
      {
        stream: "stdout",
        text: "[2026-10-21T14:07:20.000Z] modelhost/strata-qwen38-mtp on local: started",
      },
    ]);
    expect(lines[3]).toEqual([
      {
        stream: "stdout",
        text: "[2026-10-21T14:07:30.000Z] modelhost/strata-qwen38-mtp on local: unchanged",
      },
    ]);
  });

  it("tracks workloads independently and forgets deleted ones", () => {
    const run = {
      kind: "ModelRun" as const,
      name: "run-a",
      node: "gpu1",
      action: "unchanged" as const,
    };
    const first = reduceReconcileReportLog(new Map(), [failing, { ...run, error: "boom" }], T0);
    expect(first.lines).toHaveLength(2);
    expect(first.lines[0]?.text).toContain("modelhost/strata-qwen38-mtp on local");
    expect(first.lines[1]?.text).toContain("modelrun/run-a on gpu1: unchanged error=boom");
    const second = reduceReconcileReportLog(first.nextState, [failing], T0 + PASS_MS);
    expect(second.lines).toEqual([]);
    expect([...second.nextState.keys()]).toEqual(["modelhost/strata-qwen38-mtp on local"]);
  });
});
