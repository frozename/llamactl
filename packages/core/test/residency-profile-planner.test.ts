import { expect, test } from "bun:test";

import type { ResidencyGroupDeclaration } from "../src/residency/lifecycle.js";
import type {
  OkPlan,
  PlannerWorkload,
  ProfileSwitchPlan,
  ProfileSwitchPolicy,
  ProfileSwitchRequest,
  ProfileSwitchStep,
  ProfileSwitchTimeoutOverrides,
  RefusalPlan,
  StepKind,
} from "../src/residency/planner.js";

import { DEFAULT_PROFILE_SWITCH_TIMEOUTS, planProfileSwitch } from "../src/residency/planner.js";

const NOW_MS = 1_000_000_000;

const GROUPS: ResidencyGroupDeclaration[] = [
  { name: "z13-large-gpu", exclusive: true },
  { name: "g", exclusive: true },
];

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

function p2Workloads(): PlannerWorkload[] {
  return [
    workload("chat", { profiles: ["interactive"], state: "ready", expectedMemoryGiB: 20 }),
    workload("coder", { profiles: ["interactive"], state: "ready", expectedMemoryGiB: 8 }),
    workload("embed", { profiles: [], state: "ready", expectedMemoryGiB: 2, protected: true }),
    workload("dream", {
      profiles: ["maintenance"],
      state: "downloaded",
      expectedMemoryGiB: 24,
    }),
  ];
}

function mapWorkload(
  workloads: PlannerWorkload[],
  id: string,
  update: (wl: PlannerWorkload) => PlannerWorkload,
): PlannerWorkload[] {
  return workloads.map((wl) => (wl.id === id ? update(wl) : wl));
}

type RequestSpec = {
  node?: string;
  to?: string;
  from?: string | null;
  budgetGiB?: number | null;
  groups?: ResidencyGroupDeclaration[];
  workloads?: PlannerWorkload[];
  requiredServices?: string[];
  policy?: ProfileSwitchPolicy;
  lastSwitchAtMs?: number | null;
  inFlightOperationId?: string | null;
  nowMs?: number;
  timeouts?: ProfileSwitchTimeoutOverrides | null;
};

function req(over: RequestSpec = {}): ProfileSwitchRequest {
  return {
    node: over.node ?? "node-a",
    to: over.to ?? "maintenance",
    ...(over.from === undefined ? {} : { from: over.from }),
    budgetGiB: over.budgetGiB === undefined ? 48 : over.budgetGiB,
    groups: over.groups ?? GROUPS,
    workloads: over.workloads ?? p2Workloads(),
    ...(over.requiredServices === undefined ? {} : { requiredServices: over.requiredServices }),
    ...(over.policy === undefined ? {} : { policy: over.policy }),
    ...(over.lastSwitchAtMs === undefined ? {} : { lastSwitchAtMs: over.lastSwitchAtMs }),
    ...(over.inFlightOperationId === undefined
      ? {}
      : { inFlightOperationId: over.inFlightOperationId }),
    nowMs: over.nowMs ?? NOW_MS,
    ...(over.timeouts === undefined ? {} : { timeouts: over.timeouts }),
  };
}

function expectOk(plan: ProfileSwitchPlan): asserts plan is OkPlan {
  expect(plan.ok).toBe(true);
}

function expectRefused(plan: ProfileSwitchPlan): asserts plan is RefusalPlan {
  expect(plan.ok).toBe(false);
}

function stepByKind(plan: OkPlan, kind: StepKind): ProfileSwitchStep {
  const step = plan.steps.find((s) => s.kind === kind);
  expect(step).toBeDefined();
  if (step === undefined) {
    throw new Error(`missing step ${kind}`);
  }
  return step;
}

test("#279 P1: planner exports planProfileSwitch and frozen DEFAULT_PROFILE_SWITCH_TIMEOUTS", () => {
  expect(typeof planProfileSwitch).toBe("function");
  expect(DEFAULT_PROFILE_SWITCH_TIMEOUTS).toEqual({
    drainMs: 30_000,
    unloadMs: 60_000,
    loadMs: 600_000,
    readyMs: 120_000,
  });
  expect(Object.isFrozen(DEFAULT_PROFILE_SWITCH_TIMEOUTS)).toBe(true);
});

test("#279 P2: interactive to maintenance drains victims then reserves, starts and publishes", () => {
  const plan = planProfileSwitch(req({ from: "interactive" }));
  expectOk(plan);
  expect(plan).toMatchObject({
    noop: false,
    node: "node-a",
    from: "interactive",
    to: "maintenance",
    victims: ["chat", "coder"],
    replacements: ["dream"],
    retained: ["embed"],
    protected: ["embed"],
    skipped: [],
    beforeGiB: 30,
    afterGiB: 26,
    peakGiB: 30,
    budgetGiB: 48,
    deadlineMs: NOW_MS + 810_000,
  });
  expect(plan.steps.map((s) => s.kind)).toEqual([
    "fence-admission",
    "drain",
    "persist-suppression",
    "unload",
    "verify-release",
    "reserve",
    "start",
    "verify-ready",
    "publish",
    "complete",
  ]);
  for (const kind of ["drain", "persist-suppression", "unload", "verify-release"] as const) {
    expect(stepByKind(plan, kind).workloads).toEqual(["chat", "coder"]);
  }
  expect(stepByKind(plan, "verify-release").freedGiB).toBe(28);
  for (const kind of ["reserve", "start", "verify-ready"] as const) {
    expect(stepByKind(plan, kind).workloads).toEqual(["dream"]);
  }
  expect(stepByKind(plan, "reserve").reservationGiB).toBe(24);
  expect(stepByKind(plan, "publish").profile).toBe("maintenance");
  for (const kind of ["fence-admission", "publish", "complete"] as const) {
    expect("workloads" in stepByKind(plan, kind)).toBe(false);
  }
});

test("#279 P3: exclusive-group swap orders unload before start and never mixes victim and replacement ids", () => {
  const plan = planProfileSwitch(
    req({
      budgetGiB: 128,
      workloads: [
        workload("glm", {
          profiles: ["interactive"],
          state: "ready",
          expectedMemoryGiB: 80,
          group: "z13-large-gpu",
        }),
        workload("ds", {
          profiles: ["maintenance"],
          state: "downloaded",
          expectedMemoryGiB: 90,
          group: "z13-large-gpu",
        }),
      ],
    }),
  );
  expectOk(plan);
  expect(plan.victims).toEqual(["glm"]);
  expect(plan.replacements).toEqual(["ds"]);
  expect(plan.peakGiB).toBe(90);
  const unloadIndex = plan.steps.findIndex((s) => s.kind === "unload");
  const startIndex = plan.steps.findIndex((s) => s.kind === "start");
  expect(unloadIndex).toBeGreaterThanOrEqual(0);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(unloadIndex).toBeLessThan(startIndex);
  for (const step of plan.steps) {
    const ids = step.workloads ?? [];
    expect(ids.includes("glm") && ids.includes("ds")).toBe(false);
  }
});

test("#279 P4: protected exclusive-group occupant refuses the switch as ProtectedEviction", () => {
  const plan = planProfileSwitch(
    req({
      budgetGiB: 128,
      workloads: [
        workload("executor", {
          profiles: [],
          state: "ready",
          expectedMemoryGiB: 10,
          group: "g",
          protected: true,
        }),
        workload("x", {
          profiles: ["maintenance"],
          state: "downloaded",
          expectedMemoryGiB: 10,
          group: "g",
        }),
      ],
    }),
  );
  expectRefused(plan);
  expect(plan.reason).toBe("ProtectedEviction");
  expect(plan.workloads).toContain("executor");
  expect(plan.steps).toEqual([]);
});

test("#279 P5: replacements exceeding budgetGiB refuse as OverBudget", () => {
  const plan = planProfileSwitch(
    req({
      budgetGiB: 16,
      workloads: [
        workload("small", {
          profiles: ["interactive"],
          state: "ready",
          expectedMemoryGiB: 4,
        }),
        workload("big", {
          profiles: ["maintenance"],
          state: "downloaded",
          expectedMemoryGiB: 20,
        }),
      ],
    }),
  );
  expectRefused(plan);
  expect(plan.reason).toBe("OverBudget");
  expect(plan.steps).toEqual([]);
});

test("#279 P6: replacement-only switch emits no victim steps", () => {
  const plan = planProfileSwitch(
    req({
      budgetGiB: 128,
      workloads: [
        workload("m-vllm", {
          profiles: ["maintenance"],
          state: "downloaded",
          expectedMemoryGiB: 40,
        }),
        workload("m-llamacpp", {
          profiles: ["maintenance"],
          state: "downloaded",
          expectedMemoryGiB: 30,
        }),
        workload("m-mlx", {
          profiles: ["maintenance"],
          state: "downloaded",
          expectedMemoryGiB: 20,
        }),
        workload("embed", {
          profiles: [],
          state: "ready",
          expectedMemoryGiB: 4,
          protected: true,
        }),
      ],
    }),
  );
  expectOk(plan);
  expect(plan.victims).toEqual([]);
  expect(plan.replacements).toEqual(["m-llamacpp", "m-mlx", "m-vllm"]);
  expect(plan.retained).toEqual(["embed"]);
  expect(plan.protected).toEqual(["embed"]);
  expect(plan.skipped).toEqual([]);
  expect(plan.beforeGiB).toBe(4);
  expect(plan.afterGiB).toBe(94);
  expect(plan.peakGiB).toBe(94);
  expect(plan.steps.map((s) => s.kind)).toEqual([
    "fence-admission",
    "reserve",
    "start",
    "verify-ready",
    "publish",
    "complete",
  ]);
  for (const kind of ["reserve", "start", "verify-ready"] as const) {
    expect(stepByKind(plan, kind).workloads).toEqual(["m-llamacpp", "m-mlx", "m-vllm"]);
  }
  expect(stepByKind(plan, "reserve").reservationGiB).toBe(90);
  expect(stepByKind(plan, "publish").profile).toBe("maintenance");
});

test("#279 P7: null budgetGiB refuses as UnknownBudget", () => {
  const plan = planProfileSwitch(req({ from: "interactive", budgetGiB: null }));
  expectRefused(plan);
  expect(plan.reason).toBe("UnknownBudget");
  expect(plan.steps).toEqual([]);
});

test("#279 P8a: disabled downloaded target is skipped rather than replaced", () => {
  const plan = planProfileSwitch(
    req({
      from: "interactive",
      workloads: [
        ...p2Workloads(),
        workload("batch", {
          profiles: ["maintenance"],
          state: "downloaded",
          expectedMemoryGiB: 4,
          disabled: true,
        }),
      ],
    }),
  );
  expectOk(plan);
  expect(plan.victims).toEqual(["chat", "coder"]);
  expect(plan.replacements).toEqual(["dream"]);
  expect(plan.skipped).toEqual(["batch"]);
  for (const step of plan.steps) {
    expect((step.workloads ?? []).includes("batch")).toBe(false);
  }
});

test("#279 P8b: required disabled service refuses as RequiredServiceUnavailable", () => {
  const plan = planProfileSwitch(
    req({
      from: "interactive",
      requiredServices: ["batch"],
      workloads: [
        ...p2Workloads(),
        workload("batch", {
          profiles: ["maintenance"],
          state: "downloaded",
          expectedMemoryGiB: 4,
          disabled: true,
        }),
      ],
    }),
  );
  expectRefused(plan);
  expect(plan.reason).toBe("RequiredServiceUnavailable");
  expect(plan.workloads).toEqual(["batch"]);
  expect(plan.steps).toEqual([]);
});

test("#279 P9a: unknown required service refuses as RequiredServiceUnavailable", () => {
  const plan = planProfileSwitch(req({ from: "interactive", requiredServices: ["ghost"] }));
  expectRefused(plan);
  expect(plan.reason).toBe("RequiredServiceUnavailable");
  expect(plan.workloads).toEqual(["ghost"]);
  expect(plan.steps).toEqual([]);
});

test("#279 P9b: required service that is a victim refuses as RequiredServiceUnavailable", () => {
  const plan = planProfileSwitch(req({ from: "interactive", requiredServices: ["chat"] }));
  expectRefused(plan);
  expect(plan.reason).toBe("RequiredServiceUnavailable");
  expect(plan.workloads).toEqual(["chat"]);
  expect(plan.steps).toEqual([]);
});

test("#279 P10a: in-flight operation refuses as NodeBusy", () => {
  const plan = planProfileSwitch(req({ from: "interactive", inFlightOperationId: "op-1" }));
  expectRefused(plan);
  expect(plan.reason).toBe("NodeBusy");
  expect(plan.steps).toEqual([]);
});

test("#279 P10b: draining workload refuses as NodeBusy", () => {
  const plan = planProfileSwitch(
    req({
      from: "interactive",
      workloads: mapWorkload(p2Workloads(), "coder", (wl) => ({ ...wl, state: "draining" })),
    }),
  );
  expectRefused(plan);
  expect(plan.reason).toBe("NodeBusy");
  expect(plan.workloads).toEqual(["coder"]);
  expect(plan.steps).toEqual([]);
});

test("#279 P10c: unloading workload refuses as NodeBusy", () => {
  const plan = planProfileSwitch(
    req({
      from: "interactive",
      workloads: mapWorkload(p2Workloads(), "coder", (wl) => ({ ...wl, state: "unloading" })),
    }),
  );
  expectRefused(plan);
  expect(plan.reason).toBe("NodeBusy");
  expect(plan.workloads).toEqual(["coder"]);
  expect(plan.steps).toEqual([]);
});

test("#279 P11: switch inside the cooldown window refuses with the remaining retryAfterMs", () => {
  const plan = planProfileSwitch(
    req({
      from: "interactive",
      policy: { switchCooldownSeconds: 300 },
      lastSwitchAtMs: NOW_MS - 100_000,
    }),
  );
  expectRefused(plan);
  expect(plan.reason).toBe("Cooldown");
  expect(plan.retryAfterMs).toBe(200_000);
  expect(plan.steps).toEqual([]);
});

test("#279 P12: victim inside minResidency refuses with the remaining retryAfterMs", () => {
  const plan = planProfileSwitch(
    req({
      from: "interactive",
      policy: { minResidencySeconds: 600 },
      workloads: mapWorkload(p2Workloads(), "chat", (wl) => ({
        ...wl,
        loadedAtMs: NOW_MS - 60_000,
      })),
    }),
  );
  expectRefused(plan);
  expect(plan.reason).toBe("MinResidency");
  expect(plan.workloads).toEqual(["chat"]);
  expect(plan.retryAfterMs).toBe(540_000);
  expect(plan.steps).toEqual([]);
});

test("#279 P13: nothing to switch is a noop that skips hysteresis but still honours required services", () => {
  const plan = planProfileSwitch(
    req({
      workloads: [
        workload("embed", {
          profiles: [],
          state: "ready",
          expectedMemoryGiB: 2,
          protected: true,
        }),
        workload("dream", {
          profiles: ["maintenance"],
          state: "ready",
          expectedMemoryGiB: 24,
        }),
      ],
      requiredServices: ["embed"],
      policy: { switchCooldownSeconds: 300 },
      lastSwitchAtMs: NOW_MS - 100_000,
    }),
  );
  expectOk(plan);
  expect(plan.noop).toBe(true);
  expect(plan.steps).toEqual([]);
  expect(plan.deadlineMs).toBe(NOW_MS);
  expect(plan.victims).toEqual([]);
  expect(plan.replacements).toEqual([]);
  expect(plan.retained).toEqual(["dream", "embed"]);
  expect(plan.protected).toEqual(["embed"]);
  expect(plan.skipped).toEqual([]);
  expect(plan.beforeGiB).toBe(26);
  expect(plan.afterGiB).toBe(26);
  expect(plan.peakGiB).toBe(26);
});

test("#279 P14: failed or unavailable target refuses as TargetUnavailable", () => {
  for (const state of ["failed", "unavailable"] as const) {
    const plan = planProfileSwitch(
      req({
        workloads: [workload("x", { profiles: ["maintenance"], state, expectedMemoryGiB: 4 })],
      }),
    );
    expectRefused(plan);
    expect(plan.reason).toBe("TargetUnavailable");
    expect(plan.workloads).toEqual(["x"]);
    expect(plan.steps).toEqual([]);
  }
});

test("#279 P15a: deadlineMs is nowMs plus the summed phase timeouts", () => {
  const plan = planProfileSwitch(
    req({
      from: "interactive",
      timeouts: { drainMs: 1, unloadMs: 2, loadMs: 4, readyMs: 8 },
    }),
  );
  expectOk(plan);
  expect(plan.deadlineMs).toBe(NOW_MS + 15);
});

test("#279 P15b: reversing the workloads array yields an identical plan", () => {
  const forward = planProfileSwitch(req({ from: "interactive" }));
  const reversed = planProfileSwitch(
    req({ from: "interactive", workloads: p2Workloads().reverse() }),
  );
  expectOk(forward);
  expectOk(reversed);
  expect(reversed).toEqual(forward);
});

test("#279 P15c: planProfileSwitch does not mutate the request", () => {
  const input = req({ from: "interactive" });
  const snapshot = structuredClone(input);
  expect(planProfileSwitch(input)).toBeDefined();
  expect(input).toEqual(snapshot);
});

test("#279 P15d: invalid requests refuse as InvalidRequest", () => {
  const invalid: ProfileSwitchRequest[] = [
    req({
      from: "interactive",
      workloads: [
        ...p2Workloads(),
        workload("chat", {
          profiles: ["interactive"],
          state: "ready",
          expectedMemoryGiB: 1,
        }),
      ],
    }),
    req({
      from: "interactive",
      workloads: mapWorkload(p2Workloads(), "coder", (wl) => ({
        ...wl,
        expectedMemoryGiB: -1,
      })),
    }),
    req({
      from: "interactive",
      workloads: mapWorkload(p2Workloads(), "coder", (wl) => ({
        ...wl,
        expectedMemoryGiB: Number.NaN,
      })),
    }),
    req({ from: "interactive", to: "" }),
    req({
      from: "interactive",
      workloads: mapWorkload(p2Workloads(), "chat", (wl) => ({ ...wl, group: "nope" })),
    }),
    req({ from: "interactive", requiredServices: [""] }),
  ];
  for (const bad of invalid) {
    const plan = planProfileSwitch(bad);
    expectRefused(plan);
    expect(plan.reason).toBe("InvalidRequest");
    expect(plan.steps).toEqual([]);
  }
});

test("#279 P16: required check runs before noop so a disabled-only target still refuses", () => {
  const plan = planProfileSwitch(
    req({
      workloads: [
        workload("batch", {
          profiles: ["maintenance"],
          state: "downloaded",
          expectedMemoryGiB: 4,
          disabled: true,
        }),
      ],
      requiredServices: ["batch"],
    }),
  );
  expectRefused(plan);
  expect(plan.reason).toBe("RequiredServiceUnavailable");
  expect(plan.workloads).toEqual(["batch"]);
  expect(plan.steps).toEqual([]);
});

test("#279 P17a: two downloaded replacements in one exclusive group refuse as ExclusiveGroupConflict", () => {
  const plan = planProfileSwitch(
    req({
      budgetGiB: 128,
      workloads: [
        workload("ds-a", {
          profiles: ["maintenance"],
          state: "downloaded",
          expectedMemoryGiB: 40,
          group: "g",
        }),
        workload("ds-b", {
          profiles: ["maintenance"],
          state: "downloaded",
          expectedMemoryGiB: 50,
          group: "g",
        }),
      ],
    }),
  );
  expectRefused(plan);
  expect(plan.reason).toBe("ExclusiveGroupConflict");
  expect(plan.workloads).toEqual(["ds-a", "ds-b"]);
  expect(plan.steps).toEqual([]);
});

test("#279 P17b: retained ready occupant plus downloaded replacement in one exclusive group refuse as ExclusiveGroupConflict", () => {
  const plan = planProfileSwitch(
    req({
      budgetGiB: 256,
      workloads: [
        workload("glm", {
          profiles: ["maintenance"],
          state: "ready",
          expectedMemoryGiB: 80,
          group: "g",
        }),
        workload("ds", {
          profiles: ["maintenance"],
          state: "downloaded",
          expectedMemoryGiB: 90,
          group: "g",
        }),
      ],
    }),
  );
  expectRefused(plan);
  expect(plan.reason).toBe("ExclusiveGroupConflict");
  expect(plan.workloads).toEqual(["ds", "glm"]);
  expect(plan.steps).toEqual([]);
});

test("#279 P18: victims-only switch with null budgetGiB plans ok because afterGiB is zero", () => {
  const plan = planProfileSwitch(
    req({
      budgetGiB: null,
      workloads: [
        workload("chat", { profiles: ["interactive"], state: "ready", expectedMemoryGiB: 20 }),
        workload("coder", { profiles: ["interactive"], state: "ready", expectedMemoryGiB: 8 }),
      ],
    }),
  );
  expectOk(plan);
  expect(plan.noop).toBe(false);
  expect(plan.victims).toEqual(["chat", "coder"]);
  expect(plan.retained).toEqual([]);
  expect(plan.replacements).toEqual([]);
  expect(plan.beforeGiB).toBe(28);
  expect(plan.afterGiB).toBe(0);
  expect(plan.budgetGiB).toBeNull();
  expect(plan.steps.map((s) => s.kind)).toEqual([
    "fence-admission",
    "drain",
    "persist-suppression",
    "unload",
    "verify-release",
    "publish",
    "complete",
  ]);
  expect(plan.deadlineMs).toBe(NOW_MS + 90_000);
});

test("#279 P19: non-finite, negative, null or undefined timeout overrides refuse as InvalidRequest", () => {
  const badValues = [
    Number.NaN,
    -1,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    null,
    undefined,
  ];
  for (const key of ["drainMs", "unloadMs", "loadMs", "readyMs"] as const) {
    for (const value of badValues) {
      const timeouts: ProfileSwitchTimeoutOverrides = {};
      timeouts[key] = value;
      const plan = planProfileSwitch(req({ from: "interactive", timeouts }));
      expectRefused(plan);
      expect(plan.reason).toBe("InvalidRequest");
      expect(plan.steps).toEqual([]);
    }
  }
});

test("#279 P20: absent timeout keys keep defaults while present keys override", () => {
  const plan = planProfileSwitch(
    req({ from: "interactive", timeouts: { drainMs: 5, readyMs: 7 } }),
  );
  expectOk(plan);
  expect(plan.deadlineMs).toBe(NOW_MS + 5 + 60_000 + 600_000 + 7);
});
