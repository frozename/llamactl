// #519: idleEvictSeconds operator enforcement — the pure `runIdleEviction`
// in residency/procedures.ts. It reads the idleEviction snapshot (the same
// section residencyStatus reports), re-checks each targeted row against the
// live lease registry immediately before stopping, and reports one row per
// outcome. `targets: null` is a dry run; an array restricts a wet run to
// those workloads. At the pinned base the export does not exist, so every
// case fails BY ASSERTION on the structural probe — never by import or type
// error.
import type { ResidencySnapshot } from "@llamactl/core/residency/leases";

import { createSessionRefcounts } from "@llamactl/core/residency/sessions";
import { describe, expect, test } from "bun:test";

import * as procedures from "../../src/residency/procedures.js";

// The runIdleEviction contract the assertions pin, described structurally so
// the file typechecks on both sides of the fix.
type IdleEvictionSnapshotRow = {
  workload: string;
  readySinceMs: number;
  lastActivityAtMs: number | null;
  idleSinceMs: number | null;
  activeLeaseCount: number;
  dueAtMs: number | null;
  due: boolean;
};

type IdleEvictionSnapshot =
  | { status: "disabled"; scope: string }
  | { status: "unavailable"; scope: string; reason: string }
  | {
      status: "available";
      scope: string;
      advisory: boolean;
      idleEvictSeconds: number;
      workloads: IdleEvictionSnapshotRow[];
    };

type IdleEvictKind = "modelrun" | "modelhost";

type IdleEvictTarget = { workload: string; kind: IdleEvictKind };

type IdleEvictStopResult = { stopped: boolean; detail?: string };

type IdleEvictionResultRow = {
  workload: string;
  action: "would-evict" | "evicted" | "skipped";
  kind?: IdleEvictKind;
  idleSinceMs?: number;
  dueAtMs?: number;
  reason?: string;
  detail?: string;
};

type IdleEvictionRunResult =
  | { ok: false; reason: string }
  | { ok: true; dryRun: boolean; windowSeconds: number; rows: IdleEvictionResultRow[] };

type LeaseRegistryProbe = {
  snapshot: (workload: string) => ResidencySnapshot;
  lastActivityAtMs?: (workload: string) => number;
};

type IdleEvictSessionCheck =
  | { ok: true; released: string[] }
  | { ok: false; reason: "SessionActive"; sessions: string[] };

type IdleEvictSessions = {
  checkUnload(workload: string, opts?: { force?: boolean }): IdleEvictSessionCheck;
};

type RunIdleEviction = (input: {
  idleEviction: IdleEvictionSnapshot;
  leaseRegistry: LeaseRegistryProbe | null;
  sessions?: IdleEvictSessions | null;
  nowMs: number;
  targets: readonly IdleEvictTarget[] | null;
  stop: (workload: string, kind: IdleEvictKind) => Promise<IdleEvictStopResult>;
}) => Promise<IdleEvictionRunResult>;

const WINDOW_SECONDS = 60;
const NOW_MS = 61_000;

function requireRun(): RunIdleEviction {
  const run = (procedures as unknown as Record<string, unknown>)["runIdleEviction"] as
    | RunIdleEviction
    | undefined;
  expect(typeof run).toBe("function");
  return run!;
}

function snapshotRow(
  workload: string,
  opts: {
    readySinceMs?: number;
    lastActivityAtMs?: number | null;
    idleSinceMs?: number | null;
    dueAtMs?: number | null;
    due?: boolean;
  } = {},
): IdleEvictionSnapshotRow {
  return {
    workload,
    readySinceMs: opts.readySinceMs ?? 0,
    lastActivityAtMs: opts.lastActivityAtMs === undefined ? 0 : opts.lastActivityAtMs,
    idleSinceMs: opts.idleSinceMs === undefined ? 0 : opts.idleSinceMs,
    activeLeaseCount: 0,
    dueAtMs: opts.dueAtMs === undefined ? WINDOW_SECONDS * 1000 : opts.dueAtMs,
    due: opts.due ?? true,
  };
}

function availableSnapshot(workloads: readonly IdleEvictionSnapshotRow[]): IdleEvictionSnapshot {
  return {
    status: "available",
    scope: "serving-process",
    advisory: true,
    idleEvictSeconds: WINDOW_SECONDS,
    workloads: [...workloads],
  };
}

function fakeRegistry(opts?: {
  phase?: ResidencySnapshot["phase"];
  active?: readonly string[];
  activityAtMs?: number | ((workload: string) => number);
  withActivity?: boolean;
}): LeaseRegistryProbe {
  const phase = opts?.phase ?? "open";
  const active = opts?.active ?? [];
  const activity = opts?.activityAtMs ?? 0;
  const registry: LeaseRegistryProbe = {
    snapshot: (workload) => ({
      workload,
      phase,
      epoch: 0,
      active: [...active],
      waiters: 0,
    }),
  };
  if (opts?.withActivity !== false) {
    registry.lastActivityAtMs = (workload: string): number =>
      typeof activity === "function" ? activity(workload) : activity;
  }
  return registry;
}

type IdleEvictStop =
  | IdleEvictStopResult
  | ((workload: string, kind: IdleEvictKind) => Promise<IdleEvictStopResult>);

function recordingStop(
  calls: [string, IdleEvictKind][],
  outcome: IdleEvictStop = { stopped: true },
): (workload: string, kind: IdleEvictKind) => Promise<IdleEvictStopResult> {
  return async (workload, kind) => {
    calls.push([workload, kind]);
    return typeof outcome === "function" ? await outcome(workload, kind) : outcome;
  };
}

type SessionCheckCall = {
  workload: string;
  opts: { force?: boolean } | undefined;
};

type FakeSessionRegistry = IdleEvictSessions & { calls: SessionCheckCall[] };

// `bound` maps a workload to the session ids checkUnload reports as active;
// a workload absent from the map checks clean. `throws` makes every call
// raise "registry down" so fail-open paths are observable.
function fakeSessions(
  bound: Record<string, string[]>,
  opts?: { throws?: boolean },
): FakeSessionRegistry {
  const calls: SessionCheckCall[] = [];
  return {
    calls,
    checkUnload(workload, checkOpts): IdleEvictSessionCheck {
      calls.push({ workload, opts: checkOpts });
      if (opts?.throws === true) {
        throw new Error("registry down");
      }
      const ids = bound[workload] ?? [];
      if (ids.length === 0) {
        return { ok: true, released: [] };
      }
      return { ok: false, reason: "SessionActive", sessions: ids };
    },
  };
}

function rowsOf(result: IdleEvictionRunResult): IdleEvictionResultRow[] {
  return result.ok ? result.rows : [];
}

function rowFor(
  result: IdleEvictionRunResult,
  workload: string,
): IdleEvictionResultRow | undefined {
  return rowsOf(result).find((row) => row.workload === workload);
}

describe("runIdleEviction (#519)", () => {
  test("E1: a disabled snapshot returns ok:false Disabled with no stops", async () => {
    // kills: treating a disabled knob as an empty ok listing.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: { status: "disabled", scope: "serving-process" },
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: null,
      stop: recordingStop(stops),
    });
    expect(result).toMatchObject({ ok: false, reason: "Disabled" });
    expect(stops).toEqual([]);
  });

  test("E2: every unavailable reason comes back ok:false with no stops", async () => {
    // kills: collapsing the unavailable reasons or carrying on anyway.
    const run = requireRun();
    for (const reason of [
      "NotServingNode",
      "LeasesUnavailable",
      "StoreUnreadable",
      "LifecycleUnreadable",
    ] as const) {
      const stops: [string, IdleEvictKind][] = [];
      const result = await run({
        idleEviction: { status: "unavailable", scope: "serving-process", reason },
        leaseRegistry: fakeRegistry(),
        nowMs: NOW_MS,
        targets: null,
        stop: recordingStop(stops),
      });
      expect(result).toMatchObject({ ok: false, reason });
      expect(stops).toEqual([]);
    }
  });

  test("E3: a dry run reports would-evict and NotDue rows without stopping", async () => {
    // kills: stopping without targets, or omitting the dryRun/windowSeconds
    // fields the operator output renders.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([
        snapshotRow("w1", { idleSinceMs: 1_000, dueAtMs: 61_000 }),
        snapshotRow("w2", { idleSinceMs: 5_000, dueAtMs: 65_000, due: false }),
      ]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: null,
      stop: recordingStop(stops),
    });
    expect(result).toMatchObject({ ok: true, dryRun: true, windowSeconds: WINDOW_SECONDS });
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "would-evict",
      idleSinceMs: 1_000,
      dueAtMs: 61_000,
    });
    expect(rowFor(result, "w2")).toMatchObject({
      workload: "w2",
      action: "skipped",
      reason: "NotDue",
    });
    expect(stops).toEqual([]);
  });

  test("E4: a targeted due row stops once and reports evicted", async () => {
    // kills: never calling stop on a wet run.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(stops),
    });
    expect(result).toMatchObject({ ok: true, dryRun: false, windowSeconds: WINDOW_SECONDS });
    expect(stops).toEqual([["w1", "modelrun"]]);
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "evicted",
      kind: "modelrun",
    });
  });

  test("E5: a due row outside the targets is absent and never stopped", async () => {
    // kills: evicting untargeted rows.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w1"), snapshotRow("w2")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(stops),
    });
    expect(stops).toEqual([["w1", "modelrun"]]);
    expect(rowFor(result, "w2")).toBeUndefined();
    expect(rowFor(result, "w1")?.action).toBe("evicted");
  });

  test("E6: a target with no ready snapshot row is skipped NotReady", async () => {
    // kills: silently dropping the target or stopping it anyway.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [{ workload: "w9", kind: "modelrun" }],
      stop: recordingStop(stops),
    });
    expect(rowFor(result, "w9")).toMatchObject({
      workload: "w9",
      action: "skipped",
      reason: "NotReady",
    });
    expect(stops).toEqual([]);
  });

  test("E7: a target whose snapshot row is not due is skipped NotDue", async () => {
    // kills: stopping a row the window has not reached.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w1", { due: false, dueAtMs: 120_000 })]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(stops),
    });
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "NotDue",
    });
    expect(stops).toEqual([]);
  });

  test("E8a: lease activity newer than the snapshot idle-since is NoLongerIdle", async () => {
    // kills: removing the pre-stop re-check (evicting on the stale snapshot).
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry({ activityAtMs: 30_000 }),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(stops),
    });
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "NoLongerIdle",
    });
    expect(stops).toEqual([]);
  });

  test("E8b: an active lease at stop time is NoLongerIdle", async () => {
    // kills: removing the pre-stop re-check.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry({ active: ["w1#1"] }),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(stops),
    });
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "NoLongerIdle",
    });
    expect(stops).toEqual([]);
  });

  test("E8c: a draining lease phase at stop time is NoLongerIdle", async () => {
    // kills: removing the pre-stop re-check.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry({ phase: "draining" }),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(stops),
    });
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "NoLongerIdle",
    });
    expect(stops).toEqual([]);
  });

  test("E8d: a registry without lastActivityAtMs cannot confirm idle and is NoLongerIdle", async () => {
    // kills: evicting when lease activity cannot be re-read.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry({ withActivity: false }),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(stops),
    });
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "NoLongerIdle",
    });
    expect(stops).toEqual([]);
  });

  test("E8e: a null registry cannot confirm idle and is NoLongerIdle", async () => {
    // kills: evicting without a live registry to re-check against.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: null,
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(stops),
    });
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "NoLongerIdle",
    });
    expect(stops).toEqual([]);
  });

  test("E9: the re-check evicts at exactly dueAtMs and refuses 1ms earlier", async () => {
    // kills: changing the >= due comparison to >.
    const run = requireRun();
    const atStops: [string, IdleEvictKind][] = [];
    const at = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry(),
      nowMs: WINDOW_SECONDS * 1000,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(atStops),
    });
    expect(rowFor(at, "w1")).toMatchObject({ workload: "w1", action: "evicted" });
    expect(atStops).toEqual([["w1", "modelrun"]]);

    const earlyStops: [string, IdleEvictKind][] = [];
    const early = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry(),
      nowMs: WINDOW_SECONDS * 1000 - 1,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(earlyStops),
    });
    expect(rowFor(early, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "NoLongerIdle",
    });
    expect(earlyStops).toEqual([]);
  });

  test("E10: stop refusals and throws become skipped rows and later targets still run", async () => {
    // kills: aborting on the first failure, or dropping the refusal detail.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const refused = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(stops, { stopped: false, detail: "SessionsActive: s1" }),
    });
    expect(rowFor(refused, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "StopRefused",
      detail: "SessionsActive: s1",
    });

    const thrown = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(stops, () => Promise.reject(new Error("boom"))),
    });
    expect(rowFor(thrown, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "StopFailed",
      detail: "boom",
    });

    const mixedStops: [string, IdleEvictKind][] = [];
    const mixed = await run({
      idleEviction: availableSnapshot([snapshotRow("w1"), snapshotRow("w2")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [
        { workload: "w1", kind: "modelrun" },
        { workload: "w2", kind: "modelrun" },
      ],
      stop: recordingStop(mixedStops, (workload) =>
        Promise.resolve(
          workload === "w1" ? { stopped: false, detail: "SessionsActive: s1" } : { stopped: true },
        ),
      ),
    });
    expect(mixedStops).toEqual([
      ["w1", "modelrun"],
      ["w2", "modelrun"],
    ]);
    expect(rowFor(mixed, "w1")).toMatchObject({ action: "skipped", reason: "StopRefused" });
    expect(rowFor(mixed, "w2")).toMatchObject({ action: "evicted", kind: "modelrun" });
  });

  test("E11: a modelhost target passes modelhost to stop", async () => {
    // kills: hardcoding the modelrun kind on the stop call.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("h1")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [{ workload: "h1", kind: "modelhost" }],
      stop: recordingStop(stops),
    });
    expect(stops).toEqual([["h1", "modelhost"]]);
    expect(rowFor(result, "h1")).toMatchObject({
      workload: "h1",
      action: "evicted",
      kind: "modelhost",
    });
  });

  test("E12: targets stop in snapshot order and each stop resolves before the next", async () => {
    // kills: parallel stops.
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const resultPromise = run({
      idleEviction: availableSnapshot([snapshotRow("w1"), snapshotRow("w2")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [
        { workload: "w2", kind: "modelrun" },
        { workload: "w1", kind: "modelrun" },
      ],
      stop: (workload, kind) => {
        stops.push([workload, kind]);
        if (workload === "w1") {
          return firstGate.then(() => ({ stopped: true }));
        }
        return Promise.resolve({ stopped: true });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stops).toEqual([["w1", "modelrun"]]);
    releaseFirst?.();
    const result = await resultPromise;
    expect(stops).toEqual([
      ["w1", "modelrun"],
      ["w2", "modelrun"],
    ]);
    expect(rowFor(result, "w1")?.action).toBe("evicted");
    expect(rowFor(result, "w2")?.action).toBe("evicted");
  });
});

describe("#520 session-bound workloads", () => {
  test("E13: a dry run skips a session-bound due row as SessionsActive", async () => {
    // kills: the dry-run branch ignoring the session registry (row.due -> would-evict unconditionally).
    const run = requireRun();
    const stops: [string, IdleEvictKind][] = [];
    const sessions = fakeSessions({ w1: ["s1"] });
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w1"), snapshotRow("w2")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: null,
      stop: recordingStop(stops),
      sessions,
    });
    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "SessionsActive",
      detail: "s1",
    });
    expect(rowFor(result, "w2")).toMatchObject({ workload: "w2", action: "would-evict" });
    expect(stops).toEqual([]);
  });

  test("E14: a wet run skips a session-bound row before stopping and never forces the release", async () => {
    // kills: the wet pre-stop path not consulting sessions; also checkUnload called with { force: true } (which would release s1).
    const run = requireRun();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 60_000, now: () => 0 });
    const acquired = sessions.acquire("s1", "w1");
    expect(acquired.ok).toBe(true);
    if (acquired.ok) {
      sessions.release("s1", acquired.generation);
    }
    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w1"), snapshotRow("w2")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [
        { workload: "w1", kind: "modelrun" },
        { workload: "w2", kind: "modelrun" },
      ],
      stop: recordingStop(stops),
      sessions,
    });
    expect(stops).toEqual([["w2", "modelrun"]]);
    expect(rowFor(result, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "SessionsActive",
      detail: "s1",
    });
    expect(rowFor(result, "w2")).toMatchObject({ workload: "w2", action: "evicted" });
    expect(sessions.activeSessions("w1")).toEqual(["s1"]);
  });

  test("E15: a throwing session registry reports SessionsUnknown, never fail-open", async () => {
    // kills: a catch that treats a throwing registry as no sessions (fail-open).
    const run = requireRun();
    const sessions = fakeSessions({ w1: ["s1"] }, { throws: true });

    const dryStops: [string, IdleEvictKind][] = [];
    const dry = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: null,
      stop: recordingStop(dryStops),
      sessions,
    });
    expect(rowFor(dry, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "SessionsUnknown",
    });
    expect(rowFor(dry, "w1")?.detail ?? "").toContain("registry down");

    const wetStops: [string, IdleEvictKind][] = [];
    const wet = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(wetStops),
      sessions,
    });
    expect(wetStops).toEqual([]);
    expect(rowFor(wet, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "SessionsUnknown",
    });
  });

  test("E16: the session check runs once per wet target and is never forced", async () => {
    // kills: forcing the session check or checking twice.
    const run = requireRun();
    const sessions = fakeSessions({ w1: ["s1"] });
    const stops: [string, IdleEvictKind][] = [];
    await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(stops),
      sessions,
    });
    expect(sessions.calls.length).toBe(1);
    expect(sessions.calls[0]?.workload).toBe("w1");
    expect(sessions.calls[0]?.opts?.force).not.toBe(true);
  });

  test("G1: a not-due session-bound row reports NotDue and never consults sessions", async () => {
    // kills: moving the session check ahead of NotDue.
    const run = requireRun();
    const sessions = fakeSessions({ w1: ["s1"] });
    const dryStops: [string, IdleEvictKind][] = [];
    const dry = await run({
      idleEviction: availableSnapshot([snapshotRow("w1", { due: false, dueAtMs: 120_000 })]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: null,
      stop: recordingStop(dryStops),
      sessions,
    });
    expect(rowFor(dry, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "NotDue",
    });

    const wetStops: [string, IdleEvictKind][] = [];
    const wet = await run({
      idleEviction: availableSnapshot([snapshotRow("w1", { due: false, dueAtMs: 120_000 })]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(wetStops),
      sessions,
    });
    expect(rowFor(wet, "w1")).toMatchObject({
      workload: "w1",
      action: "skipped",
      reason: "NotDue",
    });
    expect(wetStops).toEqual([]);
    expect(sessions.calls).toEqual([]);
  });

  test("G2: sessions null or omitted leaves the #519 rows unchanged", async () => {
    // kills: requiring the sessions argument, or letting its absence change rows.
    const run = requireRun();
    const variants: readonly { sessions?: null }[] = [{ sessions: null }, {}];
    for (const extra of variants) {
      const dryStops: [string, IdleEvictKind][] = [];
      const dry = await run({
        idleEviction: availableSnapshot([snapshotRow("w1")]),
        leaseRegistry: fakeRegistry(),
        nowMs: NOW_MS,
        targets: null,
        stop: recordingStop(dryStops),
        ...extra,
      });
      expect(rowFor(dry, "w1")).toMatchObject({ workload: "w1", action: "would-evict" });
      expect(dryStops).toEqual([]);

      const wetStops: [string, IdleEvictKind][] = [];
      const wet = await run({
        idleEviction: availableSnapshot([snapshotRow("w1")]),
        leaseRegistry: fakeRegistry(),
        nowMs: NOW_MS,
        targets: [{ workload: "w1", kind: "modelrun" }],
        stop: recordingStop(wetStops),
        ...extra,
      });
      expect(wetStops).toEqual([["w1", "modelrun"]]);
      expect(rowFor(wet, "w1")).toMatchObject({ workload: "w1", action: "evicted" });
    }
  });

  test("G3: an expired idle session binding does not hold the eviction", async () => {
    // kills: holding on a session the registry would prune as expired.
    const run = requireRun();
    let registryNowMs = 0;
    const sessions = createSessionRefcounts({
      idleTimeoutMs: 60_000,
      now: () => registryNowMs,
    });
    const acquired = sessions.acquire("s1", "w1");
    expect(acquired.ok).toBe(true);
    if (acquired.ok) {
      sessions.release("s1", acquired.generation);
    }
    registryNowMs = 61_000;

    const stops: [string, IdleEvictKind][] = [];
    const result = await run({
      idleEviction: availableSnapshot([snapshotRow("w1")]),
      leaseRegistry: fakeRegistry(),
      nowMs: NOW_MS,
      targets: [{ workload: "w1", kind: "modelrun" }],
      stop: recordingStop(stops),
      sessions,
    });
    expect(stops).toEqual([["w1", "modelrun"]]);
    expect(rowFor(result, "w1")).toMatchObject({ workload: "w1", action: "evicted" });
  });
});
