// #284 (DF-11) residencyPlan, Part of #284
// Part of #519: residencyPlan honours NodeRun residency (margin + planner policy)
//
// residencyPlan is a dry-run profile-switch plan surfaced through tRPC:
// it gathers the node's declared workloads, observed residency state,
// memory estimates and the node-local operation-store snapshot, then
// returns the core planProfileSwitch verdict wrapped in provenance —
// servingNode, storeAppliesToNode, inFlightOperationId, budget and the
// store echo.
//
// At the pinned base none of buildResidencyPlan, observedFromModelRun,
// observedFromModelHostStatus or collectResidencyObservations exist and
// the router has no residencyPlan procedure, so both seams are probed
// through a guarded dynamic import and an untyped _def lookup — every
// case fails by assertion, never by a missing module, a type error, or
// an unknown-procedure NOT_FOUND.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";

import { router } from "../../src/router.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "../../src/safe-fs.js";
import { defaultNodeBudgetGiB } from "../../src/workload/admission.js";
import {
  type ModelHostManifest,
  ModelHostManifestSchema,
} from "../../src/workload/modelhost-schema.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";
import { type ModelRun, ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

type ObservedWorkloadState = "running" | "starting" | "stopped" | "unknown";

type ModelHostStatusProbe = {
  state: string;
  identityUnknown?: boolean;
};

type ResidencyPlanBudget = { memoryGiB: number; source: "noderun" | "computed" };

type ResidencyPlanStoreOperation = {
  operationId: string;
  model: string;
  phase: string;
  targetState: string;
  reservationGiB: number;
};

type ResidencyPlanStore =
  | { path: string; present: false; scope: "serving-process" }
  | { path: string; present: true; error: string; scope: "serving-process" }
  | {
      path: string;
      present: true;
      nonterminalCount: number;
      nonterminal: ResidencyPlanStoreOperation[];
      scope: "serving-process";
    };

// The plan payload is the core ProfileSwitchPlan (OkPlan | RefusalPlan)
// plus the provenance envelope. Refusals raised while assembling the
// switch request (NotOptedIn / UnknownState / DuplicateId / UnknownMemory)
// carry no envelope; store and planner stage results do.
type ResidencyPlan = {
  ok: boolean;
  noop?: boolean;
  node?: string;
  from?: string | null;
  to?: string;
  victims?: string[];
  replacements?: string[];
  retained?: string[];
  protected?: string[];
  skipped?: string[];
  beforeGiB?: number;
  afterGiB?: number;
  peakGiB?: number;
  budgetGiB?: number | null;
  steps?: { kind: string }[];
  deadlineMs?: number;
  reason?: string;
  detail?: string;
  workloads?: string[];
  retryAfterMs?: number | null;
  dryRun?: boolean;
  inFlightOperationId?: string | null;
  storeAppliesToNode?: boolean;
  servingNode?: string | null;
  budget?: ResidencyPlanBudget;
  store?: ResidencyPlanStore;
};

type OperationPhase = "pending" | "committed" | "terminal";
type OperationOutcome = "succeeded" | "failed" | "cancelled" | "unknown";

type OperationRecord = {
  operationId: string;
  model: string;
  targetState: string;
  desiredRevision: number;
  reservationGiB: number;
  phase: OperationPhase;
  outcome: OperationOutcome | null;
  detail: string | null;
  ownerId: string;
  incarnation: string;
  fenceToken: number;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
};

type StoreSnapshot =
  | { path: string; present: false }
  | { path: string; present: true; error: string }
  | { path: string; present: true; nonterminal: OperationRecord[] };

type BuildResidencyPlanInput = {
  node: string;
  to: string;
  from?: string | null;
  nowMs: number;
  servingNode: string | null;
  budgetGiB: number;
  budgetSource: "noderun" | "computed";
  modelRuns: readonly ModelRun[];
  modelHosts: readonly ModelHostManifest[];
  observed: ReadonlyMap<string, ObservedWorkloadState>;
  memoryGiB: ReadonlyMap<string, number | null>;
  store: StoreSnapshot;
  residency?: {
    safetyMarginRatio?: number;
    minResidencySeconds?: number;
    switchCooldownSeconds?: number;
    idleEvictSeconds?: number;
  } | null;
  lastSwitchAtMs?: number | null;
};

type CollectResidencyObservationsInput = {
  node: string;
  servingNode: string | null;
  modelRuns: readonly ModelRun[];
  modelHosts: readonly ModelHostManifest[];
  modelHostStatus: (workload: string) => ModelHostStatusProbe;
  estimateModelRunGiB: (manifest: ModelRun) => number | null;
  estimateModelHostGiB: (manifest: ModelHostManifest) => number | null;
};

type ResidencyObservations = {
  modelRuns: readonly ModelRun[];
  modelHosts: readonly ModelHostManifest[];
  observed: ReadonlyMap<string, ObservedWorkloadState>;
  memoryGiB: ReadonlyMap<string, number | null>;
};

type PlanModule = {
  buildResidencyPlan: (input: BuildResidencyPlanInput) => ResidencyPlan;
  observedFromModelRun: (manifest: ModelRun) => ObservedWorkloadState;
  observedFromModelHostStatus: (status: ModelHostStatusProbe) => ObservedWorkloadState;
  collectResidencyObservations: (input: CollectResidencyObservationsInput) => ResidencyObservations;
};

const NODE = "gpu1";
const NOW_MS = 1_000_000_000;
const PROFILES_ANNOTATION = "llamactl.io/residency-profiles";
const STORE_PATH = "/residency/operations.sqlite";

async function loadPlanMod(): Promise<PlanModule> {
  const mod = (await import("../../src/residency/procedures.js").catch(() => ({}))) as Record<
    string,
    unknown
  >;
  expect(typeof mod["buildResidencyPlan"]).toBe("function");
  expect(typeof mod["observedFromModelRun"]).toBe("function");
  expect(typeof mod["observedFromModelHostStatus"]).toBe("function");
  expect(typeof mod["collectResidencyObservations"]).toBe("function");
  return {
    buildResidencyPlan: mod["buildResidencyPlan"] as PlanModule["buildResidencyPlan"],
    observedFromModelRun: mod["observedFromModelRun"] as PlanModule["observedFromModelRun"],
    observedFromModelHostStatus: mod[
      "observedFromModelHostStatus"
    ] as PlanModule["observedFromModelHostStatus"],
    collectResidencyObservations: mod[
      "collectResidencyObservations"
    ] as PlanModule["collectResidencyObservations"],
  };
}

type RunPhase = "Pending" | "Running" | "Failed" | "Stopped";

interface RunManifestOptions {
  node?: string;
  enabled?: boolean;
  profiles?: string;
  phase?: RunPhase;
  expectedMemoryGiB?: number;
  gateway?: boolean;
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
      enabled: options.enabled ?? true,
      target: { kind: "rel", value: "org/repo/run.gguf" },
      ...(options.expectedMemoryGiB === undefined
        ? {}
        : { resources: { expectedMemoryGiB: options.expectedMemoryGiB } }),
      ...(options.gateway === true ? { gateway: true } : {}),
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

function hostManifest(name: string, options: { node?: string } = {}): ModelHostManifest {
  return ModelHostManifestSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name },
    spec: {
      engine: "omlx",
      node: options.node ?? NODE,
      binary: "/x/engine",
      endpoint: { host: "127.0.0.1", port: 8100 },
      hostedModels: [{ rel: "org/repo/m.gguf" }],
    },
  });
}

function opRecord(operationId: string): OperationRecord {
  return {
    operationId,
    model: `model-${operationId}`,
    targetState: "ready",
    desiredRevision: 1,
    reservationGiB: 4,
    phase: "pending",
    outcome: null,
    detail: null,
    ownerId: "owner",
    incarnation: "incarnation",
    fenceToken: 1,
    version: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
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

function observedWith(
  base: ReadonlyMap<string, ObservedWorkloadState>,
  name: string,
  state: ObservedWorkloadState,
): Map<string, ObservedWorkloadState> {
  return new Map<string, ObservedWorkloadState>(base).set(name, state);
}

function memoryWith(
  base: ReadonlyMap<string, number | null>,
  name: string,
  gib: number | null,
): Map<string, number | null> {
  return new Map<string, number | null>(base).set(name, gib);
}

function planInput(overrides: Partial<BuildResidencyPlanInput> = {}): BuildResidencyPlanInput {
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

function argName(arg: unknown): string {
  if (typeof arg === "string") return arg;
  const name = (arg as { metadata?: { name?: unknown } } | null | undefined)?.metadata?.name;
  return typeof name === "string" ? name : "?";
}

describe("buildResidencyPlan", () => {
  test("P1: plans the switch — victim out, replacement in, unannotated protected", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(planInput());
    expect(plan.ok).toBe(true);
    expect(plan.victims).toEqual(["chat-a"]);
    expect(plan.replacements).toEqual(["code-b"]);
    expect(plan.protected).toEqual(["embed"]);
    expect(plan.dryRun).toBe(true);
    expect(plan.inFlightOperationId).toBe(null);
    expect(plan.storeAppliesToNode).toBe(true);
    expect(plan.servingNode).toBe("gpu1");
    expect(plan.budget).toEqual({ memoryGiB: 24, source: "noderun" });
  });

  test("P2: refuses NotOptedIn when no workload carries the profiles annotation", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({
        modelRuns: [
          runManifest("chat-a", { phase: "Running", expectedMemoryGiB: 10 }),
          runManifest("code-b", { phase: "Stopped", expectedMemoryGiB: 12 }),
          runManifest("embed", { phase: "Running", expectedMemoryGiB: 1 }),
        ],
      }),
    );
    const { detail, ...rest } = plan;
    expect(typeof detail).toBe("string");
    expect(rest).toEqual({
      ok: false,
      reason: "NotOptedIn",
      workloads: [],
      retryAfterMs: null,
      steps: [],
    });
  });

  test("P3: refuses UnknownState when an annotated workload is observed unknown", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({ observed: observedWith(p1Observed(), "chat-a", "unknown") }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe("UnknownState");
    expect(plan.workloads).toEqual(["chat-a"]);
  });

  test("P4: refuses UnknownMemory when a replacement's memory is null", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({ memoryGiB: memoryWith(p1Memory(), "code-b", null) }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe("UnknownMemory");
    expect(plan.workloads).toEqual(["code-b"]);
  });

  test("P5: ignores off-node workloads entirely", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({
        modelRuns: [
          ...p1Manifests(),
          runManifest("far-run", { node: "gpu2", profiles: "chat", phase: "Running" }),
        ],
        observed: observedWith(p1Observed(), "far-run", "unknown"),
        memoryGiB: memoryWith(p1Memory(), "far-run", null),
      }),
    );
    expect(plan.ok).toBe(true);
    expect(plan.victims).toEqual(["chat-a"]);
    expect(plan.replacements).toEqual(["code-b"]);
  });

  test("P6: a nonterminal store op on the serving node refuses NodeBusy", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({
        store: { path: STORE_PATH, present: true, nonterminal: [opRecord("op-1")] },
      }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe("NodeBusy");
    expect(plan.inFlightOperationId).toBe("op-1");
    expect(plan.storeAppliesToNode).toBe(true);
  });

  test("P6b: the same store does not gate a foreign node but is still echoed", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({
        servingNode: "cp",
        store: { path: STORE_PATH, present: true, nonterminal: [opRecord("op-1")] },
      }),
    );
    expect(plan.ok).toBe(true);
    expect(plan.inFlightOperationId).toBe(null);
    expect(plan.storeAppliesToNode).toBe(false);
    expect(plan.servingNode).toBe("cp");
    expect(plan.store).toMatchObject({
      scope: "serving-process",
      present: true,
      nonterminalCount: 1,
    });
  });

  test("P7: an unreadable store on the serving node refuses StoreUnreadable", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({
        store: { path: STORE_PATH, present: true, error: "no such table: operations" },
      }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe("StoreUnreadable");
    expect(plan.detail).toContain("no such table: operations");
    expect(plan.store).toMatchObject({
      scope: "serving-process",
      error: "no such table: operations",
    });
  });

  test("P7b: an unreadable store with no serving node does not gate the plan", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({
        servingNode: null,
        store: { path: STORE_PATH, present: true, error: "no such table: operations" },
      }),
    );
    expect(plan.ok).toBe(true);
    expect(plan.storeAppliesToNode).toBe(false);
    expect(plan.servingNode).toBe(null);
    expect(plan.store).toMatchObject({
      scope: "serving-process",
      error: "no such table: operations",
    });
  });

  test("P9: null memory on an uncounted workload does not refuse", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({
        modelRuns: [...p1Manifests(), runManifest("spare", { phase: "Stopped" })],
        observed: observedWith(p1Observed(), "spare", "stopped"),
        memoryGiB: memoryWith(p1Memory(), "spare", null),
      }),
    );
    expect(plan.ok).toBe(true);
    expect(plan.replacements).toEqual(["code-b"]);
  });

  test("P9b: null memory on a disabled target-profile workload is skipped, not refused", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({
        modelRuns: [
          ...p1Manifests(),
          runManifest("code-off", { enabled: false, profiles: "code", phase: "Stopped" }),
        ],
        observed: observedWith(p1Observed(), "code-off", "stopped"),
        memoryGiB: memoryWith(p1Memory(), "code-off", null),
      }),
    );
    expect(plan.ok).toBe(true);
    expect(plan.skipped).toContain("code-off");
    expect(plan.replacements).toEqual(["code-b"]);
  });

  test("P10: null memory on an occupying protected workload refuses UnknownMemory", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({ memoryGiB: memoryWith(p1Memory(), "embed", null) }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe("UnknownMemory");
    expect(plan.workloads).toEqual(["embed"]);
  });

  test("P13: NodeRun residency switchCooldownSeconds refuses Cooldown with retryAfterMs", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({
        residency: { switchCooldownSeconds: 60 },
        lastSwitchAtMs: NOW_MS - 10_000,
      }),
    );
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe("Cooldown");
    expect(plan.retryAfterMs).toBe(50_000);
    expect(plan.detail).toBe("switch cooldown active (50000ms remaining)");
  });

  test("P14: an elapsed switch cooldown does not refuse", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(
      planInput({
        residency: { switchCooldownSeconds: 60 },
        lastSwitchAtMs: NOW_MS - 120_000,
      }),
    );
    expect(plan.ok).toBe(true);
    expect(plan.victims).toEqual(["chat-a"]);
    expect(plan.replacements).toEqual(["code-b"]);
  });

  test("P15: lastSwitchAtMs without residency keeps the default zero cooldown", async () => {
    const { buildResidencyPlan } = await loadPlanMod();
    const plan = buildResidencyPlan(planInput({ lastSwitchAtMs: NOW_MS - 10_000 }));
    expect(plan.ok).toBe(true);
  });
});

describe("observedFromModelRun / observedFromModelHostStatus", () => {
  test("P8: ModelRun phase maps conservatively, Failed/Pending are unknown", async () => {
    const { observedFromModelRun } = await loadPlanMod();
    expect(observedFromModelRun(runManifest("r-run", { phase: "Running" }))).toBe("running");
    expect(observedFromModelRun(runManifest("r-stopped", { phase: "Stopped" }))).toBe("stopped");
    expect(observedFromModelRun(runManifest("r-failed", { phase: "Failed" }))).toBe("unknown");
    expect(observedFromModelRun(runManifest("r-pending", { phase: "Pending" }))).toBe("unknown");
    expect(observedFromModelRun(runManifest("r-enabled", { enabled: true }))).toBe("unknown");
    expect(observedFromModelRun(runManifest("r-disabled", { enabled: false }))).toBe("stopped");
  });

  test("P8: ModelHost pid-liveness is starting, identity-unknown is unknown", async () => {
    const { observedFromModelHostStatus } = await loadPlanMod();
    expect(observedFromModelHostStatus({ state: "Running" })).toBe("starting");
    expect(observedFromModelHostStatus({ state: "Stopped" })).toBe("stopped");
    expect(observedFromModelHostStatus({ state: "Running", identityUnknown: true })).toBe(
      "unknown",
    );
    expect(observedFromModelHostStatus({ state: "Stopped", identityUnknown: true })).toBe(
      "unknown",
    );
  });
});

describe("collectResidencyObservations", () => {
  test("P11: gateway runs are excluded and declared memory wins over the estimator", async () => {
    const { collectResidencyObservations } = await loadPlanMod();
    const estimateCalls: string[] = [];
    const result = collectResidencyObservations({
      node: NODE,
      servingNode: NODE,
      modelRuns: [
        runManifest("gw", { gateway: true, phase: "Pending" }),
        runManifest("chat-a", { phase: "Running", expectedMemoryGiB: 10 }),
        runManifest("code-b", { phase: "Stopped" }),
      ],
      modelHosts: [],
      modelHostStatus: () => ({ state: "Stopped" }),
      estimateModelRunGiB: (manifest) => {
        estimateCalls.push(argName(manifest));
        return 7;
      },
      estimateModelHostGiB: () => null,
    });
    expect(result.modelRuns.map((manifest) => manifest.metadata.name)).toEqual([
      "chat-a",
      "code-b",
    ]);
    expect(result.observed.has("gw")).toBe(false);
    expect(result.observed.get("chat-a")).toBe("running");
    expect(result.observed.get("code-b")).toBe("stopped");
    expect(result.memoryGiB.get("chat-a")).toBe(10);
    expect(result.memoryGiB.get("code-b")).toBe(7);
    expect(estimateCalls).toEqual(["code-b"]);
  });

  test("P12: ModelHost status is probed only when the target node is the serving node", async () => {
    const { collectResidencyObservations } = await loadPlanMod();
    const chatA = runManifest("chat-a", { phase: "Running" });
    const mh = hostManifest("mh");

    const localCalls: string[] = [];
    const local = collectResidencyObservations({
      node: NODE,
      servingNode: NODE,
      modelRuns: [chatA],
      modelHosts: [mh],
      modelHostStatus: (workload) => {
        localCalls.push(argName(workload));
        return { state: "Running" };
      },
      estimateModelRunGiB: () => 5,
      estimateModelHostGiB: () => null,
    });
    expect(local.observed.get("mh")).toBe("starting");
    expect(localCalls).toEqual(["mh"]);
    expect(local.memoryGiB.get("mh")).toBeNull();

    const remoteCalls: string[] = [];
    const remote = collectResidencyObservations({
      node: NODE,
      servingNode: "cp",
      modelRuns: [chatA],
      modelHosts: [mh],
      modelHostStatus: (workload) => {
        remoteCalls.push(argName(workload));
        return { state: "Running" };
      },
      estimateModelRunGiB: () => 5,
      estimateModelHostGiB: () => null,
    });
    expect(remoteCalls).toEqual([]);
    expect(remote.observed.has("mh")).toBe(false);
    expect(remote.modelRuns.map((manifest) => manifest.metadata.name)).toContain("chat-a");
    expect(remote.observed.get("chat-a")).toBe("running");
  });
});

const ROUTER_ENV_KEYS = [
  "LLAMACTL_WORKLOADS_DIR",
  "LLAMACTL_CONFIG",
  "DEV_STORAGE",
  "LLAMACTL_RESIDENCY_STORE",
  "LLAMACTL_NODE_NAME",
] as const;

let tmp = "";
let workloadsDir = "";
let storePath = "";

async function plan(input: { node: string; to: string; from?: string }): Promise<ResidencyPlan> {
  const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  expect(Object.keys(procs)).toContain("residencyPlan");
  const caller = router.createCaller({}) as unknown as {
    residencyPlan: (i: { node: string; to: string; from?: string }) => Promise<ResidencyPlan>;
  };
  return await caller.residencyPlan(input);
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
      spec: { node: "local", budget: { memoryGiB: 24 }, infra: [] },
    },
    workloadsDir,
  );
}

function seedRouterFixtureResidency(input: {
  residency: {
    safetyMarginRatio?: number;
    minResidencySeconds?: number;
    switchCooldownSeconds?: number;
    idleEvictSeconds?: number;
  };
  budget?: { memoryGiB: number };
}): void {
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
        ...(input.budget === undefined ? {} : { budget: input.budget }),
        residency: input.residency,
        infra: [],
      },
    },
    workloadsDir,
  );
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

describe("residencyPlan procedure", () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-plan-"));
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
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const key of ROUTER_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  test("R1: dry run only — manifests byte-identical, no store file created", async () => {
    seedRouterFixture();
    const before = snapshotTree(workloadsDir);
    const result = await plan({ node: "local", to: "code" });
    expect(result.ok).toBe(true);
    expect(result.victims).toEqual(["chat-a"]);
    expect(result.replacements).toEqual(["code-b"]);
    expect(result.budget).toEqual({ memoryGiB: 24, source: "noderun" });
    expect(result.storeAppliesToNode).toBe(true);
    expect(result.servingNode).toBe("local");
    const after = snapshotTree(workloadsDir);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(join(tmp, "residency-state"))).toBe(false);
  });

  test("R2: empty `to` is rejected BAD_REQUEST", async () => {
    const err = await plan({ node: "local", to: "" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "BAD_REQUEST" });
  });

  test("R3: a Failed workload fails closed as UnknownState", async () => {
    seedRouterFixture();
    saveWorkload(
      runManifest("broken", { node: "local", phase: "Failed", expectedMemoryGiB: 1 }),
      workloadsDir,
    );
    const result = await plan({ node: "local", to: "code" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("UnknownState");
    expect(result.workloads).toEqual(["broken"]);
  });

  test("R4: an unmigrated store gates only the serving node", async () => {
    seedRouterFixture();
    mkdirSync(dirname(storePath), { recursive: true });
    new Database(storePath).close();

    const localPlan = await plan({ node: "local", to: "code" });
    expect(localPlan.ok).toBe(false);
    expect(localPlan.reason).toBe("StoreUnreadable");

    process.env["LLAMACTL_NODE_NAME"] = "cp";
    const remotePlan = await plan({ node: "local", to: "code" });
    expect(remotePlan.ok).toBe(true);
    expect(remotePlan.storeAppliesToNode).toBe(false);
    expect(remotePlan.servingNode).toBe("cp");
    expect(remotePlan.store).toMatchObject({ present: true, scope: "serving-process" });
    const remoteStore = remotePlan.store as { error?: unknown } | undefined;
    expect(typeof remoteStore?.error).toBe("string");

    Reflect.deleteProperty(process.env, "LLAMACTL_NODE_NAME");
    const anonymousPlan = await plan({ node: "local", to: "code" });
    expect(anonymousPlan.ok).toBe(true);
    expect(anonymousPlan.storeAppliesToNode).toBe(false);
    expect(anonymousPlan.servingNode).toBe(null);
  });

  test("R5: spec.residency.safetyMarginRatio sizes the computed budget", async () => {
    seedRouterFixtureResidency({ residency: { safetyMarginRatio: 0.5 } });
    const result = await plan({ node: "local", to: "code" });
    expect(result.budget?.source).toBe("computed");
    expect(result.budget?.memoryGiB).toBeCloseTo((totalmem() / 1024 ** 3) * 0.5, 6);
    expect(result.budget?.memoryGiB).toBeCloseTo(defaultNodeBudgetGiB(undefined) * (0.5 / 0.75), 6);
  });

  test("R6: residency without safetyMarginRatio keeps the default computed budget", async () => {
    seedRouterFixtureResidency({ residency: { idleEvictSeconds: 600 } });
    const result = await plan({ node: "local", to: "code" });
    expect(result.budget).toEqual({
      memoryGiB: defaultNodeBudgetGiB(undefined),
      source: "computed",
    });
  });

  test("R7: switchCooldownSeconds cannot refuse — the router supplies no lastSwitchAtMs", async () => {
    seedRouterFixtureResidency({
      residency: { switchCooldownSeconds: 3600 },
      budget: { memoryGiB: 24 },
    });
    const result = await plan({ node: "local", to: "code" });
    expect(result.ok).toBe(true);
    expect(result.victims).toEqual(["chat-a"]);
  });
});
