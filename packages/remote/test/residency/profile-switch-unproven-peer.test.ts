import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
/**
 * #517 — RED tests for proven-down gating of uncorroborated exclusive-group
 * peers in the profile-switch executor. Once `operation.lifecycle` carries
 * `isProvenDown`, a ready peer is reconciled only when that predicate proves
 * it down; a false or throwing probe keeps the row and the replacement start
 * fails closed through ExclusiveGroupOccupied. Loading and warming peers are
 * never probed: they may belong to an in-flight direct start that has written
 * no pid yet, so they fail closed too. At base the executor ignores the extra
 * `isProvenDown` property, reconciles every uncorroborated occupant and never
 * calls the predicate, so each RED case fails BY ASSERTION — never by import,
 * type or exit code.
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
  dir = mkdtempSync(join(tmpdir(), "llamactl-profile-unproven-peer-"));
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
  glm: GROUP,
};

const GLM: PlannerWorkload = {
  id: "glm",
  profiles: ["glm"],
  state: "downloaded",
  expectedMemoryGiB: 10,
  group: GROUP,
};

function seedPathTo(target: ResidencyState): ResidencyState[] {
  switch (target) {
    case "downloaded":
      return ["downloaded"];
    case "loading":
      return ["downloaded", "loading"];
    case "warming":
      return ["downloaded", "loading", "warming"];
    case "ready":
      return ["downloaded", "loading", "warming", "ready"];
    case "unavailable":
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

// `isProvenDown` is not on ProfileSwitchLifecycleOpts at the RED base: Bun
// ignores the extra property at runtime and the cases fail on the report,
// row and predicate-call assertions. The local type keeps this file
// compiling before and after GREEN.
type LifecycleOperationOpts = {
  store: Store;
  fenceToken: number;
  operationId: string;
  desiredRevision: number;
  nowMs: () => number;
  log: (line: string) => void;
  lifecycle: {
    store: LifecycleStore;
    groupOf: (workload: string) => string | undefined;
    isProvenDown?: (model: string) => boolean;
  };
};

type LifecycleStore = Pick<
  ResidencyLifecycleStore,
  "getResidencyState" | "listResidencyStates" | "transitionResidencyState"
>;

type ExecuteExtra = {
  lifecycleStore?: LifecycleStore;
  isProvenDown?: (model: string) => boolean;
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
    lifecycle: {
      store: extra.lifecycleStore ?? store,
      groupOf: (workload) => GROUP_OF[workload],
      ...(extra.isProvenDown === undefined ? {} : { isProvenDown: extra.isProvenDown }),
    },
  };
  const report = await executeProfileSwitch(plan, deps, {
    dryRun: false,
    registry: null,
    operation,
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

function expectGlmStartRefused(
  report: ProfileSwitchExecutionReport,
  calls: Calls,
  occupant: string,
): void {
  expect(report.ok).toBe(false);
  expect(report.failedAt?.workload).toBe("glm");
  expect(report.failedAt?.detail ?? "").toContain("ExclusiveGroupOccupied");
  expect(report.failedAt?.detail ?? "").toContain(occupant);
  expect(calls.filter((call) => call[0] === "start" && call[1] === "glm")).toEqual([]);
  const glmRow = store.getResidencyState("glm");
  expect(glmRow === null || !isOccupyingResidencyState(glmRow.state)).toBe(true);
}

describe("executeProfileSwitch unproven exclusive-group peers", () => {
  test("UP1: an unproven ready peer is kept and refuses the replacement start", async () => {
    // kills: reconciling a ready uncorroborated peer without asking
    // isProvenDown; probing more than once; swallowing the probe's false.
    seed("deepseek-x", "ready", GROUP);
    const plan = planFor([GLM]);
    const fx = makeDeps();
    const calls: string[] = [];

    const { report, logs } = await execute(plan, fx.deps, {
      isProvenDown: (model) => {
        calls.push(model);
        return false;
      },
    });

    expectGlmStartRefused(report, fx.calls, "deepseek-x");
    expect(store.getResidencyState("deepseek-x")).toMatchObject({
      state: "ready",
      version: 4,
    });
    expect(exclusiveViolations()).toEqual([]);
    expect(calls).toEqual(["deepseek-x"]);
    expect(logs.some((line) => line.includes("reconciled stale"))).toBe(false);
    expect(logs).toContain(
      "[residency] lifecycle kept deepseek-x ready in group z13-large-gpu: not proven down\n",
    );
  });

  test("UP2: an unproven loading peer is never probed and refuses the start", async () => {
    // kills: treating a loading row as crash-left without live corroboration.
    seed("deepseek-x", "loading", GROUP);
    const plan = planFor([GLM]);
    const fx = makeDeps();
    const calls: string[] = [];

    const { report, logs } = await execute(plan, fx.deps, {
      isProvenDown: (model) => {
        calls.push(model);
        return false;
      },
    });

    expectGlmStartRefused(report, fx.calls, "deepseek-x");
    expect(store.getResidencyState("deepseek-x")).toMatchObject({
      state: "loading",
      version: 2,
    });
    expect(calls).toEqual([]);
    expect(logs).toContain(
      "[residency] lifecycle kept deepseek-x loading in group z13-large-gpu: not proven down\n",
    );
  });

  test("UP2b: even a true probe is not consulted for a loading peer", async () => {
    // kills: probing loading rows, which would race a direct start whose
    // process exists but whose pid file is not written yet.
    seed("deepseek-x", "loading", GROUP);
    const plan = planFor([GLM]);
    const fx = makeDeps();
    const calls: string[] = [];

    const { report } = await execute(plan, fx.deps, {
      isProvenDown: (model) => {
        calls.push(model);
        return true;
      },
    });

    expectGlmStartRefused(report, fx.calls, "deepseek-x");
    expect(store.getResidencyState("deepseek-x")).toMatchObject({
      state: "loading",
      version: 2,
    });
    expect(calls).toEqual([]);
    expect(exclusiveViolations()).toEqual([]);
  });

  test("UP2c: a warming peer is never probed and stays unchanged", async () => {
    // kills: the same in-flight direct-start race one hop later, in warming.
    seed("deepseek-x", "warming", GROUP);
    const before = store.getResidencyState("deepseek-x");
    expect(before).not.toBeNull();
    if (before === null) {
      throw new Error("seeded deepseek-x row missing");
    }
    const plan = planFor([GLM]);
    const fx = makeDeps();
    const calls: string[] = [];

    const { report } = await execute(plan, fx.deps, {
      isProvenDown: (model) => {
        calls.push(model);
        return true;
      },
    });

    expectGlmStartRefused(report, fx.calls, "deepseek-x");
    expect(store.getResidencyState("deepseek-x")).toEqual(before);
    expect(calls).toEqual([]);
    expect(exclusiveViolations()).toEqual([]);
  });

  test("UP3: a throwing proven-down probe fails closed", async () => {
    // kills: treating probe uncertainty as proof down.
    seed("deepseek-x", "ready", GROUP);
    const plan = planFor([GLM]);
    const fx = makeDeps();

    const { report } = await execute(plan, fx.deps, {
      isProvenDown: () => {
        throw new Error("probe exploded");
      },
    });

    expectGlmStartRefused(report, fx.calls, "deepseek-x");
    expect(store.getResidencyState("deepseek-x")).toMatchObject({
      state: "ready",
      version: 4,
    });
  });

  test("UP4: a ready peer proven down is reconciled before glm starts", async () => {
    // kills: probing but ignoring a true result. At base every assertion
    // before `calls` already passes because the uncorroborated row is
    // reconciled unconditionally; the predicate-call assertion is the RED.
    seed("deepseek-x", "ready", GROUP);
    const plan = planFor([GLM]);
    const fx = makeDeps();
    const calls: string[] = [];

    const { report, logs } = await execute(plan, fx.deps, {
      isProvenDown: (model) => {
        calls.push(model);
        return true;
      },
    });

    expect(report.ok).toBe(true);
    expect(report.outcome).toBe("stops-and-starts-ran");
    expect(store.getResidencyState("deepseek-x")).toMatchObject({
      state: "downloaded",
      version: 7,
    });
    expect(store.getResidencyState("glm")).toMatchObject({
      state: "ready",
      version: 4,
    });
    expect(
      logs.some(
        (line) =>
          line.includes("reconciled stale deepseek-x ready -> downloaded") &&
          line.includes(`in group ${GROUP}`),
      ),
    ).toBe(true);
    expect(exclusiveViolations()).toEqual([]);
    expect(calls).toEqual(["deepseek-x"]);
  });

  test("UP5: rows outside the replacement group are never probed", async () => {
    // Guard: this may pass at base because reconciliation is already scoped
    // to the replacement's group; it pins that the new predicate does not
    // widen the probe scope.
    seed("other-y", "ready");
    const plan = planFor([GLM]);
    const fx = makeDeps();
    const calls: string[] = [];

    const { report } = await execute(plan, fx.deps, {
      isProvenDown: (model) => {
        calls.push(model);
        return false;
      },
    });

    expect(calls).toEqual([]);
    expect(report.ok).toBe(true);
    expect(store.getResidencyState("glm")).toMatchObject({ state: "ready" });
  });
});
