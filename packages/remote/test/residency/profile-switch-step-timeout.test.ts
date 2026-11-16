/**
 * #279 DF-06 — RED tests for per-step timeouts in the profile-switch
 * executor (`src/residency/profile-transition`): each `stop` dep call is
 * bounded by `opts.stepTimeouts.unloadMs` and each `start` dep call by
 * `opts.stepTimeouts.loadMs`, armed through the injectable
 * `opts.stepTimer`, and a timeout fails the step as `StepTimedOut`
 * carrying `reason`/`timeoutMs` on both the step record and
 * `failedAt`, aborts the per-step signal handed to the dep, and beats
 * the operation heartbeat once at the timed-out boundary. A timed-out
 * victim is deliberately left fenced — its drain is not cancelled and
 * its unload is not committed — because the dep may still be in
 * flight; only later victims' drains are released. Absent, zero or
 * NaN budgets stay unbounded. At base the executor ignores
 * `stepTimeouts`/`stepTimer` and passes no ctx signal to deps, so every
 * bounded case fails BY ASSERTION — never by import, type or bun
 * timeout. Store reads are assertion-first (`expect(rec).not.toBeNull()`
 * then `rec?.field`); no non-null assertions.
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

import { createResidencyLeases, setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { planProfileSwitch } from "@llamactl/core/residency/planner";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeProfileSwitch } from "../../src/residency/profile-transition.js";
import {
  openResidencyOperationStore,
  type ResidencyOperationStore,
} from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

let dir = "";
let store: ResidencyOperationStore;
let fenceToken = 0;

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  dir = mkdtempSync(join(tmpdir(), "llamactl-profile-step-timeout-"));
  store = openResidencyOperationStore({ path: join(dir, "operations.sqlite") });
  fenceToken = store.claimOwnership({ ownerId: "test", incarnation: "i1" }).fenceToken;
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  store.close();
  if (dir !== "") {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

const NODE = "n1";
const NOW_MS = 1_000_000_000;
const VICTIM_IDS = ["v-a", "v-b", "v-c"];
const REPLACEMENT_IDS = ["r-x", "r-y"];

type StepAction = "fence" | "drain" | "stop" | "start";
type StepStatus = "planned" | "ok" | "failed" | "not-run";

interface SwitchStep {
  action: StepAction;
  workload: string;
  status: StepStatus;
  detail?: string;
  reason?: string;
  timeoutMs?: number;
}

interface StepFailure {
  action: StepAction;
  workload: string;
  detail: string;
  reason?: string;
  timeoutMs?: number;
}

type SwitchOperation = {
  store: Pick<
    ResidencyOperationStore,
    "beginOperation" | "finishOperation" | "listNonterminal" | "touchOperation"
  >;
  fenceToken: number;
  operationId: string;
  desiredRevision: number;
  nowMs?: () => number;
};

type StepTimeouts = { unloadMs?: number; loadMs?: number };
type StepTimer = (ms: number, onTimeout: () => void) => () => void;

type ExecuteOpts = {
  dryRun?: boolean;
  registry?: ResidencyLeases | null;
  drainTimeoutMs?: number;
  signal?: AbortSignal;
  operation?: SwitchOperation;
  stepTimeouts?: StepTimeouts;
  stepTimer?: StepTimer;
};

interface Report {
  dryRun: boolean;
  outcome: string;
  ok: boolean;
  steps: SwitchStep[];
  ran: SwitchStep[];
  failedAt: StepFailure | null;
  deferred: StepKind[];
  busy?: { reason: string; node: string; operationId: string; detail: string };
  cancelledAt?: { action: string; workload: string } | null;
  operation?: { id: string; outcome: string; recorded: boolean; recordFailure?: string };
  refusal?: { reason: string; detail: string };
}

type DepCtx = { signal?: AbortSignal };

type LooseDeps = {
  stop: (w: string, ctx?: DepCtx) => Promise<unknown>;
  start: (w: string, ctx?: DepCtx) => Promise<unknown>;
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

function timedOutStep(action: StepAction, workload: string, timeoutMs: number): SwitchStep {
  return {
    action,
    workload,
    status: "failed",
    detail: `StepTimedOut: ${action} exceeded ${String(timeoutMs)}ms`,
    reason: "StepTimedOut",
    timeoutMs,
  };
}

type DepImpl = (id: string, ctx?: DepCtx) => unknown;

function makeDeps(overrides: Record<string, DepImpl> = {}): {
  calls: string[];
  signals: (AbortSignal | undefined)[];
  deps: LooseDeps;
} {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const invoke = (label: "stop" | "start", id: string, ctx?: DepCtx): Promise<unknown> => {
    calls.push(`${label}:${id}`);
    signals.push(ctx?.signal);
    const impl = overrides[`${label}:${id}`];
    return Promise.resolve(impl === undefined ? { ok: true } : impl(id, ctx));
  };
  return {
    calls,
    signals,
    deps: {
      stop: (id, ctx) => invoke("stop", id, ctx),
      start: (id, ctx) => invoke("start", id, ctx),
    },
  };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = (): void => {
      resolve(undefined);
    };
  });
  return { promise, release };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

type ArmedTimer = { ms: number; fire: () => void; cancelled: boolean };
type ManualTimer = { armed: ArmedTimer[]; stepTimer: StepTimer };

function manualTimer(): ManualTimer {
  const armed: ArmedTimer[] = [];
  const stepTimer: StepTimer = (ms, onTimeout) => {
    const entry: ArmedTimer = {
      ms,
      fire: () => {
        onTimeout();
      },
      cancelled: false,
    };
    armed.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return { armed, stepTimer };
}

function armedAt(timer: ManualTimer, index: number): ArmedTimer {
  const entry = timer.armed[index];
  expect(entry).toBeDefined();
  if (entry === undefined) {
    throw new Error(`expected an armed step timer at index ${String(index)}`);
  }
  return entry;
}

async function runSwitch(
  plan: ProfileSwitchPlan,
  deps: LooseDeps,
  opts?: ExecuteOpts,
): Promise<Report> {
  const result = (await run(plan, deps, opts).catch((error: unknown) => ({
    rejected: String(error),
  }))) as Report & { rejected?: string };
  expect(result.rejected).toBeUndefined();
  return result;
}

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

function touchCountingStore(inner: ResidencyOperationStore): {
  store: SwitchOperation["store"];
  touches: () => number;
} {
  let count = 0;
  return {
    touches: () => count,
    store: {
      beginOperation: (input) => inner.beginOperation(input),
      finishOperation: (input) => inner.finishOperation(input),
      listNonterminal: () => inner.listNonterminal(),
      touchOperation: (input): ReturnType<ResidencyOperationStore["touchOperation"]> => {
        count += 1;
        return inner.touchOperation(input);
      },
    },
  };
}

describe("executeProfileSwitch per-step timeouts", () => {
  test("an unfenced hung stop dep fails at unloadMs, aborts its step signal and ignores the late resolution", async () => {
    // Kills: no timeout race around a dep call; continuing to later steps
    // after a timeout; reading the stop budget from loadMs; leaving the
    // step signal unaborted on timeout; acting on the dep's late resolve.
    const plan = okFleetPlan();
    const timer = manualTimer();
    const entered = deferred();
    const gate = deferred();
    const fx = makeDeps({
      "stop:v-a": () => {
        entered.release();
        return gate.promise.then(() => ({ ok: true }));
      },
    });

    const p = runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: null,
      stepTimeouts: { unloadMs: 60_000 },
      stepTimer: timer.stepTimer,
    });
    await entered.promise;
    await flushMicrotasks();

    try {
      expect(timer.armed.map((t) => t.ms)).toEqual([60_000]);
      const first = armedAt(timer, 0);
      expect(first.cancelled).toBe(false);
      first.fire();
      const report = await p;

      expect(report.outcome).toBe("failed");
      expect(report.ok).toBe(false);
      expect(report.failedAt).toEqual({
        action: "stop",
        workload: "v-a",
        detail: "StepTimedOut: stop exceeded 60000ms",
        reason: "StepTimedOut",
        timeoutMs: 60_000,
      });
      expect(report.steps).toEqual([
        timedOutStep("stop", "v-a", 60_000),
        step("stop", "v-b", "not-run"),
        step("stop", "v-c", "not-run"),
        step("start", "r-x", "not-run"),
        step("start", "r-y", "not-run"),
      ]);
      expect(fx.calls).toEqual(["stop:v-a"]);
      expect(fx.signals[0]?.aborted).toBe(true);

      const snapshot = report.steps.map((s) => ({ ...s }));
      gate.release();
      await flushMicrotasks();
      expect(report.steps).toEqual(snapshot);
    } finally {
      gate.release();
      await p.catch(() => undefined);
    }
  });

  test("a hung start dep fails at loadMs after the settled stops cancel their unload timers", async () => {
    // Kills: start steps not bounded by loadMs; a settled step's timer left
    // armed; the start budget read from unloadMs; the start signal left
    // unaborted on timeout.
    const plan = okFleetPlan();
    const timer = manualTimer();
    const entered = deferred();
    const gate = deferred();
    const fx = makeDeps({
      "start:r-x": () => {
        entered.release();
        return gate.promise.then(() => ({ ok: true }));
      },
    });

    const p = runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: null,
      stepTimeouts: { unloadMs: 60_000, loadMs: 600_000 },
      stepTimer: timer.stepTimer,
    });
    await entered.promise;
    await flushMicrotasks();

    try {
      expect(timer.armed.map((t) => t.ms)).toEqual([60_000, 60_000, 60_000, 600_000]);
      expect(timer.armed.slice(0, 3).every((t) => t.cancelled)).toBe(true);
      const hung = armedAt(timer, 3);
      expect(hung.cancelled).toBe(false);
      hung.fire();
      const report = await p;

      expect(report.outcome).toBe("failed");
      expect(report.ok).toBe(false);
      expect(report.failedAt).toEqual({
        action: "start",
        workload: "r-x",
        detail: "StepTimedOut: start exceeded 600000ms",
        reason: "StepTimedOut",
        timeoutMs: 600_000,
      });
      expect(report.steps).toEqual([
        step("stop", "v-a", "ok"),
        step("stop", "v-b", "ok"),
        step("stop", "v-c", "ok"),
        timedOutStep("start", "r-x", 600_000),
        step("start", "r-y", "not-run"),
      ]);
      expect(fx.calls).toEqual(["stop:v-a", "stop:v-b", "stop:v-c", "start:r-x"]);
      expect(fx.signals[3]?.aborted).toBe(true);
    } finally {
      gate.release();
      await p.catch(() => undefined);
    }
  });

  test("a fenced hung stop keeps the timed-out victim fenced while later drains are cancelled", async () => {
    // Kills: a timeout applied only in the unfenced runSteps path and not
    // in runStopOne/stopPhase; committing the unload of a victim whose
    // stop may still be in flight; reopening admission (cancelDrain) on
    // that victim while later victims' drains are released.
    const plan = okFleetPlan();
    const timer = manualTimer();
    const inner = createResidencyLeases();
    const entered = deferred();
    const gate = deferred();
    const fx = makeDeps({
      "stop:v-b": () => {
        entered.release();
        return gate.promise.then(() => ({ ok: true }));
      },
    });
    const registry = recordingRegistry(inner, fx.calls);

    const p = runSwitch(plan, fx.deps, {
      dryRun: false,
      registry,
      stepTimeouts: { unloadMs: 60_000 },
      stepTimer: timer.stepTimer,
    });
    await entered.promise;
    await flushMicrotasks();

    try {
      expect(timer.armed.map((t) => t.ms)).toEqual([60_000, 60_000]);
      expect(armedAt(timer, 0).cancelled).toBe(true);
      const hung = armedAt(timer, 1);
      expect(hung.cancelled).toBe(false);
      hung.fire();
      const report = await p;

      expect(report.outcome).toBe("failed");
      expect(report.ok).toBe(false);
      expect(report.failedAt).toEqual({
        action: "stop",
        workload: "v-b",
        detail: "StepTimedOut: stop exceeded 60000ms",
        reason: "StepTimedOut",
        timeoutMs: 60_000,
      });
      expect(report.steps).toEqual([
        step("fence", "v-a", "ok"),
        step("fence", "v-b", "ok"),
        step("fence", "v-c", "ok"),
        step("drain", "v-a", "ok"),
        step("drain", "v-b", "ok"),
        step("drain", "v-c", "ok"),
        step("stop", "v-a", "ok"),
        timedOutStep("stop", "v-b", 60_000),
        step("stop", "v-c", "not-run"),
        step("start", "r-x", "not-run"),
        step("start", "r-y", "not-run"),
      ]);
      expect(fx.calls.filter((c) => c.startsWith("stop:"))).toEqual(["stop:v-a", "stop:v-b"]);
      expect(fx.calls).toContain("commitUnload:v-a");
      expect(fx.calls).toContain("cancelDrain:v-c");
      expect(fx.calls).not.toContain("cancelDrain:v-b");
      expect(fx.calls).not.toContain("commitUnload:v-b");

      const stillDraining = inner.beginDrain("v-b");
      expect(stillDraining.ok).toBe(false);
      if (!stillDraining.ok) {
        expect(stillDraining.reason).toBe("AlreadyDraining");
      }
      expect(inner.beginDrain("v-c").ok).toBe(true);
    } finally {
      gate.release();
      await p.catch(() => undefined);
    }
  });

  test("deps that settle inside their budgets succeed with every step timer cancelled and no step reason", async () => {
    // Kills: no timer armed per step; a settled step's timer left armed;
    // aborting the per-step signal on success; a reason stamped on ok
    // steps.
    const plan = okFleetPlan();
    const timer = manualTimer();
    const fx = makeDeps();

    const report = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: null,
      stepTimeouts: { unloadMs: 60_000, loadMs: 600_000 },
      stepTimer: timer.stepTimer,
    });

    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    expect(report.steps).toEqual([
      step("stop", "v-a", "ok"),
      step("stop", "v-b", "ok"),
      step("stop", "v-c", "ok"),
      step("start", "r-x", "ok"),
      step("start", "r-y", "ok"),
    ]);
    expect(timer.armed.map((t) => t.ms)).toEqual([60_000, 60_000, 60_000, 600_000, 600_000]);
    expect(timer.armed.every((t) => t.cancelled)).toBe(true);
    for (const s of report.steps) {
      expect(s).not.toHaveProperty("reason");
    }
    expect(fx.calls).toEqual(["stop:v-a", "stop:v-b", "stop:v-c", "start:r-x", "start:r-y"]);
    expect(fx.signals).toHaveLength(5);
    for (const signal of fx.signals) {
      expect(signal?.aborted).toBe(false);
    }
  });

  test("absent, zero or NaN step budgets stay unbounded per action", async () => {
    // Kills: defaulting an absent/0/NaN budget to
    // DEFAULT_PROFILE_SWITCH_TIMEOUTS; treating 0 as an immediate
    // timeout. Base fails on run A's armed list.
    const plan = okFleetPlan();

    const timerA = manualTimer();
    const enteredA = deferred();
    const gateA = deferred();
    const fxA = makeDeps({
      "stop:v-a": () => {
        enteredA.release();
        return gateA.promise.then(() => ({ ok: true }));
      },
    });
    const pA = runSwitch(plan, fxA.deps, {
      dryRun: false,
      registry: null,
      stepTimeouts: { loadMs: 600_000, unloadMs: 0 },
      stepTimer: timerA.stepTimer,
    });
    await enteredA.promise;
    await flushMicrotasks();
    try {
      expect(timerA.armed).toEqual([]);
      gateA.release();
      const reportA = await pA;
      expect(reportA.outcome).toBe("stops-and-starts-ran");
      expect(reportA.ok).toBe(true);
      expect(reportA.steps).toEqual([
        step("stop", "v-a", "ok"),
        step("stop", "v-b", "ok"),
        step("stop", "v-c", "ok"),
        step("start", "r-x", "ok"),
        step("start", "r-y", "ok"),
      ]);
      expect(timerA.armed.map((t) => t.ms)).toEqual([600_000, 600_000]);
      expect(timerA.armed.every((t) => t.cancelled)).toBe(true);
    } finally {
      gateA.release();
      await pA.catch(() => undefined);
    }

    const timerB = manualTimer();
    const fxB = makeDeps();
    const reportB = await runSwitch(plan, fxB.deps, {
      dryRun: false,
      registry: null,
      stepTimeouts: { unloadMs: Number.NaN },
      stepTimer: timerB.stepTimer,
    });
    expect(reportB.outcome).toBe("stops-and-starts-ran");
    expect(timerB.armed).toEqual([]);

    const timerC = manualTimer();
    const fxC = makeDeps();
    const reportC = await runSwitch(plan, fxC.deps, {
      dryRun: false,
      registry: null,
      stepTimer: timerC.stepTimer,
    });
    expect(reportC.outcome).toBe("stops-and-starts-ran");
    expect(timerC.armed).toEqual([]);
    for (const signal of fxC.signals) {
      expect(signal?.aborted ?? false).toBe(false);
    }
  });

  test("a step timeout still terminalizes the operation record once and releases the per-node lock", async () => {
    // Kills: a timeout path that skips finishOperation or throws; a
    // step-boundary beat skipped or doubled on timeout.
    const plan = okFleetPlan();
    const timer = manualTimer();
    const port = touchCountingStore(store);
    const entered = deferred();
    const gate = deferred();
    const fx = makeDeps({
      "stop:v-a": () => {
        entered.release();
        return gate.promise.then(() => ({ ok: true }));
      },
    });
    const operationId = "op-step-timeout";

    const p = runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: null,
      stepTimeouts: { unloadMs: 60_000 },
      stepTimer: timer.stepTimer,
      operation: {
        store: port.store,
        fenceToken,
        operationId,
        desiredRevision: 0,
        nowMs: () => 1_000,
      },
    });
    await entered.promise;
    await flushMicrotasks();

    try {
      expect(timer.armed.map((t) => t.ms)).toEqual([60_000]);
      const first = armedAt(timer, 0);
      first.fire();
      const report = await p;

      expect(report.outcome).toBe("failed");
      expect(report.operation).toEqual({ id: operationId, outcome: "failed", recorded: true });

      const rec = store.getOperation(operationId);
      expect(rec).not.toBeNull();
      expect(rec?.phase).toBe("terminal");
      expect(rec?.outcome).toBe("failed");
      expect(rec?.detail).toContain("stop v-a: StepTimedOut");
      expect(port.touches()).toBe(1);

      const timerNext = manualTimer();
      const fxNext = makeDeps();
      const next = await runSwitch(plan, fxNext.deps, {
        dryRun: false,
        registry: null,
        stepTimeouts: { unloadMs: 60_000, loadMs: 600_000 },
        stepTimer: timerNext.stepTimer,
        operation: {
          store: port.store,
          fenceToken,
          operationId: "op-step-timeout-next",
          desiredRevision: 0,
          nowMs: () => 1_000,
        },
      });
      expect(next.outcome).toBe("stops-and-starts-ran");
      expect(next.busy).toBeUndefined();
    } finally {
      gate.release();
      await p.catch(() => undefined);
    }
  });

  test("a budgeted stop or start dep that throws synchronously records failedAt with the thrown detail", async () => {
    // Kills: calling a budgeted dep outside any guard, so a synchronous
    // throw escapes runStep and rejects executeProfileSwitch instead of
    // being recorded as { ok: false, detail } like the unbudgeted path.
    const plan = okFleetPlan();

    const timerStop = manualTimer();
    const fxStop = makeDeps({
      "stop:v-b": () => {
        throw new Error("stop exploded");
      },
    });
    const stopReport = await runSwitch(plan, fxStop.deps, {
      dryRun: false,
      registry: null,
      stepTimeouts: { unloadMs: 60_000, loadMs: 600_000 },
      stepTimer: timerStop.stepTimer,
      operation: {
        store,
        fenceToken,
        operationId: "op-sync-throw-stop",
        desiredRevision: 0,
        nowMs: () => 1_000,
      },
    });
    expect(stopReport.outcome).toBe("failed");
    expect(stopReport.ok).toBe(false);
    expect(stopReport.failedAt).toEqual({
      action: "stop",
      workload: "v-b",
      detail: "stop exploded",
    });
    expect(stopReport.steps).toEqual([
      step("stop", "v-a", "ok"),
      step("stop", "v-b", "failed", "stop exploded"),
      step("stop", "v-c", "not-run"),
      step("start", "r-x", "not-run"),
      step("start", "r-y", "not-run"),
    ]);
    expect(stopReport.operation).toEqual({
      id: "op-sync-throw-stop",
      outcome: "failed",
      recorded: true,
    });
    expect(timerStop.armed.every((t) => t.cancelled)).toBe(true);
    expect(fxStop.calls).toEqual(["stop:v-a", "stop:v-b"]);

    const timerStart = manualTimer();
    const fxStart = makeDeps({
      "start:r-x": () => {
        throw new Error("start exploded");
      },
    });
    const startReport = await runSwitch(plan, fxStart.deps, {
      dryRun: false,
      registry: null,
      stepTimeouts: { unloadMs: 60_000, loadMs: 600_000 },
      stepTimer: timerStart.stepTimer,
    });
    expect(startReport.outcome).toBe("failed");
    expect(startReport.ok).toBe(false);
    expect(startReport.failedAt).toEqual({
      action: "start",
      workload: "r-x",
      detail: "start exploded",
    });
    expect(startReport.steps).toEqual([
      step("stop", "v-a", "ok"),
      step("stop", "v-b", "ok"),
      step("stop", "v-c", "ok"),
      step("start", "r-x", "failed", "start exploded"),
      step("start", "r-y", "not-run"),
    ]);
    expect(timerStart.armed.every((t) => t.cancelled)).toBe(true);
  });

  test("a budgeted dep returning a non-promise outcome is handled like an awaited one", async () => {
    // Kills: chaining .then directly on a budgeted dep's return value,
    // which throws a TypeError for a plain object and rejects the run.
    const plan = okFleetPlan();
    const timer = manualTimer();
    const calls: string[] = [];
    const deps = {
      stop: (id: string): unknown => {
        calls.push(`stop:${id}`);
        return id === "v-c" ? undefined : { ok: true };
      },
      start: (id: string): unknown => {
        calls.push(`start:${id}`);
        return { ok: false, detail: "no room" };
      },
    } as unknown as LooseDeps;

    const report = await runSwitch(plan, deps, {
      dryRun: false,
      registry: null,
      stepTimeouts: { unloadMs: 60_000, loadMs: 600_000 },
      stepTimer: timer.stepTimer,
    });
    expect(report.outcome).toBe("failed");
    expect(report.failedAt).toEqual({
      action: "stop",
      workload: "v-c",
      detail: "invalid step outcome",
    });
    expect(calls).toEqual(["stop:v-a", "stop:v-b", "stop:v-c"]);

    const timerOk = manualTimer();
    const okCalls: string[] = [];
    const okDeps = {
      stop: (id: string): unknown => {
        okCalls.push(`stop:${id}`);
        return { ok: true };
      },
      start: (id: string): unknown => {
        okCalls.push(`start:${id}`);
        return id === "r-y" ? { ok: false, detail: "no room" } : { ok: true };
      },
    } as unknown as LooseDeps;
    const okReport = await runSwitch(plan, okDeps, {
      dryRun: false,
      registry: null,
      stepTimeouts: { unloadMs: 60_000, loadMs: 600_000 },
      stepTimer: timerOk.stepTimer,
    });
    expect(okReport.outcome).toBe("failed");
    expect(okReport.failedAt).toEqual({ action: "start", workload: "r-y", detail: "no room" });
    expect(okReport.steps).toEqual([
      step("stop", "v-a", "ok"),
      step("stop", "v-b", "ok"),
      step("stop", "v-c", "ok"),
      step("start", "r-x", "ok"),
      step("start", "r-y", "failed", "no room"),
    ]);
    expect(okCalls).toEqual(["stop:v-a", "stop:v-b", "stop:v-c", "start:r-x", "start:r-y"]);
    expect(timerOk.armed.every((t) => t.cancelled)).toBe(true);
  });

  test("a fenced budgeted stop that throws synchronously releases its drains", async () => {
    // Kills: a synchronous throw from a budgeted fenced stop escaping
    // runStopOne/stopPhase before cancelBestEffort, leaking the failed
    // victim's and later victims' drain tokens (admission stays closed).
    const plan = okFleetPlan();
    const timer = manualTimer();
    const inner = createResidencyLeases();
    const fx = makeDeps({
      "stop:v-b": () => {
        throw new Error("stop exploded");
      },
    });
    const registry = recordingRegistry(inner, fx.calls);

    const report = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry,
      stepTimeouts: { unloadMs: 60_000 },
      stepTimer: timer.stepTimer,
    });

    expect(report.outcome).toBe("failed");
    expect(report.ok).toBe(false);
    expect(report.failedAt).toEqual({ action: "stop", workload: "v-b", detail: "stop exploded" });
    expect(report.steps).toEqual([
      step("fence", "v-a", "ok"),
      step("fence", "v-b", "ok"),
      step("fence", "v-c", "ok"),
      step("drain", "v-a", "ok"),
      step("drain", "v-b", "ok"),
      step("drain", "v-c", "ok"),
      step("stop", "v-a", "ok"),
      step("stop", "v-b", "failed", "stop exploded"),
      step("stop", "v-c", "not-run"),
      step("start", "r-x", "not-run"),
      step("start", "r-y", "not-run"),
    ]);
    expect(fx.calls).toContain("commitUnload:v-a");
    expect(fx.calls).toContain("cancelDrain:v-b");
    expect(fx.calls).toContain("cancelDrain:v-c");
    expect(fx.calls).not.toContain("commitUnload:v-b");
    expect(inner.beginDrain("v-b").ok).toBe(true);
    expect(inner.beginDrain("v-c").ok).toBe(true);
    expect(timer.armed.every((t) => t.cancelled)).toBe(true);
  });
});
