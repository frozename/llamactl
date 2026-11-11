/**
 * #279 DF-06 — RED tests for the fence-admission and drain phases of
 * `executeProfileSwitch` in `src/residency/profile-transition`: with a
 * residency lease registry the executor must fence every victim's
 * admission (`beginDrain`), drain them under one window (`whenIdle`
 * raced against `drainTimeoutMs`), then `stop` + `commitUnload` each
 * victim before starting replacements, cancelling every drain it owns
 * on failure. The module exists at base but ignores the new opts
 * keys, so every fenced case fails by assertion — never by import or
 * type error. The case-5 halves pass at base by design: they pin the
 * inert default and the explicit-null override.
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

import { executeProfileSwitch } from "../../src/residency/profile-transition.js";

beforeEach(() => {
  setResidencyLeaseRegistry(null);
});
afterEach(() => {
  setResidencyLeaseRegistry(null);
});

const NODE = "n1";
const NOW_MS = 1_000_000_000;
const VICTIM_IDS = ["v-a", "v-b", "v-c"];
const REPLACEMENT_IDS = ["r-x", "r-y"];
const DRAIN_TIMEOUT_MS = 25;

const DEFERRED_BASE: StepKind[] = [
  "fence-admission",
  "drain",
  "persist-suppression",
  "verify-release",
  "reserve",
  "verify-ready",
  "publish",
  "complete",
];

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

const FENCED_RUN_CALLS = [
  "beginDrain:v-a",
  "beginDrain:v-b",
  "beginDrain:v-c",
  "whenIdle:v-a",
  "whenIdle:v-b",
  "whenIdle:v-c",
  "stop:v-a",
  "commitUnload:v-a",
  "stop:v-b",
  "commitUnload:v-b",
  "stop:v-c",
  "commitUnload:v-c",
  "start:r-x",
  "start:r-y",
];

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

describe("executeProfileSwitch fence + drain", () => {
  test("fences all victims, drains them under one window, then stops each", async () => {
    const plan = okFleetPlan();
    const fx = makeFixture();

    const report = await runSwitch(plan, fx.deps, {
      dryRun: false,
      registry: fx.registry,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });

    expect(fx.calls).toEqual(FENCED_RUN_CALLS);
    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    expect(report.failedAt).toBeNull();
    expect(report.steps).toEqual([...FENCE_OK, ...DRAIN_OK, ...STOP_OK, ...START_OK]);
    expect(report.ran).toEqual(report.steps);
    expect(report.deferred).toEqual(DEFERRED_FENCED);
    for (const id of VICTIM_IDS) {
      expect(fx.inner.snapshot(id).phase).toBe("unloaded");
    }
    expect(fx.calls.some((entry) => entry.includes("emb"))).toBe(false);
  });

  test("a lease held past the drain window cancels every drain and stops nothing", async () => {
    const plan = okFleetPlan();

    const fxA = makeFixture();
    const held = fxA.inner.acquire("v-b");
    expect(held.ok).toBe(true);
    if (!held.ok) {
      throw new Error("acquire refused");
    }

    const reportA = await runSwitch(plan, fxA.deps, {
      dryRun: false,
      registry: fxA.registry,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });

    expect(fxA.calls).toEqual([
      "beginDrain:v-a",
      "beginDrain:v-b",
      "beginDrain:v-c",
      "whenIdle:v-a",
      "whenIdle:v-b",
      "whenIdle:v-c",
      "cancelDrain:v-a",
      "cancelDrain:v-b",
      "cancelDrain:v-c",
    ]);
    expect(reportA.dryRun).toBe(false);
    expect(reportA.outcome).toBe("failed");
    expect(reportA.ok).toBe(false);
    expect(reportA.failedAt).toEqual({
      action: "drain",
      workload: "v-b",
      detail: "drain timeout",
    });
    expect(reportA.steps).toEqual([
      ...FENCE_OK,
      step("drain", "v-a", "ok"),
      step("drain", "v-b", "failed", "drain timeout"),
      step("drain", "v-c", "ok"),
      ...STOP_NOT_RUN,
      ...START_NOT_RUN,
    ]);
    expect(reportA.ran).toEqual(reportA.steps.slice(0, 6));
    expect(reportA.deferred).toEqual(DEFERRED_FENCED);
    for (const id of VICTIM_IDS) {
      expect(fxA.inner.snapshot(id).phase).toBe("open");
      expect(fxA.inner.waiterCount(id)).toBe(0);
    }
    expect(fxA.inner.snapshot("v-b").active).toContain(held.lease.id);

    const fxB = makeFixture();
    const pre = fxB.inner.beginDrain("v-b");
    expect(pre.ok).toBe(true);

    const reportB = await runSwitch(plan, fxB.deps, {
      dryRun: false,
      registry: fxB.registry,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });

    expect(fxB.calls).toEqual(["beginDrain:v-a", "beginDrain:v-b", "cancelDrain:v-a"]);
    expect(reportB.dryRun).toBe(false);
    expect(reportB.outcome).toBe("failed");
    expect(reportB.ok).toBe(false);
    expect(reportB.failedAt).toEqual({
      action: "fence",
      workload: "v-b",
      detail: "AlreadyDraining",
    });
    expect(reportB.steps).toEqual([
      step("fence", "v-a", "ok"),
      step("fence", "v-b", "failed", "AlreadyDraining"),
      step("fence", "v-c", "not-run"),
      ...DRAIN_NOT_RUN,
      ...STOP_NOT_RUN,
      ...START_NOT_RUN,
    ]);
    expect(reportB.ran).toEqual(reportB.steps.slice(0, 2));
    expect(fxB.inner.snapshot("v-a").phase).toBe("open");
    expect(fxB.inner.snapshot("v-b").phase).toBe("draining");
  });

  test("dry-run with a registry plans fence and drain but touches nothing", async () => {
    const plan = okFleetPlan();
    const fx = makeFixture();

    const report = await runSwitch(plan, fx.deps, {
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
    expect(report.deferred).toEqual(DEFERRED_FENCED);
    for (const id of VICTIM_IDS) {
      const snap = fx.inner.snapshot(id);
      expect(snap.phase).toBe("open");
      expect(snap.epoch).toBe(0);
    }
  });

  test("a malformed step outcome fails closed with the partial report intact", async () => {
    const plan = okFleetPlan();

    const fxA = makeFixture({ "stop:v-b": () => undefined });
    const reportA = await runSwitch(plan, fxA.deps, { dryRun: false });
    expect(fxA.calls).toEqual(["stop:v-a", "stop:v-b"]);
    expect(reportA.dryRun).toBe(false);
    expect(reportA.outcome).toBe("failed");
    expect(reportA.ok).toBe(false);
    expect(reportA.failedAt).toEqual({
      action: "stop",
      workload: "v-b",
      detail: "invalid step outcome",
    });
    expect(reportA.steps).toEqual([
      step("stop", "v-a", "ok"),
      step("stop", "v-b", "failed", "invalid step outcome"),
      step("stop", "v-c", "not-run"),
      step("start", "r-x", "not-run"),
      step("start", "r-y", "not-run"),
    ]);
    expect(reportA.deferred).toEqual(DEFERRED_BASE);

    const fxB = makeFixture({ "stop:v-a": () => ({ ok: 1 }) });
    const reportB = await runSwitch(plan, fxB.deps, { dryRun: false });
    expect(fxB.calls).toEqual(["stop:v-a"]);
    expect(reportB.dryRun).toBe(false);
    expect(reportB.outcome).toBe("failed");
    expect(reportB.ok).toBe(false);
    expect(reportB.failedAt).toEqual({
      action: "stop",
      workload: "v-a",
      detail: "invalid step outcome",
    });
    expect(reportB.steps).toEqual([
      step("stop", "v-a", "failed", "invalid step outcome"),
      step("stop", "v-b", "not-run"),
      step("stop", "v-c", "not-run"),
      step("start", "r-x", "not-run"),
      step("start", "r-y", "not-run"),
    ]);

    const fxC = makeFixture({ "stop:v-b": () => undefined });
    const reportC = await runSwitch(plan, fxC.deps, {
      dryRun: false,
      registry: fxC.registry,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });
    expect(fxC.calls).toEqual([
      "beginDrain:v-a",
      "beginDrain:v-b",
      "beginDrain:v-c",
      "whenIdle:v-a",
      "whenIdle:v-b",
      "whenIdle:v-c",
      "stop:v-a",
      "commitUnload:v-a",
      "stop:v-b",
      "cancelDrain:v-b",
      "cancelDrain:v-c",
    ]);
    expect(reportC.dryRun).toBe(false);
    expect(reportC.outcome).toBe("failed");
    expect(reportC.ok).toBe(false);
    expect(reportC.failedAt).toEqual({
      action: "stop",
      workload: "v-b",
      detail: "invalid step outcome",
    });
    expect(reportC.steps).toEqual([
      ...FENCE_OK,
      ...DRAIN_OK,
      step("stop", "v-a", "ok"),
      step("stop", "v-b", "failed", "invalid step outcome"),
      step("stop", "v-c", "not-run"),
      step("start", "r-x", "not-run"),
      step("start", "r-y", "not-run"),
    ]);
    expect(reportC.deferred).toEqual(DEFERRED_FENCED);
    expect(fxC.inner.snapshot("v-a").phase).toBe("unloaded");
    expect(fxC.inner.snapshot("v-b").phase).toBe("open");
    expect(fxC.inner.snapshot("v-c").phase).toBe("open");

    const fxD = makeFixture({
      "stop:v-a": (workload, inner) => {
        inner.cancelDrain({ workload, epoch: inner.snapshot(workload).epoch });
        return { ok: true };
      },
    });
    const reportD = await runSwitch(plan, fxD.deps, {
      dryRun: false,
      registry: fxD.registry,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });
    expect(reportD.dryRun).toBe(false);
    expect(reportD.outcome).toBe("failed");
    expect(reportD.ok).toBe(false);
    expect(reportD.failedAt).toEqual({
      action: "stop",
      workload: "v-a",
      detail: "commit StaleDrainToken",
    });
    expect(reportD.steps).toEqual([
      ...FENCE_OK,
      ...DRAIN_OK,
      step("stop", "v-a", "failed", "commit StaleDrainToken"),
      step("stop", "v-b", "not-run"),
      step("stop", "v-c", "not-run"),
      step("start", "r-x", "not-run"),
      step("start", "r-y", "not-run"),
    ]);
    expect(
      fxD.calls.filter((entry) => entry.startsWith("stop:") || entry.startsWith("start:")),
    ).toEqual(["stop:v-a"]);
    expect(fxD.inner.snapshot("v-a").phase).toBe("open");
    expect(fxD.inner.snapshot("v-b").phase).toBe("open");
    expect(fxD.inner.snapshot("v-c").phase).toBe("open");
  });

  test("inert without a published registry; the published seam opts in", async () => {
    const plan = okFleetPlan();

    const fxA = makeFixture();
    const reportA = await runSwitch(plan, fxA.deps, { dryRun: false });
    expect(fxA.calls).toEqual(["stop:v-a", "stop:v-b", "stop:v-c", "start:r-x", "start:r-y"]);
    expect(reportA.dryRun).toBe(false);
    expect(reportA.outcome).toBe("stops-and-starts-ran");
    expect(reportA.ok).toBe(true);
    expect(reportA.steps).toEqual([...STOP_OK, ...START_OK]);
    expect(reportA.deferred).toEqual(DEFERRED_BASE);

    const fxB = makeFixture();
    setResidencyLeaseRegistry(fxB.registry);
    const reportB = await runSwitch(plan, fxB.deps, {
      dryRun: false,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });
    expect(fxB.calls[0]).toBe("beginDrain:v-a");
    const thirdWhenIdle = fxB.calls.indexOf("whenIdle:v-c");
    const firstStop = fxB.calls.findIndex((entry) => entry.startsWith("stop:"));
    expect(thirdWhenIdle).toBeGreaterThanOrEqual(0);
    expect(firstStop).toBeGreaterThan(thirdWhenIdle);
    expect(fxB.calls).toEqual(FENCED_RUN_CALLS);
    expect(reportB.dryRun).toBe(false);
    expect(reportB.outcome).toBe("stops-and-starts-ran");
    expect(reportB.ok).toBe(true);
    expect(reportB.steps).toEqual([...FENCE_OK, ...DRAIN_OK, ...STOP_OK, ...START_OK]);
    expect(reportB.deferred).toEqual(DEFERRED_FENCED);

    const mark = fxB.calls.length;
    const reportC = await runSwitch(plan, fxB.deps, { dryRun: false, registry: null });
    const cCalls = fxB.calls.slice(mark);
    expect(cCalls).toEqual(["stop:v-a", "stop:v-b", "stop:v-c", "start:r-x", "start:r-y"]);
    expect(cCalls.some((entry) => entry.startsWith("beginDrain:"))).toBe(false);
    expect(reportC.dryRun).toBe(false);
    expect(reportC.outcome).toBe("stops-and-starts-ran");
    expect(reportC.ok).toBe(true);
    expect(reportC.steps).toEqual([...STOP_OK, ...START_OK]);
    expect(reportC.deferred).toEqual(DEFERRED_BASE);
  });
});
