import { type CgroupOomSample, readOomBaseline, writeOomBaseline } from "@llamactl/core/cgroupOom";
import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  advanceOomWatch,
  deadHostLines,
  newlyDeadHosts,
  oomBaselineFor,
  RECONCILE_ERROR_REMINDER_MS,
  type ReconcileErrorLog,
  reduceReconcileReportLog,
} from "../src/commands/controller.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

/**
 * Unit coverage for the controller's pass-to-pass log state: reconcile-error
 * dedup (#197) and OOM-kill attribution (#196). Both reducers are pure, so the
 * serve loop is exercised here pass by pass without spawning a controller.
 */

const T0 = Date.parse("2026-10-21T14:07:00.000Z");
const PASS_MS = 10_000;
const MISMATCH = "strata run-config /cfg/run.json --native must be /m/q3.gguf; got /m/q4.gguf";
const SERVICE =
  "/user.slice/user-1000.slice/user@1000.service/app.slice/llamactl-controller.service";

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

describe("advanceOomWatch", () => {
  const sample = (oomKill: number, cgroup = SERVICE): CgroupOomSample => ({ cgroup, oomKill });

  it("is inert without a cgroup sample (non-Linux, no cgroup v2)", () => {
    const state = { last: sample(1), pendingKills: 0 };
    expect(advanceOomWatch(state, null, ["h"])).toEqual({
      nextState: state,
      oomKilled: [],
      unattributedKills: 0,
    });
  });

  it("baselines on the first sample without attributing", () => {
    const r = advanceOomWatch({ last: null, pendingKills: 0 }, sample(2), ["h"]);
    expect(r).toEqual({
      nextState: { last: sample(2), pendingKills: 0 },
      oomKilled: [],
      unattributedKills: 0,
    });
  });

  it("attributes a rise to the hosts found dead in the same pass", () => {
    const r = advanceOomWatch({ last: sample(1), pendingKills: 0 }, sample(2), ["h"]);
    expect(r.oomKilled).toEqual(["h"]);
    expect(r.nextState).toEqual({ last: sample(2), pendingKills: 0 });
  });

  it("counts a kill that happened while the controller restarted (persisted baseline)", () => {
    // The previous controller persisted oom_kill 1; systemd's OOMPolicy=stop
    // restarted it after the engine kill, and the cgroup kept counting.
    const r = advanceOomWatch({ last: sample(1), pendingKills: 0 }, sample(2), ["strata"]);
    expect(r.oomKilled).toEqual(["strata"]);
  });

  it("holds an unmatched rise for one pass, then attributes it", () => {
    const first = advanceOomWatch({ last: sample(0), pendingKills: 0 }, sample(1), []);
    expect(first).toMatchObject({ oomKilled: [], unattributedKills: 0 });
    expect(first.nextState.pendingKills).toBe(1);
    const second = advanceOomWatch(first.nextState, sample(1), ["h"]);
    expect(second.oomKilled).toEqual(["h"]);
    expect(second.nextState.pendingKills).toBe(0);
  });

  it("reports a rise still unmatched after one pass as unattributed", () => {
    const first = advanceOomWatch({ last: sample(0), pendingKills: 0 }, sample(1), []);
    const second = advanceOomWatch(first.nextState, sample(1), []);
    expect(second).toEqual({
      nextState: { last: sample(1), pendingKills: 0 },
      oomKilled: [],
      unattributedKills: 1,
    });
  });

  it("does nothing while the counter is flat", () => {
    const r = advanceOomWatch({ last: sample(3), pendingKills: 0 }, sample(3), ["h"]);
    expect(r.oomKilled).toEqual([]);
  });

  it("re-baselines when the cgroup changes or its counter resets", () => {
    const moved = advanceOomWatch({ last: sample(1), pendingKills: 0 }, sample(5, "/other"), ["h"]);
    expect(moved).toMatchObject({ oomKilled: [], nextState: { last: sample(5, "/other") } });
    const reset = advanceOomWatch({ last: sample(4), pendingKills: 2 }, sample(0), ["h"]);
    expect(reset).toMatchObject({ oomKilled: [], nextState: { last: sample(0), pendingKills: 0 } });
  });
});

describe("dead-host lines", () => {
  const dead = { ...healthy, action: "started" as const, foundDead: true };

  it("skips hosts that were already failing before this pass", () => {
    const errorLog: ReconcileErrorLog = new Map([
      [
        "modelhost/strata-qwen38-mtp on local",
        { message: MISMATCH, firstSeenMs: T0, lastLoggedMs: T0, count: 3 },
      ],
    ]);
    expect(newlyDeadHosts([{ ...failing, foundDead: true }], errorLog)).toEqual([]);
    expect(newlyDeadHosts([dead], new Map())).toEqual(["strata-qwen38-mtp"]);
  });

  it("names the OOM kill with the cgroup counter", () => {
    const lines = deadHostLines(
      [dead],
      ["strata-qwen38-mtp"],
      { oomKilled: ["strata-qwen38-mtp"], unattributedKills: 0 },
      { cgroup: SERVICE, oomKill: 2 },
      T0,
    );
    expect(lines).toEqual([
      {
        stream: "stderr",
        text: "[2026-10-21T14:07:00.000Z] WARN modelhost/strata-qwen38-mtp: engine was OOM-killed (cgroup oom_kill 2); restarting",
      },
    ]);
  });

  it("reports a non-OOM death that was restarted, and unattributed kills", () => {
    const lines = deadHostLines(
      [dead],
      ["strata-qwen38-mtp"],
      { oomKilled: [], unattributedKills: 1 },
      { cgroup: SERVICE, oomKill: 3 },
      T0,
    );
    expect(lines.map((l) => l.text)).toEqual([
      "[2026-10-21T14:07:00.000Z] WARN modelhost/strata-qwen38-mtp on local: engine had exited unexpectedly; restarted",
      `[2026-10-21T14:07:00.000Z] WARN controller cgroup ${SERVICE}: 1 OOM kill(s) (oom_kill 3) not matched to a ModelHost engine`,
    ]);
  });
});

describe("OOM baseline across a controller restart", () => {
  const sample = (oomKill: number, cgroup = SERVICE): CgroupOomSample => ({ cgroup, oomKill });

  it("persists the counter through the last attributed kill", () => {
    expect(oomBaselineFor({ last: sample(2), pendingKills: 1 })).toEqual(sample(1));
  });

  it("persists the latest sample when nothing is held", () => {
    expect(oomBaselineFor({ last: sample(2), pendingKills: 0 })).toEqual(sample(2));
    expect(oomBaselineFor({ last: null, pendingKills: 0 })).toBeNull();
  });

  it("a kill held when OOMPolicy=stop restarts the controller is attributed by the next controller", () => {
    // The kill lands after the host's status check, so controller A holds it
    // in pendingKills. The persisted baseline must stay below the sample so
    // controller B, restarted by OOMPolicy=stop, still sees the rise.
    const dir = mkdtempSync(join(tmpdir(), "llamactl-oom-baseline-"));
    const file = join(dir, ".controller-oom.json");
    try {
      const a = advanceOomWatch({ last: sample(1), pendingKills: 0 }, sample(2), []);
      expect(a).toMatchObject({ oomKilled: [], nextState: { pendingKills: 1 } });
      const baseline = oomBaselineFor(a.nextState);
      expect(baseline).not.toBeNull();
      writeOomBaseline(file, baseline!);

      const state = { last: readOomBaseline(file), pendingKills: 0 };
      const dead = { ...healthy, action: "started" as const, foundDead: true };
      const hosts = newlyDeadHosts([dead], new Map());
      const b = advanceOomWatch(state, sample(2), hosts);
      expect(b.oomKilled).toEqual(["strata-qwen38-mtp"]);
      expect(deadHostLines([dead], hosts, b, sample(2), T0).map((l) => l.text)).toEqual([
        "[2026-10-21T14:07:00.000Z] WARN modelhost/strata-qwen38-mtp: engine was OOM-killed (cgroup oom_kill 2); restarting",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
