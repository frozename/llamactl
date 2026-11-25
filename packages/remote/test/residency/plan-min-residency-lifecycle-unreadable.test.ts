// Part of #519 — residencyPlan / residencyApplyProfile must refuse
// LifecycleUnreadable when minResidencySeconds > 0 but the serving node's
// lifecycle rows cannot be read: a victim's residency age cannot be verified,
// so the switch fails closed instead of evicting blind. A disabled knob, a
// foreign serving node, a victim-free plan and a Cooldown refusal keep their
// current behaviour.
//
// Unit cases call buildResidencyPlan directly with an unreadable-lifecycle
// store snapshot; router cases seed a tmp workloads dir plus a node-local
// store poisoned with an unknown lifecycle state (the R8b trick from
// plan-procedure.test.ts) and drive residencyPlan / residencyApplyProfile
// through router.createCaller.
import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ObservedWorkloadState } from "../../src/residency/coordinator.js";

import { buildResidencyPlan } from "../../src/residency/procedures.js";
import {
  openResidencyOperationStore,
  readResidencyStoreSnapshot,
  type ResidencyStoreSnapshot,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";
import { type ModelRun, ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

type PlanInput = Parameters<typeof buildResidencyPlan>[0];

const NODE = "gpu1";
const NOW_MS = 1_000_000_000;
const PROFILES_ANNOTATION = "llamactl.io/residency-profiles";
const STORE_PATH = "/residency/operations.sqlite";

// The snapshot a failed lifecycle-row read produces: the operations section
// is intact (no `error`) but lifecycleError is set, so min-residency cannot
// be verified.
const UNREADABLE: ResidencyStoreSnapshot = {
  path: STORE_PATH,
  present: true,
  nonterminal: [],
  lifecycleError: "boom",
};

type RunPhase = "Pending" | "Running" | "Failed" | "Stopped";

interface RunManifestOptions {
  node?: string;
  profiles?: string;
  phase?: RunPhase;
  expectedMemoryGiB?: number;
}

function runManifest(name: string, options: RunManifestOptions = {}): ModelRun {
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
      node: options.node ?? NODE,
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

function p1Manifests(): ModelRun[] {
  return [
    runManifest("chat-a", { profiles: "chat", phase: "Running", expectedMemoryGiB: 10 }),
    runManifest("code-b", { profiles: "code", phase: "Stopped", expectedMemoryGiB: 12 }),
    runManifest("embed", { phase: "Running", expectedMemoryGiB: 1 }),
  ];
}

function p1Observed(): Map<string, ObservedWorkloadState> {
  return new Map<string, ObservedWorkloadState>([
    ["chat-a", "running"],
    ["code-b", "stopped"],
    ["embed", "running"],
  ]);
}

function p1Memory(): Map<string, number | null> {
  return new Map<string, number | null>([
    ["chat-a", 10],
    ["code-b", 12],
    ["embed", 1],
  ]);
}

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    node: NODE,
    to: "code",
    nowMs: NOW_MS,
    servingNode: NODE,
    budgetGiB: 24,
    budgetSource: "noderun",
    modelRuns: p1Manifests(),
    modelHosts: [],
    observed: p1Observed(),
    memoryGiB: p1Memory(),
    store: { path: STORE_PATH, present: false },
    ...overrides,
  };
}

describe("buildResidencyPlan unreadable lifecycle (#519)", () => {
  test("LU1: minResidencySeconds with unreadable lifecycle rows refuses LifecycleUnreadable", () => {
    // kills: buildResidencyPlan ignoring snapshot.lifecycleError when
    // minResidencySeconds > 0 (the base fail-open).
    const plan = buildResidencyPlan(
      planInput({ residency: { minResidencySeconds: 300 }, store: UNREADABLE }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("LifecycleUnreadable");
    expect(plan.workloads).toEqual(["chat-a"]);
    expect(plan.steps).toEqual([]);
    expect(plan.retryAfterMs).toBeNull();
    expect(plan.detail).toBe(
      "residency plan refused: lifecycle rows unreadable (boom); minResidencySeconds of 300 cannot be verified for chat-a",
    );
    expect(plan.store?.present).toBe(true);
  });

  test("LU2: a disabled knob, no policy and a foreign serving node do not refuse", () => {
    // kills: refusing when the knob is disabled or the store does not apply
    // to the node.
    const disabled = buildResidencyPlan(
      planInput({ residency: { minResidencySeconds: 0 }, store: UNREADABLE }),
    );
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.victims).toEqual(["chat-a"]);

    const noPolicy = buildResidencyPlan(planInput({ residency: null, store: UNREADABLE }));
    expect(noPolicy.ok).toBe(true);
    if (!noPolicy.ok) return;
    expect(noPolicy.victims).toEqual(["chat-a"]);

    const foreign = buildResidencyPlan(
      planInput({
        residency: { minResidencySeconds: 300 },
        servingNode: "cp",
        store: UNREADABLE,
      }),
    );
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    expect(foreign.victims).toEqual(["chat-a"]);
  });

  test("LU3: a plan with no victims is not refused", () => {
    // kills: refusing every plan regardless of victims.
    const plan = buildResidencyPlan(
      planInput({ to: "chat", residency: { minResidencySeconds: 300 }, store: UNREADABLE }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.victims).toEqual([]);
  });

  test("LU4: a Cooldown refusal keeps its reason and retryAfterMs", () => {
    // kills: the lifecycle refusal pre-empting a planner refusal (Cooldown
    // keeps its retryAfterMs).
    const plan = buildResidencyPlan(
      planInput({
        residency: { minResidencySeconds: 300, switchCooldownSeconds: 600 },
        lastSwitchAtMs: NOW_MS - 10_000,
        store: UNREADABLE,
      }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("Cooldown");
    expect(plan.retryAfterMs).toBe(590_000);
  });
});

const ROUTER_ENV_KEYS = [
  "LLAMACTL_WORKLOADS_DIR",
  "LLAMACTL_CONFIG",
  "DEV_STORAGE",
  "LLAMACTL_RESIDENCY_STORE",
  "LLAMACTL_NODE_NAME",
] as const;

type StepOutcome = { ok: true } | { ok: false; detail: string };

type ApplyProfileSteps = {
  stop: (workload: string) => Promise<StepOutcome>;
  start: (workload: string) => Promise<StepOutcome>;
};

type ApplyProfileModule = {
  __setResidencyApplyProfileStepsForTests: (steps: ApplyProfileSteps | null) => void;
};

type RouterPlanResult = {
  ok: boolean;
  reason?: string;
  detail?: string;
  workloads?: string[];
};

type ApplyProfileResult = {
  ok: boolean;
  outcome: string;
  detail?: string;
  refusal?: { reason: string; detail: string };
};

type ApplyProfileInput = {
  node: string;
  to: string;
  from?: string;
  dryRun?: boolean;
  confirm?: boolean;
};

let tmp = "";
let workloadsDir = "";
let storePath = "";
let stepCalls: [string, string][] = [];

function recordingSteps(): ApplyProfileSteps {
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

async function applyProfileModule(): Promise<ApplyProfileModule> {
  const mod = (await import("../../src/residency/apply-profile.js").catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return mod as unknown as ApplyProfileModule;
}

async function installStepsFake(): Promise<void> {
  const mod = await applyProfileModule();
  expect(typeof mod.__setResidencyApplyProfileStepsForTests).toBe("function");
  mod.__setResidencyApplyProfileStepsForTests(recordingSteps());
}

async function resetStepsSeam(): Promise<void> {
  const mod = (await import("../../src/residency/apply-profile.js").catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const reset = mod["__setResidencyApplyProfileStepsForTests"];
  if (typeof reset === "function") {
    (reset as (steps: ApplyProfileSteps | null) => void)(null);
  }
}

function seedRouterFixture(): void {
  saveWorkload(
    runManifest("chat-a", {
      node: "local",
      profiles: "chat",
      phase: "Running",
      expectedMemoryGiB: 10,
    }),
    workloadsDir,
  );
  saveWorkload(
    runManifest("code-b", {
      node: "local",
      profiles: "code",
      phase: "Stopped",
      expectedMemoryGiB: 12,
    }),
    workloadsDir,
  );
  saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "local", labels: {} },
      spec: {
        node: "local",
        budget: { memoryGiB: 24 },
        residency: { minResidencySeconds: 3600 },
        infra: [],
      },
    },
    workloadsDir,
  );
}

// Migrates the store, then writes an unknown residency_states row the way R8b
// does: the lifecycle-row read fails while the operations section stays
// readable, so the snapshot carries lifecycleError.
function poisonLifecycle(path: string): void {
  openResidencyOperationStore({ path }).close();
  const raw = new Database(path);
  try {
    raw.run("PRAGMA ignore_check_constraints = ON");
    raw.run(
      "INSERT INTO residency_states (model, residency_group, state, owner_id, incarnation, fence_token, version, updated_at_ms, desired_revision) VALUES ('m-new', NULL, 'hibernating', 'o', 'i', 1, 1, 5, NULL)",
    );
  } finally {
    raw.close();
  }
  const snap = readResidencyStoreSnapshot(path);
  expect("lifecycleError" in snap ? snap.lifecycleError : undefined).toBeDefined();
}

async function residencyPlan(input: { node: string; to: string }): Promise<RouterPlanResult> {
  const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  expect(Object.keys(procs)).toContain("residencyPlan");
  const caller = router.createCaller({}) as unknown as {
    residencyPlan: (i: { node: string; to: string }) => Promise<RouterPlanResult>;
  };
  return await caller.residencyPlan(input);
}

async function applyProfile(input: ApplyProfileInput): Promise<ApplyProfileResult> {
  const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  expect(Object.keys(procs)).toContain("residencyApplyProfile");
  const caller = router.createCaller({}) as unknown as {
    residencyApplyProfile: (i: ApplyProfileInput) => Promise<ApplyProfileResult>;
  };
  return await caller.residencyApplyProfile(input);
}

describe("residencyPlan / residencyApplyProfile lifecycle-unreadable router (#519)", () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-plan-lifecycle-unreadable-"));
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
    setResidencyLeaseRegistry(null);
    stepCalls = [];
  });

  afterEach(async () => {
    await resetStepsSeam();
    setResidencyLeaseRegistry(null);
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

  test("LU5: residencyPlan refuses LifecycleUnreadable through the router", async () => {
    // kills: the router path not reaching the refusal.
    seedRouterFixture();
    poisonLifecycle(storePath);

    const result = await residencyPlan({ node: "local", to: "code" });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("LifecycleUnreadable");
    expect(result.workloads).toEqual(["chat-a"]);
    expect(result.detail).toContain("minResidencySeconds of 3600");
  });

  test("LU6: a wet apply-profile refuses before any step on unreadable lifecycle rows", async () => {
    // kills: a wet switch stopping an unverifiable young victim.
    seedRouterFixture();
    poisonLifecycle(storePath);
    await installStepsFake();

    const result: ApplyProfileResult = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    }).catch(
      (e: unknown): ApplyProfileResult => ({ ok: true, outcome: "threw", detail: String(e) }),
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(result.refusal?.reason).toBe("LifecycleUnreadable");
    expect(stepCalls).toEqual([]);
  });
});
