import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
/**
 * #517 — RED tests for the profile-switch executor's residency-lifecycle
 * wiring (`operation.lifecycle`): each stop walks its victim
 * ready -> draining -> unloading -> (dep) -> downloaded|failed and each
 * start reconciles the replacement's own stale row, walks
 * downloaded -> loading -> (dep) -> warming -> ready|failed, and refuses
 * before the dep runs when the fenced store reports a lifecycle refusal
 * (exclusive-group occupancy) or any other failed write (stale-fence).
 * Occupying peers inside the replacement's exclusive group that the plan
 * does not corroborate are reconciled down to downloaded first. At base
 * the executor ignores `operation.lifecycle` (an unknown extra property
 * on the operation opts), so every case fails BY ASSERTION on the
 * residency_states rows — never by import, type or exit code.
 */
import {
  findExclusiveGroupViolations,
  isOccupyingResidencyState,
  RESIDENCY_GROUPS,
  type ResidencyState,
} from "@llamactl/core/residency/lifecycle";
import {
  type OkPlan,
  type PlannerWorkload,
  planProfileSwitch,
} from "@llamactl/core/residency/planner";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeProfileSwitch,
  type ProfileSwitchExecutionReport,
  type ProfileSwitchExecutorDeps,
  type ProfileSwitchStepOutcome,
  type ProfileSwitchStepTimeouts,
  type ProfileSwitchStepTimer,
} from "../../src/residency/profile-transition.js";
import {
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
} from "../../src/residency/store.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";

const NOW = 1_000_000_000;
const NODE = "n1";
const GROUP = "z13-large-gpu";

type Store = ResidencyOperationStore & ResidencyLifecycleStore;

let dir = "";
let store: Store;
let fence = 0;

beforeEach(() => {
  setResidencyLeaseRegistry(null);
  dir = mkdtempSync(join(tmpdir(), "llamactl-profile-lifecycle-"));
  store = openResidencyOperationStore({ path: join(dir, "operations.sqlite") });
  fence = store.claimOwnership({ ownerId: "test", incarnation: "i1" }).fenceToken;
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  store.close();
  if (dir !== "") {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

const GROUP_OF: Record<string, string> = {
  "qwen-prod": GROUP,
  glm: GROUP,
};

const QWEN_PROD: PlannerWorkload = {
  id: "qwen-prod",
  profiles: ["qwen"],
  state: "ready",
  expectedMemoryGiB: 10,
  group: GROUP,
};

const GLM: PlannerWorkload = {
  id: "glm",
  profiles: ["glm"],
  state: "downloaded",
  expectedMemoryGiB: 10,
  group: GROUP,
};

// deepseek-x is seeded occupying z13-large-gpu in the store but carries no
// group on the planner workload, so the planner's exclusive-group check
// cannot see the conflict — the store row is what refuses or gets
// reconciled.
const DEEPSEEK_UNGROUPED: PlannerWorkload = {
  id: "deepseek-x",
  profiles: ["glm"],
  state: "ready",
  expectedMemoryGiB: 1,
};

function seedPathTo(target: ResidencyState): ResidencyState[] {
  switch (target) {
    case "downloaded":
      return ["downloaded"];
    case "loading":
      return ["downloaded", "loading"];
    case "ready":
      return ["downloaded", "loading", "warming", "ready"];
    case "unavailable":
    case "warming":
    case "draining":
    case "unloading":
    case "failed":
      throw new Error(`no seed path to residency state ${target}`);
  }
}

// Walks `model` from its current row to `target` through legal edges under
// the current fence. The first write from an absent row targets
// 'downloaded' at expectedVersion 0; 'unavailable' is never written.
function seed(model: string, target: ResidencyState, group?: string): void {
  for (const to of seedPathTo(target)) {
    const result = store.transitionResidencyState({
      fenceToken: fence,
      model,
      ...(group === undefined ? {} : { group }),
      to,
      expectedVersion: store.getResidencyState(model)?.version ?? 0,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
  }
}

function planFor(workloads: PlannerWorkload[]): OkPlan {
  const plan = planProfileSwitch({
    node: NODE,
    to: "glm",
    budgetGiB: 1000,
    groups: RESIDENCY_GROUPS,
    workloads,
    nowMs: NOW,
  });
  expect(plan.ok).toBe(true);
  if (!plan.ok) {
    throw new Error(`expected ok plan, got refusal ${plan.reason}: ${plan.detail}`);
  }
  return plan;
}

type Calls = [string, string, string | null][];

type DepHook = (workload: string) => ProfileSwitchStepOutcome | Promise<ProfileSwitchStepOutcome>;

// Records [action, workload, residency-state-at-dep-time] for every dep
// call so cases can pin both ordering and the lifecycle row the executor
// had reached when it invoked the dep.
function makeDeps(hooks: { stop?: DepHook; start?: DepHook } = {}): {
  calls: Calls;
  deps: ProfileSwitchExecutorDeps;
} {
  const calls: Calls = [];
  const invoke = (
    action: "stop" | "start",
    workload: string,
  ): Promise<ProfileSwitchStepOutcome> => {
    calls.push([action, workload, store.getResidencyState(workload)?.state ?? null]);
    const hook = action === "stop" ? hooks.stop : hooks.start;
    const outcome: ProfileSwitchStepOutcome | Promise<ProfileSwitchStepOutcome> =
      hook === undefined ? { ok: true } : hook(workload);
    return Promise.resolve(outcome);
  };
  return {
    calls,
    deps: {
      stop: (workload) => invoke("stop", workload),
      start: (workload) => invoke("start", workload),
    },
  };
}

// `lifecycle` is not on ProfileSwitchOperationOpts at the RED base: Bun
// ignores the extra property at runtime and the cases fail on the row
// assertions. The local type keeps the file compiling before and after
// GREEN.
type LifecycleOperationOpts = {
  store: Store;
  fenceToken: number;
  operationId: string;
  desiredRevision: number;
  nowMs: () => number;
  log: (line: string) => void;
  lifecycle: { store: Store; groupOf: (workload: string) => string | undefined };
};

type ExecuteExtra = {
  stepTimeouts?: ProfileSwitchStepTimeouts;
  stepTimer?: ProfileSwitchStepTimer;
};

async function execute(
  plan: OkPlan,
  deps: ProfileSwitchExecutorDeps,
  extra: ExecuteExtra = {},
): Promise<{ report: ProfileSwitchExecutionReport; logs: string[] }> {
  const logs: string[] = [];
  const operation: LifecycleOperationOpts = {
    store,
    fenceToken: fence,
    operationId: "op-1",
    desiredRevision: 0,
    nowMs: () => NOW,
    log: (line) => logs.push(line),
    lifecycle: { store, groupOf: (workload) => GROUP_OF[workload] },
  };
  const report = await executeProfileSwitch(plan, deps, {
    dryRun: false,
    registry: null,
    operation,
    ...(extra.stepTimeouts === undefined ? {} : { stepTimeouts: extra.stepTimeouts }),
    ...(extra.stepTimer === undefined ? {} : { stepTimer: extra.stepTimer }),
  });
  return { report, logs };
}

function exclusiveViolations(): ReturnType<typeof findExclusiveGroupViolations> {
  return findExclusiveGroupViolations(
    RESIDENCY_GROUPS,
    store.listResidencyStates().map((row) => ({
      id: row.model,
      state: row.state,
      ...(row.group ? { group: row.group } : {}),
    })),
  );
}

describe("executeProfileSwitch residency lifecycle", () => {
  test("LC1: a replacement start drives its row downloaded -> loading -> warming -> ready", async () => {
    // kills: the executor ignoring operation.lifecycle; omitting the
    // post-start loading -> warming -> ready walk.
    const plan = planFor([GLM]);
    const fx = makeDeps();

    const { report } = await execute(plan, fx.deps);

    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    const glm = store.getResidencyState("glm");
    expect(glm).not.toBeNull();
    expect(glm).toMatchObject({
      state: "ready",
      group: GROUP,
      version: 4,
    });
    expect(fx.calls).toContainEqual(["start", "glm", "loading"]);
  });

  test("LC2: a corroborated exclusive-group occupant refuses the start end to end", async () => {
    // kills: calling the inner start despite a refusal; omitting group on
    // the loading hop; reconciling a peer that the plan lists in retained.
    seed("deepseek-x", "ready", GROUP);
    const plan = planFor([GLM, DEEPSEEK_UNGROUPED]);
    expect(plan.retained).toContain("deepseek-x");
    const fx = makeDeps();

    const { report } = await execute(plan, fx.deps);

    expect(report.ok).toBe(false);
    expect(report.outcome).toBe("failed");
    expect(report.failedAt?.action).toBe("start");
    expect(report.failedAt?.workload).toBe("glm");
    expect(report.failedAt?.detail ?? "").toContain("ExclusiveGroupOccupied");
    expect(report.failedAt?.detail ?? "").toContain("deepseek-x");
    expect(fx.calls.filter((call) => call[0] === "start")).toEqual([]);
    const glmRow = store.getResidencyState("glm");
    expect(glmRow === null || !isOccupyingResidencyState(glmRow.state)).toBe(true);
    expect(store.getResidencyState("deepseek-x")).toMatchObject({
      state: "ready",
      version: 4,
    });
    const op = store.getOperation("op-1");
    expect(op?.phase).toBe("terminal");
    expect(op?.outcome).toBe("failed");
    expect(op?.detail ?? "").toContain("ExclusiveGroupOccupied");
  });

  test("LC3: the victim is released to downloaded before the replacement is admitted", async () => {
    // kills: the stop wrapper not releasing the victim; omitting the
    // post-stop unloading -> downloaded write; releasing after the dep
    // instead of before.
    seed("qwen-prod", "ready", GROUP);
    const plan = planFor([QWEN_PROD, GLM]);
    const fx = makeDeps();

    const { report } = await execute(plan, fx.deps);

    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    expect(fx.calls.map((call) => [call[0], call[1]])).toEqual([
      ["stop", "qwen-prod"],
      ["start", "glm"],
    ]);
    expect(fx.calls[0]).toEqual(["stop", "qwen-prod", "unloading"]);
    expect(fx.calls[1]).toEqual(["start", "glm", "loading"]);
    expect(store.getResidencyState("qwen-prod")).toMatchObject({
      state: "downloaded",
      version: 7,
    });
    const glm = store.getResidencyState("glm");
    expect(glm).not.toBeNull();
    expect(glm).toMatchObject({ state: "ready", version: 4 });
    expect(exclusiveViolations()).toEqual([]);
  });

  test("LC4: a failed start marks the row failed instead of leaving it occupying", async () => {
    // kills: leaving the row in occupying 'loading' after a failed start.
    const plan = planFor([GLM]);
    const fx = makeDeps({ start: () => ({ ok: false, detail: "boom" }) });

    const { report } = await execute(plan, fx.deps);

    const glm = store.getResidencyState("glm");
    expect(glm).not.toBeNull();
    expect(glm).toMatchObject({ state: "failed" });
    expect(report.failedAt?.detail ?? "").toContain("boom");
  });

  test("LC5: a failed stop marks the victim failed and starts nothing", async () => {
    // kills: swallowing a stop failure; leaving the row 'unloading'.
    seed("qwen-prod", "ready", GROUP);
    const plan = planFor([QWEN_PROD, GLM]);
    const fx = makeDeps({ stop: () => ({ ok: false, detail: "stuck" }) });

    const { report } = await execute(plan, fx.deps);

    expect(report.outcome).toBe("failed");
    expect(store.getResidencyState("qwen-prod")).toMatchObject({ state: "failed" });
    expect(fx.calls.filter((call) => call[0] === "start")).toEqual([]);
  });

  test("LC6: the replacement's own stale occupying row is reconciled before the start", async () => {
    // kills: not reconciling the replacement's own stale row
    // (IllegalTransition ready -> loading would refuse the start).
    const SEED_VERSION = 4;
    seed("glm", "ready", GROUP);
    const plan = planFor([GLM]);
    const fx = makeDeps();

    const { report } = await execute(plan, fx.deps);

    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    expect(fx.calls.filter((call) => call[0] === "start")).toHaveLength(1);
    // 6 hops from the seeded ready row: draining, unloading, downloaded,
    // loading, warming, ready.
    const glm = store.getResidencyState("glm");
    expect(glm).not.toBeNull();
    expect(glm).toMatchObject({
      state: "ready",
      version: SEED_VERSION + 6,
    });
  });

  test("LC7: a stale-fence store write fails the switch closed before the start dep", async () => {
    // kills: treating only lifecycle-refused as a refusal and starting
    // after a stale-fence write.
    const plan = planFor([QWEN_PROD, GLM]);
    const fx = makeDeps({
      stop: () => {
        store.claimOwnership({ ownerId: "intruder", incarnation: "z" });
        return { ok: true };
      },
    });

    const { report } = await execute(plan, fx.deps);

    expect(fx.calls.filter((call) => call[0] === "start")).toEqual([]);
    expect(report.failedAt?.action).toBe("start");
    expect(report.failedAt?.workload).toBe("glm");
    expect(report.failedAt?.detail ?? "").toContain("stale-fence");
  });

  test("LC8: a stale uncorroborated ready peer in the group is reconciled to downloaded", async () => {
    // kills: refusing on an uncorroborated stale row (the wedge); a
    // reconcile path that skips draining (ready -> unloading is illegal,
    // so it would still refuse).
    seed("deepseek-x", "ready", GROUP);
    const plan = planFor([GLM]);
    const fx = makeDeps();

    const { report, logs } = await execute(plan, fx.deps);

    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    expect(fx.calls.filter((call) => call[0] === "start" && call[1] === "glm")).toHaveLength(1);
    expect(store.getResidencyState("deepseek-x")).toMatchObject({
      state: "downloaded",
      version: 7,
    });
    const glm = store.getResidencyState("glm");
    expect(glm).not.toBeNull();
    expect(glm).toMatchObject({ state: "ready", version: 4 });
    expect(exclusiveViolations()).toEqual([]);
    expect(logs.some((line) => line.includes("deepseek-x") && line.includes("reconciled"))).toBe(
      true,
    );
  });

  test("LC9: a stale loading peer left by a crash mid-load is reconciled to downloaded", async () => {
    // kills: a reconcile table missing the loading/warming row.
    seed("deepseek-x", "loading", GROUP);
    const plan = planFor([GLM]);
    const fx = makeDeps();

    const { report } = await execute(plan, fx.deps);

    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    expect(store.getResidencyState("deepseek-x")).toMatchObject({
      state: "downloaded",
      version: 4,
    });
    const glm = store.getResidencyState("glm");
    expect(glm).not.toBeNull();
    expect(glm).toMatchObject({ state: "ready" });
  });

  test("LC10: reconciliation stays inside the replacement's exclusive group", async () => {
    // kills: reconciling occupying rows outside the replacement's group.
    seed("other-y", "ready");
    const plan = planFor([GLM]);
    const fx = makeDeps();

    const { report } = await execute(plan, fx.deps);

    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(report.ok).toBe(true);
    expect(store.getResidencyState("other-y")).toMatchObject({ state: "ready", version: 4 });
    const glm = store.getResidencyState("glm");
    expect(glm).not.toBeNull();
    expect(glm).toMatchObject({ state: "ready" });
  });

  test("LC11: a start that resolves after StepTimedOut never walks the row to ready", async () => {
    // kills: the post-start write ignoring ctx.signal.aborted.
    const plan = planFor([GLM]);
    let fire: () => void = () => undefined;
    let resolveStart: (outcome: ProfileSwitchStepOutcome) => void = () => undefined;
    const startGate = new Promise<ProfileSwitchStepOutcome>((resolve) => {
      resolveStart = resolve;
    });
    const fx = makeDeps({
      start: () => {
        fire();
        return startGate;
      },
    });

    const { report } = await execute(plan, fx.deps, {
      stepTimeouts: { loadMs: 1000 },
      stepTimer: (_ms, onTimeout) => {
        fire = onTimeout;
        return (): void => undefined;
      },
    });

    expect(report.failedAt?.reason).toBe("StepTimedOut");
    const op = store.getOperation("op-1");
    expect(op?.phase).toBe("terminal");
    expect(op?.outcome).toBe("failed");

    resolveStart({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getResidencyState("glm")?.state).toBe("failed");
  });
});
