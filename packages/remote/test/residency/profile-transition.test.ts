/**
 * #279 DF-06 — RED tests for `executeProfileSwitch` in
 * `src/residency/profile-transition`: execute a planned profile
 * switch through verified eviction (`deps.stop` per victim) and
 * admission (`deps.start` per replacement), dry-run by default and
 * stopping at the first failed step. The module lands with the fix,
 * so it is reached through a guarded dynamic import: at base the
 * module is absent, `.catch` yields {}, and each case fails by
 * assertion — never by a missing module or a type error. The
 * specifier stays a `string` (not a literal) so `tsc` cannot
 * resolve it at base.
 */
import type {
  OkPlan,
  PlannerWorkload,
  ProfileSwitchPlan,
  ProfileSwitchRequest,
  RefusalPlan,
  StepKind,
} from "@llamactl/core/residency/planner";

import { planProfileSwitch } from "@llamactl/core/residency/planner";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// Widened to `string` on purpose: a literal specifier would let `tsc`
// resolve (and fail on) the not-yet-existing module at base.
const TRANSITION_SPEC = "../../src/residency/profile-transition.js" as string;

const NODE = "n1";
const NOW_MS = 1_000_000_000;
const VICTIM_IDS = ["v-a", "v-b", "v-c"];
const REPLACEMENT_IDS = ["r-x", "r-y"];

const DEFERRED_KINDS: StepKind[] = [
  "fence-admission",
  "drain",
  "persist-suppression",
  "verify-release",
  "reserve",
  "verify-ready",
  "publish",
  "complete",
];

type StepAction = "stop" | "start";
type StepStatus = "planned" | "ok" | "failed" | "not-run";
type StepResult = { ok: true } | { ok: false; detail: string };
type FakeMode = "unverified" | "admission refused" | "throw";

interface Step {
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

interface Refusal {
  reason: string;
  detail: string;
}

interface Report {
  dryRun: boolean;
  outcome: "dry-run" | "stops-and-starts-ran" | "failed" | "refused" | "noop";
  ok: boolean;
  steps: Step[];
  ran: Step[];
  failedAt: StepFailure | null;
  deferred: StepKind[];
  refusal: Refusal | null;
}

interface Deps {
  stop: (workload: string) => Promise<StepResult>;
  start: (workload: string) => Promise<StepResult>;
}

interface ProfileTransitionModule {
  executeProfileSwitch?: (
    plan: ProfileSwitchPlan,
    deps: Deps,
    opts?: { dryRun?: boolean },
  ) => Promise<Report>;
}

async function transition(): Promise<ProfileTransitionModule> {
  const loaded = (await import(TRANSITION_SPEC).catch(() => ({}))) as unknown;
  return loaded as ProfileTransitionModule;
}

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

function refusedPlan(plan: ProfileSwitchPlan): RefusalPlan {
  expect(plan.ok).toBe(false);
  if (plan.ok) {
    throw new Error("expected refused plan");
  }
  return plan;
}

function okFleetPlan(spec: { to?: string; budgetGiB?: number } = {}): OkPlan {
  const plan = okPlan(planProfileSwitch(fleetRequest(spec)));
  expect(plan.victims).toEqual(VICTIM_IDS);
  expect(plan.replacements).toEqual(REPLACEMENT_IDS);
  return plan;
}

function refusedFleetPlan(): RefusalPlan {
  const plan = refusedPlan(planProfileSwitch(fleetRequest({ budgetGiB: 1 })));
  expect(plan.reason).toBe("OverBudget");
  return plan;
}

function noopFleetPlan(): OkPlan {
  const plan = okPlan(planProfileSwitch(fleetRequest({ to: "maintenance" })));
  expect(plan.noop).toBe(true);
  expect(plan.victims).toEqual([]);
  expect(plan.replacements).toEqual([]);
  return plan;
}

function makeFakes(overrides: Record<string, FakeMode> = {}): { calls: string[]; deps: Deps } {
  const calls: string[] = [];
  const invoke = (label: StepAction, id: string): Promise<StepResult> => {
    calls.push(`${label}:${id}`);
    const mode = overrides[id];
    if (mode === "throw") {
      return Promise.reject(new Error("boom"));
    }
    if (mode === undefined) {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ ok: false, detail: mode });
  };
  return {
    calls,
    deps: {
      stop: (id: string): Promise<StepResult> => invoke("stop", id),
      start: (id: string): Promise<StepResult> => invoke("start", id),
    },
  };
}

function stopStep(id: string, status: StepStatus, detail?: string): Step {
  return {
    action: "stop",
    workload: id,
    status,
    ...(detail === undefined ? {} : { detail }),
  };
}

function startStep(id: string, status: StepStatus, detail?: string): Step {
  return {
    action: "start",
    workload: id,
    status,
    ...(detail === undefined ? {} : { detail }),
  };
}

function deferredOf(plan: OkPlan): StepKind[] {
  return plan.steps
    .map((step) => step.kind)
    .filter((kind) => kind !== "unload" && kind !== "start");
}

function expectDeferred(report: Report, plan: OkPlan): void {
  const deferred = deferredOf(plan);
  expect(deferred).toEqual(DEFERRED_KINDS);
  expect(report.deferred).toEqual(deferred);
}

describe("executeProfileSwitch", () => {
  test("defaults to dry-run: planned steps, deferred kinds, deps untouched", async () => {
    const fn = (await transition()).executeProfileSwitch;
    expect(typeof fn).toBe("function");
    if (fn === undefined) {
      return;
    }

    const plan = okFleetPlan();
    const { calls, deps } = makeFakes();

    const report = await fn(plan, deps);
    expect(calls).toEqual([]);
    expect(report.dryRun).toBe(true);
    expect(report.outcome).toBe("dry-run");
    expect(report.ok).toBe(true);
    expect(report.ran).toEqual([]);
    expect(report.failedAt).toBeNull();
    expectDeferred(report, plan);
    expect(report.steps).toEqual([
      stopStep("v-a", "planned"),
      stopStep("v-b", "planned"),
      stopStep("v-c", "planned"),
      startStep("r-x", "planned"),
      startStep("r-y", "planned"),
    ]);

    const explicit = await fn(plan, deps, { dryRun: true });
    expect(explicit).toEqual(report);

    const proxied = await fn(
      plan,
      new Proxy(
        {},
        {
          get(): never {
            throw new Error("deps touched");
          },
        },
      ) as unknown as Deps,
    );
    expect(proxied).toEqual(report);
  });

  test("dryRun:false stops victims then starts replacements", async () => {
    const fn = (await transition()).executeProfileSwitch;
    expect(typeof fn).toBe("function");
    if (fn === undefined) {
      return;
    }

    const plan = okFleetPlan();
    const { calls, deps } = makeFakes();

    const report = await fn(plan, deps, { dryRun: false });
    expect(calls).toEqual(["stop:v-a", "stop:v-b", "stop:v-c", "start:r-x", "start:r-y"]);
    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    expect(report.failedAt).toBeNull();
    expect(report.steps).toEqual([
      stopStep("v-a", "ok"),
      stopStep("v-b", "ok"),
      stopStep("v-c", "ok"),
      startStep("r-x", "ok"),
      startStep("r-y", "ok"),
    ]);
    expect(report.ran).toEqual(report.steps);
    expectDeferred(report, plan);
    expect(calls.some((entry) => entry.includes("emb"))).toBe(false);
  });

  test("a failed stop halts the transition and marks remaining steps not-run", async () => {
    const fn = (await transition()).executeProfileSwitch;
    expect(typeof fn).toBe("function");
    if (fn === undefined) {
      return;
    }

    const plan = okFleetPlan();
    const { calls, deps } = makeFakes({ "v-b": "unverified" });

    const report = await fn(plan, deps, { dryRun: false });
    expect(calls).toEqual(["stop:v-a", "stop:v-b"]);
    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("failed");
    expect(report.ok).toBe(false);
    expect(report.failedAt).toEqual({
      action: "stop",
      workload: "v-b",
      detail: "unverified",
    });
    expect(report.steps).toEqual([
      stopStep("v-a", "ok"),
      stopStep("v-b", "failed", "unverified"),
      stopStep("v-c", "not-run"),
      startStep("r-x", "not-run"),
      startStep("r-y", "not-run"),
    ]);
    expect(report.ran).toEqual([stopStep("v-a", "ok"), stopStep("v-b", "failed", "unverified")]);
  });

  test("a rejected stop resolves as a failed report", async () => {
    const fn = (await transition()).executeProfileSwitch;
    expect(typeof fn).toBe("function");
    if (fn === undefined) {
      return;
    }

    const plan = okFleetPlan();
    const { calls, deps } = makeFakes({ "v-a": "throw" });

    const report = await fn(plan, deps, { dryRun: false });
    expect(calls).toEqual(["stop:v-a"]);
    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("failed");
    expect(report.ok).toBe(false);
    expect(report.failedAt).toEqual({ action: "stop", workload: "v-a", detail: "boom" });
  });

  test("a refused replacement start fails after every victim is stopped", async () => {
    const fn = (await transition()).executeProfileSwitch;
    expect(typeof fn).toBe("function");
    if (fn === undefined) {
      return;
    }

    const plan = okFleetPlan();
    const { calls, deps } = makeFakes({ "r-x": "admission refused" });

    const report = await fn(plan, deps, { dryRun: false });
    expect(calls).toEqual(["stop:v-a", "stop:v-b", "stop:v-c", "start:r-x"]);
    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("failed");
    expect(report.ok).toBe(false);
    expect(report.failedAt).toEqual({
      action: "start",
      workload: "r-x",
      detail: "admission refused",
    });
    expect(report.steps).toEqual([
      stopStep("v-a", "ok"),
      stopStep("v-b", "ok"),
      stopStep("v-c", "ok"),
      startStep("r-x", "failed", "admission refused"),
      startStep("r-y", "not-run"),
    ]);
    expect(report.ran).toEqual([
      stopStep("v-a", "ok"),
      stopStep("v-b", "ok"),
      stopStep("v-c", "ok"),
      startStep("r-x", "failed", "admission refused"),
    ]);
  });

  test("a refused plan reports refused without running steps", async () => {
    const fn = (await transition()).executeProfileSwitch;
    expect(typeof fn).toBe("function");
    if (fn === undefined) {
      return;
    }

    const plan = refusedFleetPlan();
    const { calls, deps } = makeFakes();

    const report = await fn(plan, deps, { dryRun: false });
    expect(calls).toEqual([]);
    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("refused");
    expect(report.ok).toBe(false);
    expect(report.refusal).toEqual({ reason: "OverBudget", detail: plan.detail });
    expect(report.steps).toEqual([]);
    expect(report.deferred).toEqual([]);
    expect(report.failedAt).toBeNull();
    expect(report.ran).toEqual([]);
  });

  test("a noop plan reports noop without running steps", async () => {
    const fn = (await transition()).executeProfileSwitch;
    expect(typeof fn).toBe("function");
    if (fn === undefined) {
      return;
    }

    const plan = noopFleetPlan();
    const { calls, deps } = makeFakes();

    const report = await fn(plan, deps, { dryRun: false });
    expect(calls).toEqual([]);
    expect(report.dryRun).toBe(false);
    expect(report.outcome).toBe("noop");
    expect(report.ok).toBe(true);
    expect(report.steps).toEqual([]);
    expect(report.deferred).toEqual([]);
    expect(report.failedAt).toBeNull();
    expect(report.ran).toEqual([]);
  });

  test("no package source imports the transition module", async () => {
    const fn = (await transition()).executeProfileSwitch;
    expect(typeof fn).toBe("function");
    if (fn === undefined) {
      return;
    }

    const repoRoot = join(import.meta.dir, "../../../..");
    const offenders: string[] = [];
    const glob = new Bun.Glob("packages/*/src/**/*.{ts,tsx}");
    for (const rel of glob.scanSync({ cwd: repoRoot, onlyFiles: true })) {
      if (rel === "packages/remote/src/residency/profile-transition.ts") {
        continue;
      }
      const source = await Bun.file(join(repoRoot, rel)).text();
      if (
        source.includes("residency/profile-transition") ||
        source.includes("./profile-transition")
      ) {
        offenders.push(rel);
      }
    }
    offenders.sort();
    expect(offenders).toEqual([]);
  });
});
