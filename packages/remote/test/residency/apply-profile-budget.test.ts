// Part of #276 (DF-03): the profile-switch production caller reserves its
// replacements and passes the resolved node budget into the residency store.
//
// RED contract: at the pinned base `applyResidencyProfile` records the switch
// with reservationGiB 0 and no nodeBudgetGiB, so the store's budget admission
// never sees the reservation. Every case fails BY ASSERTION at runtime:
// apply-profile.js exists at base and is imported statically, and the `log`
// arg it does not yet declare is simply ignored there.
import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResidencyPlan } from "../../src/residency/procedures.js";
import type { ProfileSwitchExecutorDeps } from "../../src/residency/profile-transition.js";

import {
  __setResidencyApplyProfileStepsForTests,
  applyResidencyProfile,
  RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
  type ResidencyApplyProfileResult,
} from "../../src/residency/apply-profile.js";
import {
  openResidencyOperationStore,
  type ResidencyOperationStore,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";
import { type ModelRun, ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

const ROUTER_ENV_KEYS = [
  "LLAMACTL_WORKLOADS_DIR",
  "LLAMACTL_CONFIG",
  "DEV_STORAGE",
  "LLAMACTL_RESIDENCY_STORE",
  "LLAMACTL_NODE_NAME",
] as const;

const PROFILES_ANNOTATION = "llamactl.io/residency-profiles";

type OkResidencyPlan = Extract<ResidencyPlan, { ok: true }>;

let tmp = "";
let workloadsDir = "";
let storePath = "";
let savedEnv: Record<string, string | undefined> = {};
let stepCalls: [string, string][] = [];
let fixtureBudgetGiB = 0;

function runManifest(
  name: string,
  options: {
    profiles?: string;
    phase?: "Pending" | "Running" | "Failed" | "Stopped";
    expectedMemoryGiB?: number;
  } = {},
): ModelRun {
  const annotations =
    options.profiles === undefined ? undefined : { [PROFILES_ANNOTATION]: options.profiles };
  return ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: {
      name,
      ...(annotations === undefined ? {} : { annotations }),
    },
    spec: {
      node: "local",
      enabled: true,
      target: { kind: "rel", value: "org/repo/run.gguf" },
      ...(options.expectedMemoryGiB === undefined
        ? {}
        : { resources: { expectedMemoryGiB: options.expectedMemoryGiB } }),
    },
    ...(options.phase === undefined
      ? {}
      : {
          status: {
            phase: options.phase,
            lastTransitionTime: "2026-01-01T00:00:00.000Z",
          },
        }),
  });
}

function seedFixture(budgetGiB: number): void {
  fixtureBudgetGiB = budgetGiB;
  saveWorkload(
    runManifest("chat-a", { profiles: "chat", phase: "Running", expectedMemoryGiB: 10 }),
    workloadsDir,
  );
  saveWorkload(
    runManifest("code-b", { profiles: "code", phase: "Stopped", expectedMemoryGiB: 12 }),
    workloadsDir,
  );
  saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "local", labels: {} },
      spec: {
        node: "local",
        budget: { memoryGiB: budgetGiB },
        residency: { safetyMarginRatio: 0.01 },
        infra: [],
      },
    },
    workloadsDir,
  );
}

// A held reservation from another writer. Must run AFTER routerPlan(): any
// nonterminal row makes the planner refuse NodeBusy. Same fence owner as the
// apply-profile caller so runWet does not report a foreign-owner busy.
function seedHeld(reservationGiB: number): void {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fence = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    });
    const begun = store.beginOperation({
      fenceToken: fence.fenceToken,
      operationId: "op-held",
      model: "wake:other",
      targetState: "ready",
      desiredRevision: 0,
      reservationGiB,
      nowMs: Date.now(),
    });
    expect(begun.ok).toBe(true);
  } finally {
    store.close();
  }
}

function withStore<T>(fn: (store: ResidencyOperationStore) => T): T {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function recordingSteps(): ProfileSwitchExecutorDeps {
  return {
    stop: (workload: string): Promise<{ ok: true }> => {
      stepCalls.push(["stop", workload]);
      return Promise.resolve({ ok: true });
    },
    start: (workload: string): Promise<{ ok: true }> => {
      stepCalls.push(["start", workload]);
      return Promise.resolve({ ok: true });
    },
  };
}

// Plans chat -> code against a store file that does not exist yet, so no
// in-flight row can refuse it. Asserts the resolved node budget the NodeRun
// declared (source "noderun"), never a host-RAM read.
async function routerPlan(): Promise<OkResidencyPlan> {
  const caller = router.createCaller({}) as unknown as {
    residencyPlan: (input: { node: string; to: string; from: string }) => Promise<ResidencyPlan>;
  };
  const plan = await caller.residencyPlan({ node: "local", to: "code", from: "chat" });
  expect(plan.ok).toBe(true);
  if (!plan.ok) {
    throw new Error(`residencyPlan refused: ${plan.reason}`);
  }
  expect(plan.replacements).toEqual(["code-b"]);
  expect(plan.victims).toEqual(["chat-a"]);
  expect(plan.budget).toEqual({ memoryGiB: fixtureBudgetGiB, source: "noderun" });
  return plan;
}

async function wetApply(plan: ResidencyPlan, logs: string[]): Promise<ResidencyApplyProfileResult> {
  return await applyResidencyProfile({
    plan,
    dryRun: false,
    storePath,
    workloadsDir,
    registry: null,
    node: "local",
    to: "code",
    from: "chat",
    log: (line: string) => logs.push(line),
  });
}

describe("residencyApplyProfile node budget (#276)", () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-budget-"));
    workloadsDir = join(tmp, "workloads");
    storePath = join(tmp, "residency-state", "operations.sqlite");
    savedEnv = {};
    for (const key of ROUTER_ENV_KEYS) savedEnv[key] = process.env[key];
    Object.assign(process.env, {
      LLAMACTL_WORKLOADS_DIR: workloadsDir,
      LLAMACTL_CONFIG: join(tmp, "config-missing"),
      DEV_STORAGE: join(tmp, "dev"),
      LLAMACTL_RESIDENCY_STORE: storePath,
      LLAMACTL_NODE_NAME: "local",
    });
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    setResidencyLeaseRegistry(null);
    __setResidencyApplyProfileStepsForTests(recordingSteps());
    stepCalls = [];
    fixtureBudgetGiB = 0;
  });

  afterEach(() => {
    __setResidencyApplyProfileStepsForTests(null);
    setResidencyLeaseRegistry(null);
    setSystemTime();
    rmSync(tmp, { recursive: true, force: true });
    for (const key of ROUTER_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
    tmp = "";
  });

  test("a reservation that would exceed the resolved node budget is refused by the store and nothing starts", async () => {
    // kills: apply-profile not passing nodeBudgetGiB; beginSwitchOperation not
    // forwarding it; reservationGiB left at 0.
    seedFixture(24);
    const plan = await routerPlan();
    seedHeld(13);
    const fenceBefore = withStore((store) => store.currentFence());
    const logs: string[] = [];

    const result = await wetApply(plan, logs);

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(result.refusal).toEqual({
      reason: "operation-record-refused",
      detail: "reservation-exceeds-budget",
    });
    expect(stepCalls).toEqual([]);
    expect(result.operationId).toBeUndefined();
    expect(withStore((store) => store.currentFence())).toEqual(fenceBefore);
    const nonterminal = withStore((store) =>
      store.listNonterminal().map((record) => record.operationId),
    );
    expect(nonterminal).toEqual(["op-held"]);
  });

  test("within budget proceeds and records the replacements' reservation", async () => {
    // kills: a constant 0 reservation; reserving beforeGiB (10) instead of the
    // reserve step; refusing at equality; logging unconditionally.
    seedFixture(24);
    const plan = await routerPlan();
    seedHeld(12);
    const logs: string[] = [];

    const result = await wetApply(plan, logs);

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("stops-and-starts-ran");
    expect(stepCalls).toEqual([
      ["stop", "chat-a"],
      ["start", "code-b"],
    ]);
    expect(logs).toEqual([]);
    const record = withStore((store) => store.getOperation(result.operationId!));
    expect(record?.phase).toBe("terminal");
    expect(record?.outcome).toBe("succeeded");
    expect(record?.model).toBe("profile-switch:local");
    expect(record?.reservationGiB).toBe(12);
  });

  test("explicit NodeRun budget wins over the residency-policy computed budget", async () => {
    // kills: apply-profile re-resolving the budget with
    // defaultNodeBudgetGiB(undefined, undefined, residency) — the 1% computed
    // budget refuses 18 + 12 — or passing a hardcoded budget instead of the
    // plan's resolved one.
    seedFixture(30);
    const plan = await routerPlan();
    seedHeld(18);
    const logs: string[] = [];

    const result = await wetApply(plan, logs);

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("stops-and-starts-ran");
    const record = withStore((store) => store.getOperation(result.operationId!));
    expect(record?.reservationGiB).toBe(12);
  });

  test("unknown budget keeps today's behaviour and logs once", async () => {
    // kills: passing 0 or NaN as the budget for unknown (the store refuses or
    // rejects invalid-input); dropping the log; logging per step or twice.
    seedFixture(24);
    const okPlan = await routerPlan();
    const plan: ResidencyPlan = { ...okPlan, budgetGiB: null };
    seedHeld(30);
    const logs: string[] = [];

    const result = await wetApply(plan, logs);

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("stops-and-starts-ran");
    expect(stepCalls).toEqual([
      ["stop", "chat-a"],
      ["start", "code-b"],
    ]);
    const record = withStore((store) => store.getOperation(result.operationId!));
    expect(record?.reservationGiB).toBe(12);
    expect(logs).toHaveLength(1);
    expect(logs[0] ?? "").toMatch(/node budget unknown/);
    expect(logs[0] ?? "").toContain("local");
  });
});
