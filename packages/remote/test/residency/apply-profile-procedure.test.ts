// #284 (DF-11) residencyApplyProfile — RED tests for the wet profile-switch
// mutation surfaced through tRPC. At the pinned base the router has no
// residencyApplyProfile procedure and packages/remote/src/residency/
// apply-profile.js does not exist, so every case fails BY ASSERTION — never
// by import, type or NOT_FOUND: the procedure is probed through _def before
// any call, and the new module is reached only through guarded dynamic
// imports whose exports are asserted `typeof === "function"`.
//
// The mutation is dry-run by default: a bare {node,to,from} call plans and
// reports without opening the store; dryRun:false additionally requires
// confirm:true, refuses NotServingNode off the serving process and
// ControllerActive while a live .controller.lock exists, and — when the plan
// is ok — runs the fenced executor against the node-local operation store,
// recording a terminal operation under model `profile-switch:<node>`.
import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import { runProfileSwitchBootRecovery } from "../../src/residency/boot-recovery.js";
import {
  buildResidencyPlan,
  collectResidencyObservations,
} from "../../src/residency/procedures.js";
import {
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";
import { type ModelRun, ModelRunSchema } from "../../src/workload/schema.js";
import { listWorkloads, loadWorkloadByName, saveWorkload } from "../../src/workload/store.js";

const ROUTER_ENV_KEYS = [
  "LLAMACTL_WORKLOADS_DIR",
  "LLAMACTL_CONFIG",
  "DEV_STORAGE",
  "LLAMACTL_RESIDENCY_STORE",
  "LLAMACTL_NODE_NAME",
] as const;

const PROFILES_ANNOTATION = "llamactl.io/residency-profiles";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type StepOutcome = { ok: true } | { ok: false; detail: string };

type ApplyProfileSteps = {
  stop: (workload: string) => Promise<StepOutcome>;
  start: (workload: string) => Promise<StepOutcome>;
};

type ApplyProfileResult = {
  ok: boolean;
  dryRun?: boolean;
  outcome: string;
  node?: string | null;
  from?: string | null;
  to?: string | null;
  operationId?: string | null;
  steps?: { action: string; workload: string; status: string; detail?: string }[];
  deferred?: string[];
  refusal?: { reason: string; detail: string };
  busy?: { reason: string; node: string; operationId: string; detail: string };
  inFlightOperationId?: string | null;
  controllerPid?: number;
};

type ApplyProfileModule = {
  applyResidencyProfile: (input: Record<string, unknown>) => Promise<ApplyProfileResult>;
  resolveResidencyApplyProfileSteps: (factory: () => ApplyProfileSteps) => ApplyProfileSteps;
  defaultResidencyApplyProfileSteps: (opts: {
    workloadsDir: string;
    applyModelRun: (manifest: unknown) => Promise<unknown>;
  }) => ApplyProfileSteps;
  __setResidencyApplyProfileStepsForTests: (steps: ApplyProfileSteps | null) => void;
};

type FenceIdentity = { ownerId: string; incarnation: string };

type Fence = { ownerId: string; incarnation: string; fenceToken: number };

type StoreHandle = ResidencyOperationStore & ResidencyLifecycleStore;

let tmp = "";
let workloadsDir = "";
let storePath = "";
let savedEnv: Record<string, string | undefined> = {};
let stepCalls: [string, string][] = [];

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

function seedRouterFixture(): void {
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
      spec: { node: "local", budget: { memoryGiB: 24 }, infra: [] },
    },
    workloadsDir,
  );
}

function seedRouterFixtureWithSwitchCooldown(): void {
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
        budget: { memoryGiB: 24 },
        residency: { switchCooldownSeconds: 3600 },
        infra: [],
      },
    },
    workloadsDir,
  );
}

function seedRouterFixtureWithMinResidency(): void {
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
        budget: { memoryGiB: 24 },
        residency: { minResidencySeconds: 3600 },
        infra: [],
      },
    },
    workloadsDir,
  );
}

function seedInflight(fenceIdentity?: FenceIdentity): Fence {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fence = store.claimOwnership(
      fenceIdentity ?? { ownerId: "other-writer", incarnation: "x" },
    );
    const begun = store.beginOperation({
      fenceToken: fence.fenceToken,
      operationId: "op-inflight",
      model: "profile-switch:local",
      targetState: "profile:chat",
      desiredRevision: 0,
      reservationGiB: 0,
      nowMs: Date.now(),
    });
    expect(begun.ok).toBe(true);
    return fence;
  } finally {
    store.close();
  }
}

function withStore<T>(fn: (store: StoreHandle) => T): T {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

// Walks a residency_states row unavailable -> downloaded -> loading -> warming
// -> ready, every hop stamped readyAtMs, so the ready row's updatedAtMs is the
// load time minResidencySeconds measures against.
function seedReadyLifecycle(model: string, readyAtMs: number): void {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fence = store.claimOwnership({ ownerId: "seed", incarnation: "seed" });
    let expectedVersion = 0;
    for (const to of ["downloaded", "loading", "warming", "ready"] as const) {
      const result = store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model,
        to,
        expectedVersion,
        nowMs: readyAtMs,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expectedVersion = result.record.version;
      }
    }
  } finally {
    store.close();
  }
}

function snapshotTree(dir: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of snapshotTree(path, rel)) out.set(key, value);
    } else if (entry.isFile()) {
      out.set(rel, readFileSync(path).toString("base64"));
    }
  }
  return out;
}

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

type ApplyProfileInput = {
  node: string;
  to: string;
  from?: string;
  dryRun?: boolean;
  confirm?: boolean;
};

async function applyProfile(input: ApplyProfileInput): Promise<ApplyProfileResult> {
  const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  expect(Object.keys(procs)).toContain("residencyApplyProfile");
  const caller = router.createCaller({}) as unknown as {
    residencyApplyProfile: (i: ApplyProfileInput) => Promise<ApplyProfileResult>;
  };
  return await caller.residencyApplyProfile(input);
}

async function residencyPlan(input: { node: string; to: string; from?: string }): Promise<{
  ok: boolean;
  replacements?: string[];
  retained?: string[];
  victims?: string[];
}> {
  const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  expect(Object.keys(procs)).toContain("residencyPlan");
  const caller = router.createCaller({}) as unknown as {
    residencyPlan: (i: { node: string; to: string; from?: string }) => Promise<{
      ok: boolean;
      replacements?: string[];
      retained?: string[];
      victims?: string[];
    }>;
  };
  return await caller.residencyPlan(input);
}

// A plan the executor can run: built against an absent store snapshot so the
// in-flight row seeded for the executor race cannot refuse it at plan time.
function buildOkPlan(): Promise<Record<string, unknown>> {
  const observations = collectResidencyObservations({
    node: "local",
    servingNode: "local",
    modelRuns: listWorkloads(),
    modelHosts: [],
    modelHostStatus: () => ({ state: "Stopped" }),
    estimateModelRunGiB: (manifest) => manifest.spec.resources?.expectedMemoryGiB ?? null,
    estimateModelHostGiB: () => null,
  });
  const plan = buildResidencyPlan({
    node: "local",
    to: "code",
    from: "chat",
    nowMs: Date.now(),
    servingNode: "local",
    budgetGiB: 24,
    budgetSource: "noderun",
    modelRuns: observations.modelRuns,
    modelHosts: [],
    observed: observations.observed,
    memoryGiB: observations.memoryGiB,
    store: { path: storePath, present: false },
  });
  expect(plan.ok).toBe(true);
  if (plan.ok) {
    expect(plan.victims).toEqual(["chat-a"]);
    expect(plan.replacements).toEqual(["code-b"]);
  }
  return Promise.resolve(plan);
}

describe("residencyApplyProfile procedure", () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-apply-"));
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
    stepCalls = [];
  });

  afterEach(async () => {
    await resetStepsSeam();
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

  test("R1: the default call is a dry run — planned steps, no calls, no store writes", async () => {
    // kills: dryRun: z.boolean().default(false) or opening the store on dry-run.
    seedRouterFixture();
    await installStepsFake();
    const before = snapshotTree(tmp);

    const result = await applyProfile({ node: "local", to: "code", from: "chat" });

    expect(result.dryRun).toBe(true);
    expect(result.outcome).toBe("dry-run");
    expect(result.ok).toBe(true);
    expect(result.operationId ?? null).toBeNull();
    expect(Array.isArray(result.steps)).toBe(true);
    expect((result.steps ?? []).length).toBeGreaterThan(0);
    for (const step of result.steps ?? []) {
      expect(step.status).toBe("planned");
    }
    expect(stepCalls).toEqual([]);
    const after = snapshotTree(tmp);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(join(tmp, "residency-state"))).toBe(false);
  });

  test("R2: wet apply without confirm is rejected before any step or store", async () => {
    // kills: dropping the confirm refine.
    seedRouterFixture();
    await installStepsFake();

    const err = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).not.toBeNull();
    expect((err as Error).message).toMatch(/confirm: true is required/);
    expect(stepCalls).toEqual([]);
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(join(tmp, "residency-state"))).toBe(false);
  });

  test("R3: a confirmed wet apply runs stops and starts and records a terminal operation", async () => {
    // kills: not passing `operation`, returning a different id than the one recorded, or desiredRevision = Date.now().
    seedRouterFixture();
    await installStepsFake();

    const result = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("stops-and-starts-ran");
    expect(result.from).toBe("chat");
    expect(result.to).toBe("code");
    expect(result.node).toBe("local");
    expect(typeof result.operationId).toBe("string");
    expect(result.operationId).toMatch(UUID_RE);
    expect(stepCalls).toEqual([
      ["stop", "chat-a"],
      ["start", "code-b"],
    ]);
    expect(Array.isArray(result.deferred)).toBe(true);
    expect(result.deferred ?? []).not.toContain("complete");

    const opId = result.operationId!;
    const rec = withStore((store) => store.getOperation(opId));
    expect(rec).not.toBeNull();
    expect(rec?.phase).toBe("terminal");
    expect(rec?.outcome).toBe("succeeded");
    expect(rec?.model).toBe("profile-switch:local");
    expect(rec?.desiredRevision).toBe(0);
  });

  test("R3b: omitting from reports from null — the planner does not infer it", async () => {
    // kills: fabricating a from value.
    seedRouterFixture();
    await installStepsFake();

    const result = await applyProfile({
      node: "local",
      to: "code",
      dryRun: false,
      confirm: true,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("stops-and-starts-ran");
    expect(result.from ?? null).toBeNull();
  });

  test("R4: an in-flight operation refuses the plan as NodeBusy before any step", async () => {
    // kills: building the plan without the store snapshot.
    seedRouterFixture();
    const seededFence = seedInflight();
    await installStepsFake();

    const result = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(result.refusal?.reason).toBe("NodeBusy");
    expect(result.refusal?.detail ?? "").toContain("in-flight operation");
    expect(result.inFlightOperationId).toBe("op-inflight");
    expect(stepCalls).toEqual([]);
    const ops = withStore((store) => store.listNonterminal());
    expect(ops).toHaveLength(1);
    expect(ops[0]?.operationId).toBe("op-inflight");
    expect(ops[0]?.model).toBe("profile-switch:local");
    expect(ops[0]?.phase).toBe("pending");
    const fence = withStore((store) => store.currentFence());
    expect(fence).toEqual(seededFence);
  });

  test("R5: a same-owner in-flight switch reports busy without staling its fence", async () => {
    // kills: claiming over a same-owner in-flight row, which bumps the fence and
    // orphans that switch's record (its finishOperation fails stale-fence).
    seedRouterFixture();
    const seededFence = seedInflight({ ownerId: "t", incarnation: "t0" });
    await installStepsFake();
    const plan = await buildOkPlan();
    const mod = await applyProfileModule();
    expect(typeof mod.applyResidencyProfile).toBe("function");

    const result = await mod.applyResidencyProfile({
      plan,
      fenceIdentity: { ownerId: "t", incarnation: "t1" },
      dryRun: false,
      storePath,
      workloadsDir,
      registry: null,
    });

    expect(result.outcome).toBe("busy");
    expect(result.ok).toBe(false);
    expect(result.busy?.operationId).toBe("op-inflight");
    expect(result.refusal?.reason).toBe("Busy");
    expect(result.operationId ?? null).toBeNull();
    expect(stepCalls).toEqual([]);
    const fenceAfter = withStore((store) => store.currentFence());
    expect(fenceAfter).toEqual(seededFence);
  });

  test("R6: a non-serving node refuses NotServingNode before any step or store", async () => {
    // kills: removing the serving-node guard.
    seedRouterFixture();
    process.env["LLAMACTL_NODE_NAME"] = "other";
    await installStepsFake();

    const result = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe("NotServingNode");
    expect(stepCalls).toEqual([]);
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(join(tmp, "residency-state"))).toBe(false);
  });

  test("R7: a foreign in-flight fence is not claimed over — busy without touching authority", async () => {
    // kills: an unconditional claimOwnership that stales another writer's fence.
    seedRouterFixture();
    seedInflight();
    await installStepsFake();
    const fenceBefore = withStore((store) => store.currentFence());
    const plan = await buildOkPlan();
    const mod = await applyProfileModule();
    expect(typeof mod.applyResidencyProfile).toBe("function");

    const result = await mod.applyResidencyProfile({
      plan,
      fenceIdentity: { ownerId: "t", incarnation: "t1" },
      dryRun: false,
      storePath,
      workloadsDir,
      registry: null,
    });

    expect(result.outcome).toBe("busy");
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe("Busy");
    expect(result.busy?.operationId).toBe("op-inflight");
    const fenceAfter = withStore((store) => store.currentFence());
    expect(fenceAfter).toEqual(fenceBefore);
  });

  test("R8: a live controller lock refuses ControllerActive on wet apply only", async () => {
    // kills: removing the liveLockHolder guard.
    seedRouterFixture();
    writeFileSync(join(workloadsDir, ".controller.lock"), String(process.pid));
    await installStepsFake();

    const wet = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(wet.ok).toBe(false);
    expect(wet.refusal?.reason).toBe("ControllerActive");
    expect(wet.refusal?.detail ?? "").toContain("persist-suppression is deferred");
    expect(wet.controllerPid).toBe(process.pid);
    expect(stepCalls).toEqual([]);
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(join(tmp, "residency-state"))).toBe(false);

    const dry = await applyProfile({ node: "local", to: "code", from: "chat" });
    expect(dry.ok).toBe(true);
    expect(dry.outcome).toBe("dry-run");
  });

  // #279 DF-06 integration: agent-boot recovery must leave the wet mutation
  // able to proceed. A boot claim under any owner but the apply-profile owner
  // makes runWet's foreign-fence check report Busy "unknown" forever.
  test("R8: after boot recovery of a crashed switch, a confirmed wet apply is not Busy", async () => {
    seedRouterFixture();
    await installStepsFake();
    const crashed = withStore((store) => {
      const fence = store.claimOwnership({
        ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
        incarnation: "crashed-cli",
      });
      return store.beginOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-crashed",
        model: "profile-switch:local",
        targetState: "profile:code",
        desiredRevision: 0,
        reservationGiB: 0,
        nowMs: Date.now() - 2 * 60 * 60_000,
      });
    });
    expect(crashed.ok).toBe(true);

    const summary = runProfileSwitchBootRecovery({
      path: storePath,
      incarnation: "agent-boot",
      write: () => undefined,
    });
    expect(summary.status).toBe("recovered");
    expect(summary.recovered).toBe(1);

    const result = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(result.busy).toBeUndefined();
    expect(result.outcome).not.toBe("busy");
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("stops-and-starts-ran");
    expect(stepCalls).toEqual([
      ["stop", "chat-a"],
      ["start", "code-b"],
    ]);
    const crashedRow = withStore((store) => store.getOperation("op-crashed"));
    expect(crashedRow?.phase).toBe("terminal");
    expect(crashedRow?.outcome).toBe("unknown");
  });

  // A store holding only an unrecognized switch row needs no finishing, so
  // boot never claims: the row's own writer can still retire it under its
  // fence, and the wet mutation that follows is not Busy. (While the row is
  // nonterminal the planner refuses NodeBusy on its own.)
  test("R9: boot recovery over only a malformed switch row never claims, so a wet apply is not Busy", async () => {
    seedRouterFixture();
    await installStepsFake();
    const malformed = withStore((store) => {
      const fence = store.claimOwnership({
        ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
        incarnation: "crashed-cli",
      });
      const begun = store.beginOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-malformed",
        model: "profile-switch:other-node",
        targetState: "bogus",
        desiredRevision: 0,
        reservationGiB: 0,
        nowMs: Date.now() - 2 * 60 * 60_000,
      });
      return { fence, begun };
    });
    expect(malformed.begun.ok).toBe(true);
    const fenceBefore = withStore((store) => store.currentFence());

    const summary = runProfileSwitchBootRecovery({
      path: storePath,
      incarnation: "agent-boot",
      write: () => undefined,
    });
    expect(summary.status).toBe("deferred");
    expect(summary.unrecognized).toBe(1);
    expect(withStore((store) => store.currentFence())).toEqual(fenceBefore);

    const retired = withStore((store) => {
      const row = store.getOperation("op-malformed");
      expect(row).not.toBeNull();
      return store.finishOperation({
        fenceToken: malformed.fence.fenceToken,
        operationId: "op-malformed",
        expectedVersion: row?.version ?? -1,
        nowMs: Date.now(),
        outcome: "unknown",
        detail: "retired by its writer",
      });
    });
    expect(retired).toEqual({ ok: true });

    const result = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(result.busy).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("stops-and-starts-ran");
  });

  test("A10: a recorded succeeded switch refuses the next wet apply inside the cooldown", async () => {
    // kills: cooldown not reaching the wet apply path.
    seedRouterFixtureWithSwitchCooldown();
    await installStepsFake();

    const first = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(first.ok).toBe(true);
    expect(first.outcome).toBe("stops-and-starts-ran");
    expect(stepCalls).toEqual([
      ["stop", "chat-a"],
      ["start", "code-b"],
    ]);

    const second = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(second.ok).toBe(false);
    expect(second.outcome).toBe("refused");
    expect(second.refusal?.reason).toBe("Cooldown");
    expect(second.refusal?.detail ?? "").toMatch(/^switch cooldown active \(\d+ms remaining\)$/);
    expect(stepCalls).toEqual([
      ["stop", "chat-a"],
      ["start", "code-b"],
    ]);
  });

  test("A11: with no residency policy two wet applies both run", async () => {
    // kills: enforcing a cooldown the NodeRun never configured.
    seedRouterFixture();
    await installStepsFake();

    const first = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });
    const second = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(first.ok).toBe(true);
    expect(first.outcome).toBe("stops-and-starts-ran");
    expect(second.ok).toBe(true);
    expect(second.outcome).toBe("stops-and-starts-ran");
    expect(stepCalls).toEqual([
      ["stop", "chat-a"],
      ["start", "code-b"],
      ["stop", "chat-a"],
      ["start", "code-b"],
    ]);
  });

  test("A12: a young ready lifecycle row refuses the wet apply with MinResidency", async () => {
    // kills: minResidencySeconds not reaching the wet apply path.
    seedRouterFixtureWithMinResidency();
    seedReadyLifecycle("chat-a", Date.now() - 10_000);
    await installStepsFake();

    const result = await applyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("refused");
    expect(result.refusal?.reason).toBe("MinResidency");
    expect(result.refusal?.detail).toBe("1 victim(s) have not met minimum residency");
    expect(stepCalls).toEqual([]);
  });
});

describe("defaultResidencyApplyProfileSteps", () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-apply-steps-"));
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
    stepCalls = [];
  });

  afterEach(async () => {
    await resetStepsSeam();
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

  test("D1: the default stop clears tracking and persists a Stopped status", async () => {
    // kills: a bare stopServer that never persists the Stopped status.
    seedRouterFixture();
    const mod = await applyProfileModule();
    expect(typeof mod.resolveResidencyApplyProfileSteps).toBe("function");
    expect(typeof mod.defaultResidencyApplyProfileSteps).toBe("function");
    const applyCalls: string[] = [];
    const fakeApply = (manifest: unknown): Promise<unknown> => {
      const name = (manifest as { metadata?: { name?: unknown } } | null)?.metadata?.name;
      applyCalls.push(typeof name === "string" ? name : "?");
      return Promise.resolve({ ok: true });
    };
    const steps = mod.resolveResidencyApplyProfileSteps(() =>
      mod.defaultResidencyApplyProfileSteps({ workloadsDir, applyModelRun: fakeApply }),
    );

    const stopped = await steps.stop("chat-a");

    expect(stopped.ok).toBe(true);
    expect(applyCalls).toEqual([]);
    const stored = loadWorkloadByName("chat-a", workloadsDir);
    expect(stored.status?.phase).toBe("Stopped");
    expect(stored.status?.serverPid ?? null).toBeNull();
    expect(stored.status?.endpoint ?? null).toBeNull();
    // kills: a Ready/True condition written onto a Stopped workload; the repo
    // convention (workload/apply.ts stopDisabledWorkload) is Applied/True.
    expect(stored.status?.conditions).toHaveLength(1);
    expect(stored.status?.conditions[0]?.type).toBe("Applied");
    expect(stored.status?.conditions[0]?.status).toBe("True");
    expect(stored.status?.conditions[0]?.reason).toBe("ResidencyProfileSwitch");
    expect(stored.status?.conditions.some((c) => c.type === "Ready" && c.status === "True")).toBe(
      false,
    );

    const plan = await residencyPlan({ node: "local", to: "chat", from: "code" });
    expect(plan.ok).toBe(true);
    expect(plan.replacements ?? []).toContain("chat-a");
    expect(plan.retained ?? []).not.toContain("chat-a");
  });

  test("D2: the default start refuses an unknown workload without calling apply", async () => {
    // kills: a start mapping that throws or returns ok:true for an unknown workload.
    seedRouterFixture();
    const mod = await applyProfileModule();
    expect(typeof mod.resolveResidencyApplyProfileSteps).toBe("function");
    expect(typeof mod.defaultResidencyApplyProfileSteps).toBe("function");
    let applyCalls = 0;
    const fakeApply = (): Promise<unknown> => {
      applyCalls += 1;
      return Promise.resolve({ ok: true });
    };
    const steps = mod.resolveResidencyApplyProfileSteps(() =>
      mod.defaultResidencyApplyProfileSteps({ workloadsDir, applyModelRun: fakeApply }),
    );

    const result = await steps.start("absent-x");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toContain("absent-x");
    }
    expect(applyCalls).toBe(0);
  });

  test("D3: the default start persists statusSection and maps apply failures", async () => {
    // kills: not persisting statusSection, or mapping a failure as ok.
    seedRouterFixture();
    const mod = await applyProfileModule();
    expect(typeof mod.resolveResidencyApplyProfileSteps).toBe("function");
    expect(typeof mod.defaultResidencyApplyProfileSteps).toBe("function");
    const codeB = loadWorkloadByName("code-b", workloadsDir);
    const statusSection = {
      phase: "Running",
      serverPid: 123,
      endpoint: "http://127.0.0.1:1",
      lastTransitionTime: "2026-01-01T00:00:00.000Z",
      conditions: [],
    };
    let applyOutcome: unknown = {
      ok: true,
      kind: "ModelRun",
      manifest: codeB,
      result: { action: "started", statusSection },
    };
    const fakeApply = (): Promise<unknown> => Promise.resolve(applyOutcome);
    const steps = mod.resolveResidencyApplyProfileSteps(() =>
      mod.defaultResidencyApplyProfileSteps({ workloadsDir, applyModelRun: fakeApply }),
    );

    const started = await steps.start("code-b");

    expect(started.ok).toBe(true);
    expect(loadWorkloadByName("code-b", workloadsDir).status?.phase).toBe("Running");

    applyOutcome = { ok: false, error: "boom" };
    const failed = await steps.start("code-b");
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.detail).toBe("boom");
    }
  });

  test("D4: the test seam overrides the default steps factory", async () => {
    // kills: ignoring the seam.
    const mod = await applyProfileModule();
    expect(typeof mod.__setResidencyApplyProfileStepsForTests).toBe("function");
    expect(typeof mod.resolveResidencyApplyProfileSteps).toBe("function");
    const fake = recordingSteps();
    mod.__setResidencyApplyProfileStepsForTests(fake);
    try {
      const resolved = mod.resolveResidencyApplyProfileSteps(() => {
        throw new Error("no");
      });
      expect(resolved).toBe(fake);
    } finally {
      mod.__setResidencyApplyProfileStepsForTests(null);
    }
  });
});
