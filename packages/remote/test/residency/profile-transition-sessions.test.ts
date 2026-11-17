/**
 * #520 — RED tests for session protection in `executeProfileSwitch`
 * (`src/residency/profile-transition`): with a session-refcount registry
 * the executor must consult `checkUnload` — never with force — for every
 * victim at fence time and again once the drain window settles, refusing
 * `SessionsActive: <ids>` / `SessionsUnknown` before any stop runs. The
 * base executor ignores the `sessions` opt entirely, so every fenced case
 * fails by assertion — never by import or type error — through the same
 * loose cast the #279 fence suite uses. The guard cases pass at base by
 * design: they pin the inert defaults (expired sessions, non-victim
 * bindings, explicit null, dry-run).
 */
import type {
  BeginDrainResult,
  CommitUnloadResult,
  ResidencyLeases,
  WhenIdleResult,
} from "@llamactl/core/residency/leases";
import type {
  OkPlan,
  PlannerWorkload,
  ProfileSwitchPlan,
  ProfileSwitchRequest,
  StepKind,
} from "@llamactl/core/residency/planner";
import type { SessionRefcounts } from "@llamactl/core/residency/sessions";

import { createResidencyLeases, setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { planProfileSwitch } from "@llamactl/core/residency/planner";
import {
  createSessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { executeProfileSwitch } from "../../src/residency/profile-transition.js";

let clock = 0;

beforeEach(() => {
  clock = 0;
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
});
afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
});

const NODE = "n1";
const NOW_MS = 1_000_000_000;
const VICTIM_IDS = ["v-a", "v-b", "v-c"];
const REPLACEMENT_IDS = ["r-x", "r-y"];
const DRAIN_TIMEOUT_MS = 25;

const DEFERRED_FENCED: StepKind[] = [
  "persist-suppression",
  "verify-release",
  "reserve",
  "verify-ready",
  "publish",
  "complete",
];

type StepAction = "fence" | "drain" | "stop" | "start";
type StepStatus = "planned" | "ok" | "failed" | "not-run";

interface SwitchStep {
  action: StepAction;
  workload: string;
  status: StepStatus;
  detail?: string;
}

interface StepFailure {
  action: StepAction;
  workload: string;
  detail: string;
}

interface Report {
  dryRun: boolean;
  outcome: "dry-run" | "stops-and-starts-ran" | "failed" | "refused" | "noop";
  ok: boolean;
  steps: SwitchStep[];
  ran: SwitchStep[];
  failedAt: StepFailure | null;
  deferred: StepKind[];
}

type ExecuteOpts = {
  dryRun?: boolean;
  registry?: ResidencyLeases | null;
  sessions?: SessionRefcounts | null;
  drainTimeoutMs?: number;
};

type LooseDeps = {
  stop: (w: string) => Promise<unknown>;
  start: (w: string) => Promise<unknown>;
};

type LooseExecute = (
  plan: ProfileSwitchPlan,
  deps: LooseDeps,
  opts?: ExecuteOpts,
) => Promise<unknown>;

const run = executeProfileSwitch as unknown as LooseExecute;

function workload(id: string, spec: Omit<PlannerWorkload, "id">): PlannerWorkload {
  return {
    id,
    profiles: spec.profiles,
    state: spec.state,
    expectedMemoryGiB: spec.expectedMemoryGiB,
    ...(spec.group === undefined ? {} : { group: spec.group }),
    ...(spec.protected === undefined ? {} : { protected: spec.protected }),
    ...(spec.disabled === undefined ? {} : { disabled: spec.disabled }),
    ...(spec.loadedAtMs === undefined ? {} : { loadedAtMs: spec.loadedAtMs }),
  };
}

function fleetWorkloads(): PlannerWorkload[] {
  return [
    workload("v-a", { profiles: ["maintenance"], state: "ready", expectedMemoryGiB: 16 }),
    workload("v-b", { profiles: ["maintenance"], state: "ready", expectedMemoryGiB: 16 }),
    workload("v-c", { profiles: ["maintenance"], state: "ready", expectedMemoryGiB: 16 }),
    workload("r-x", { profiles: ["interactive"], state: "downloaded", expectedMemoryGiB: 20 }),
    workload("r-y", { profiles: ["interactive"], state: "downloaded", expectedMemoryGiB: 20 }),
    workload("emb", {
      profiles: [],
      state: "ready",
      expectedMemoryGiB: 6,
      protected: true,
    }),
  ];
}

function fleetRequest(spec: { to?: string; budgetGiB?: number } = {}): ProfileSwitchRequest {
  return {
    node: NODE,
    to: spec.to ?? "interactive",
    budgetGiB: spec.budgetGiB ?? 64,
    groups: [],
    workloads: fleetWorkloads(),
    nowMs: NOW_MS,
  };
}

function okPlan(plan: ProfileSwitchPlan): OkPlan {
  expect(plan.ok).toBe(true);
  if (!plan.ok) {
    throw new Error(`expected ok plan, got refusal ${plan.reason}`);
  }
  return plan;
}

function okFleetPlan(spec: { to?: string; budgetGiB?: number } = {}): OkPlan {
  const plan = okPlan(planProfileSwitch(fleetRequest(spec)));
  expect(plan.victims).toEqual(VICTIM_IDS);
  expect(plan.replacements).toEqual(REPLACEMENT_IDS);
  return plan;
}

function step(
  action: StepAction,
  workload: string,
  status: StepStatus,
  detail?: string,
): SwitchStep {
  return {
    action,
    workload,
    status,
    ...(detail === undefined ? {} : { detail }),
  };
}

const FENCE_OK: SwitchStep[] = VICTIM_IDS.map((id) => step("fence", id, "ok"));
const DRAIN_OK: SwitchStep[] = VICTIM_IDS.map((id) => step("drain", id, "ok"));
const STOP_OK: SwitchStep[] = VICTIM_IDS.map((id) => step("stop", id, "ok"));
const START_OK: SwitchStep[] = REPLACEMENT_IDS.map((id) => step("start", id, "ok"));
const DRAIN_NOT_RUN: SwitchStep[] = VICTIM_IDS.map((id) => step("drain", id, "not-run"));
const STOP_NOT_RUN: SwitchStep[] = VICTIM_IDS.map((id) => step("stop", id, "not-run"));
const START_NOT_RUN: SwitchStep[] = REPLACEMENT_IDS.map((id) => step("start", id, "not-run"));

function plannedSteps(): SwitchStep[] {
  return [
    ...VICTIM_IDS.map((id) => step("fence", id, "planned")),
    ...VICTIM_IDS.map((id) => step("drain", id, "planned")),
    ...VICTIM_IDS.map((id) => step("stop", id, "planned")),
    ...REPLACEMENT_IDS.map((id) => step("start", id, "planned")),
  ];
}

type StepImpl = (workload: string, inner: ResidencyLeases) => unknown;

function recordingRegistry(inner: ResidencyLeases, calls: string[]): ResidencyLeases {
  return {
    acquire: (workload) => inner.acquire(workload),
    active: (workload) => inner.active(workload),
    beginDrain: (workload): BeginDrainResult => {
      calls.push(`beginDrain:${workload}`);
      return inner.beginDrain(workload);
    },
    whenIdle: (token, opts): Promise<WhenIdleResult> => {
      calls.push(`whenIdle:${token.workload}`);
      return inner.whenIdle(token, opts);
    },
    commitUnload: (token, opts): CommitUnloadResult => {
      calls.push(`commitUnload:${token.workload}`);
      return inner.commitUnload(token, opts);
    },
    cancelDrain: (token): boolean => {
      calls.push(`cancelDrain:${token.workload}`);
      return inner.cancelDrain(token);
    },
    reopen: (token) => inner.reopen(token),
    snapshot: (workload) => inner.snapshot(workload),
    waiterCount: (workload) => inner.waiterCount(workload),
    audit: () => inner.audit(),
  };
}

function makeFixture(overrides: Record<string, StepImpl> = {}): {
  inner: ResidencyLeases;
  calls: string[];
  registry: ResidencyLeases;
  deps: LooseDeps;
} {
  const inner = createResidencyLeases();
  const calls: string[] = [];
  const deps: LooseDeps = {
    stop: (id) => {
      calls.push(`stop:${id}`);
      const impl = overrides[`stop:${id}`];
      return Promise.resolve(impl === undefined ? { ok: true } : impl(id, inner));
    },
    start: (id) => {
      calls.push(`start:${id}`);
      const impl = overrides[`start:${id}`];
      return Promise.resolve(impl === undefined ? { ok: true } : impl(id, inner));
    },
  };
  return { inner, calls, registry: recordingRegistry(inner, calls), deps };
}

async function reportOf(pending: Promise<unknown>): Promise<Report> {
  const result = (await pending.catch((error: unknown) => ({
    rejected: String(error),
  }))) as Report & { rejected?: string };
  expect(result.rejected).toBeUndefined();
  return result;
}

async function runSwitch(
  plan: ProfileSwitchPlan,
  deps: LooseDeps,
  opts?: ExecuteOpts,
): Promise<Report> {
  return await reportOf(run(plan, deps, opts));
}

function acquireSession(sessions: SessionRefcounts, id: string, workload: string): number {
  const acquired = sessions.acquire(id, workload);
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) {
    throw new Error(`session acquire refused: ${acquired.reason}`);
  }
  return acquired.generation;
}

function idleSession(sessions: SessionRefcounts, id: string, workload: string): void {
  sessions.release(id, acquireSession(sessions, id, workload));
}

function noStopStartWhenIdle(calls: string[]): void {
  expect(calls.some((entry) => entry.startsWith("stop:"))).toBe(false);
  expect(calls.some((entry) => entry.startsWith("start:"))).toBe(false);
  expect(calls.some((entry) => entry.startsWith("whenIdle:"))).toBe(false);
}

describe("executeProfileSwitch session protection", () => {
  test("an idle-window session on a victim refuses the switch at fence time", async () => {
    // Kills: no session check in the executor (the base runs every stop
    // and reports stops-and-starts-ran), and checkUnload called with
    // {force:true} (which would release s1 and let the switch run).
    const plan = okFleetPlan();
    const fx = makeFixture();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    const generation = acquireSession(sessions, "s1", "v-b");
    sessions.release("s1", generation);

    const report = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: fx.registry,
      sessions,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });

    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("failed");
    expect(report.ok).toBe(false);
    expect(report.failedAt).toEqual({
      action: "fence",
      workload: "v-b",
      detail: "SessionsActive: s1",
    });
    expect(report.steps).toEqual([
      step("fence", "v-a", "ok"),
      step("fence", "v-b", "failed", "SessionsActive: s1"),
      step("fence", "v-c", "not-run"),
      ...DRAIN_NOT_RUN,
      ...STOP_NOT_RUN,
      ...START_NOT_RUN,
    ]);
    expect(report.ran).toEqual(report.steps.slice(0, 2));
    expect(report.deferred).toEqual(DEFERRED_FENCED);
    noStopStartWhenIdle(fx.calls);
    expect(fx.calls).toContain("cancelDrain:v-b");
    expect(fx.calls).toContain("cancelDrain:v-a");
    for (const id of VICTIM_IDS) {
      expect(fx.inner.snapshot(id).phase).toBe("open");
    }
    expect(sessions.activeSessions("v-b")).toEqual(["s1"]);
  });

  test("a session holding refs (in-flight request) refuses even while its lease is held", async () => {
    // Kills: a check that waits for the lease drain first, or counts
    // only refs-0 sessions — the fence-time check must see s9 while the
    // v-a lease is still held and whenIdle never ran.
    const plan = okFleetPlan();
    const fx = makeFixture();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    const held = fx.inner.acquire("v-a");
    expect(held.ok).toBe(true);
    if (!held.ok) {
      throw new Error("acquire refused");
    }
    acquireSession(sessions, "s9", "v-a");

    try {
      const report = await runSwitch(plan, fx.deps, {
        dryRun: false,
        registry: fx.registry,
        sessions,
        drainTimeoutMs: DRAIN_TIMEOUT_MS,
      });

      expect(report.dryRun).toBe(false);
      expect(report.outcome).toBe("failed");
      expect(report.ok).toBe(false);
      expect(report.failedAt).toEqual({
        action: "fence",
        workload: "v-a",
        detail: "SessionsActive: s9",
      });
      expect(report.steps).toEqual([
        step("fence", "v-a", "failed", "SessionsActive: s9"),
        step("fence", "v-b", "not-run"),
        step("fence", "v-c", "not-run"),
        ...DRAIN_NOT_RUN,
        ...STOP_NOT_RUN,
        ...START_NOT_RUN,
      ]);
      noStopStartWhenIdle(fx.calls);
      for (const id of VICTIM_IDS) {
        expect(fx.inner.snapshot(id).phase).toBe("open");
      }
    } finally {
      held.lease.release();
    }
  });

  test("a throwing session registry fails closed as SessionsUnknown", async () => {
    // Kills: a try/catch that treats a checkUnload throw as ok
    // (fail-open) — the switch must refuse before any stop.
    const plan = okFleetPlan();
    const fx = makeFixture();
    const real = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    const throwing: SessionRefcounts = {
      acquire: (sessionId, workload) => real.acquire(sessionId, workload),
      release: (sessionId, generation) => {
        real.release(sessionId, generation);
      },
      touch: (sessionId) => {
        real.touch(sessionId);
      },
      forceRelease: (workload) => real.forceRelease(workload),
      activeSessions: (workload) => real.activeSessions(workload),
      checkUnload: () => {
        throw new Error("session registry unavailable");
      },
    };

    const report = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: fx.registry,
      sessions: throwing,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });

    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("failed");
    expect(report.ok).toBe(false);
    expect(report.failedAt).toEqual({
      action: "fence",
      workload: "v-a",
      detail: "SessionsUnknown",
    });
    expect(report.steps).toEqual([
      step("fence", "v-a", "failed", "SessionsUnknown"),
      step("fence", "v-b", "not-run"),
      step("fence", "v-c", "not-run"),
      ...DRAIN_NOT_RUN,
      ...STOP_NOT_RUN,
      ...START_NOT_RUN,
    ]);
    noStopStartWhenIdle(fx.calls);
    for (const id of VICTIM_IDS) {
      expect(fx.inner.snapshot(id).phase).toBe("open");
    }
  });

  test("a session that arrives during the drain window is caught before any stop", async () => {
    // Kills: dropping the post-drain re-check and keeping only the
    // fence-time check — s2 lands after every fence ran, so only a
    // re-check once whenIdle settles can refuse the switch.
    const plan = okFleetPlan();
    const fx = makeFixture();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    const held = fx.inner.acquire("v-c");
    expect(held.ok).toBe(true);
    if (!held.ok) {
      throw new Error("acquire refused");
    }

    const pending = run(plan, fx.deps, {
      dryRun: false,
      registry: fx.registry,
      sessions,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });
    // The fence phase ran synchronously inside run(); the session arrives
    // inside the drain window, after every fence-time check.
    const generation = acquireSession(sessions, "s2", "v-c");
    sessions.release("s2", generation);
    held.lease.release();

    const report = await reportOf(pending);

    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("failed");
    expect(report.ok).toBe(false);
    expect(report.failedAt).toEqual({
      action: "drain",
      workload: "v-c",
      detail: "SessionsActive: s2",
    });
    expect(report.steps).toEqual([
      ...FENCE_OK,
      step("drain", "v-a", "ok"),
      step("drain", "v-b", "ok"),
      step("drain", "v-c", "failed", "SessionsActive: s2"),
      ...STOP_NOT_RUN,
      ...START_NOT_RUN,
    ]);
    expect(fx.calls.some((entry) => entry.startsWith("stop:"))).toBe(false);
    expect(fx.calls.some((entry) => entry.startsWith("start:"))).toBe(false);
    for (const id of VICTIM_IDS) {
      expect(fx.inner.snapshot(id).phase).toBe("open");
    }
  });

  test("the installed seam is the default", async () => {
    // Kills: defaulting opts.sessions to null instead of
    // currentSessionRefcounts() — with the seam installed and no
    // sessions key, the idle-window session on v-a must still refuse.
    const plan = okFleetPlan();
    const fx = makeFixture();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    idleSession(sessions, "s1", "v-a");
    setSessionRefcountRegistry(sessions);

    const report = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: fx.registry,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });

    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("failed");
    expect(report.ok).toBe(false);
    expect(report.failedAt).toEqual({
      action: "fence",
      workload: "v-a",
      detail: "SessionsActive: s1",
    });
    expect(report.steps).toEqual([
      step("fence", "v-a", "failed", "SessionsActive: s1"),
      step("fence", "v-b", "not-run"),
      step("fence", "v-c", "not-run"),
      ...DRAIN_NOT_RUN,
      ...STOP_NOT_RUN,
      ...START_NOT_RUN,
    ]);
    noStopStartWhenIdle(fx.calls);
    for (const id of VICTIM_IDS) {
      expect(fx.inner.snapshot(id).phase).toBe("open");
    }
  });

  test("guard: an expired session lets the switch run", async () => {
    const plan = okFleetPlan();
    const fx = makeFixture();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    idleSession(sessions, "s1", "v-a");
    clock += 1000;

    const report = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: fx.registry,
      sessions,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });

    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    expect(report.failedAt).toBeNull();
    expect(report.steps).toEqual([...FENCE_OK, ...DRAIN_OK, ...STOP_OK, ...START_OK]);
    for (const id of VICTIM_IDS) {
      expect(fx.inner.snapshot(id).phase).toBe("unloaded");
    }
  });

  test("guard: sessions bound to non-victim workloads do not block", async () => {
    const plan = okFleetPlan();
    const fx = makeFixture();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    idleSession(sessions, "s-emb", "emb");
    idleSession(sessions, "s-rx", "r-x");

    const report = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: fx.registry,
      sessions,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });

    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    expect(report.failedAt).toBeNull();
    for (const id of VICTIM_IDS) {
      expect(fx.inner.snapshot(id).phase).toBe("unloaded");
    }
  });

  test("guard: explicit sessions:null stays inert with the seam installed", async () => {
    const plan = okFleetPlan();
    const fx = makeFixture();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    acquireSession(sessions, "s1", "v-a");
    setSessionRefcountRegistry(sessions);

    const report = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: fx.registry,
      sessions: null,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });

    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    expect(report.failedAt).toBeNull();
    for (const id of VICTIM_IDS) {
      expect(fx.inner.snapshot(id).phase).toBe("unloaded");
    }
  });

  test("guard: dry-run with an active session plans steps and calls nothing", async () => {
    const plan = okFleetPlan();
    const fx = makeFixture();
    const sessions = createSessionRefcounts({ idleTimeoutMs: 1000, now: () => clock });
    acquireSession(sessions, "s1", "v-a");
    setSessionRefcountRegistry(sessions);

    const report = await runSwitch(plan, fx.deps, {
      dryRun: true,
      registry: fx.registry,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });

    expect(fx.calls).toEqual([]);
    expect(report.dryRun).toBe(true);
    expect(report.outcome).toBe("dry-run");
    expect(report.ok).toBe(true);
    expect(report.failedAt).toBeNull();
    expect(report.ran).toEqual([]);
    expect(report.steps).toEqual(plannedSteps());
    for (const id of VICTIM_IDS) {
      expect(fx.inner.snapshot(id).phase).toBe("open");
    }
  });
});
