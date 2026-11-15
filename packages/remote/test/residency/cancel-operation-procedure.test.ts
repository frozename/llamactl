/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects/resolves matchers are typed as void. */
// #284 (DF-11) residencyCancelOperation — RED tests for the operator cancel of
// an in-flight profile switch, surfaced through tRPC. At the pinned base the
// router has no residencyCancelOperation procedure and apply-profile.ts does
// not yet pass an AbortSignal into the executor or keep an in-process registry
// of running switches, so every case fails BY ASSERTION — never by import,
// type or NOT_FOUND: the procedure is probed through _def before any call and
// the new export is reached only through a namespace import + cast.
//
// The cancel is process-local: it aborts the AbortController registered under
// the operationId by the wet apply running in THIS serving process. A switch
// begun by another CLI invocation shares the node-local store but not the
// registry, so its row reports not-owned-by-this-process; a terminal row
// reports already-terminal with the recorded outcome; an absent row reports
// not-found without creating the store.
import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as applyProfileNs from "../../src/residency/apply-profile.js";
import {
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { existsSync, mkdtempSync, rmSync } from "../../src/safe-fs.js";
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

type CancelOperationResult = {
  ok: boolean;
  outcome: string;
  operationId?: string | null;
  recordedOutcome?: string | null;
  detail?: string;
};

type ApplyProfileModule = {
  __setResidencyApplyProfileStepsForTests: (steps: ApplyProfileSteps | null) => void;
  __residencyInFlightSwitchIdsForTests?: () => string[];
};

type FenceIdentity = { ownerId: string; incarnation: string };

type Fence = { ownerId: string; incarnation: string; fenceToken: number };

type StoreHandle = ResidencyOperationStore & ResidencyLifecycleStore;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

let tmp = "";
let workloadsDir = "";
let storePath = "";
let savedEnv: Record<string, string | undefined> = {};
let stepCalls: [string, string][] = [];

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

// The blocked action records its call, resolves `entered`, then waits on
// `release` before reporting ok; the other action records and reports ok
// immediately. Pair with a try/finally that resolves release and awaits the
// apply so the temp dir is never removed under a running switch.
function blockingSteps(blockOn: "stop" | "start"): {
  steps: ApplyProfileSteps;
  entered: Promise<undefined>;
  release: Deferred<undefined>;
} {
  const entered = deferred<undefined>();
  const release = deferred<undefined>();
  const gate = (action: "stop" | "start", workload: string): Promise<StepOutcome> => {
    stepCalls.push([action, workload]);
    if (action !== blockOn) {
      return Promise.resolve({ ok: true });
    }
    entered.resolve(undefined);
    return release.promise.then((): StepOutcome => ({ ok: true }));
  };
  return {
    steps: {
      stop: (workload) => gate("stop", workload),
      start: (workload) => gate("start", workload),
    },
    entered: entered.promise,
    release,
  };
}

function applyProfileModule(): ApplyProfileModule {
  return applyProfileNs;
}

function installSteps(steps: ApplyProfileSteps): void {
  const mod = applyProfileModule();
  expect(typeof mod.__setResidencyApplyProfileStepsForTests).toBe("function");
  mod.__setResidencyApplyProfileStepsForTests(steps);
}

function resetStepsSeam(): void {
  const reset = applyProfileModule().__setResidencyApplyProfileStepsForTests;
  if (typeof reset === "function") {
    reset(null);
  }
}

type ResidencyCaller = {
  residencyApplyProfile: (input: {
    node: string;
    to: string;
    from?: string;
    dryRun?: boolean;
    confirm?: boolean;
  }) => Promise<ApplyProfileResult>;
  residencyCancelOperation: (input: {
    operationId: string;
    confirm?: boolean;
  }) => Promise<CancelOperationResult>;
};

function residencyCaller(): ResidencyCaller {
  return router.createCaller({}) as unknown as ResidencyCaller;
}

describe("residencyCancelOperation procedure", () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-cancel-"));
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

  afterEach(() => {
    resetStepsSeam();
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

  test("X1: cancel aborts an in-flight switch at the next step boundary and records cancelled", async () => {
    // kills: runWet not passing `signal`; cancel not calling controller.abort();
    // registering under a different id than the operationId runWet records;
    // not deleting the registry entry in finally.
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyCancelOperation");
    seedRouterFixture();
    const caller = residencyCaller();
    const blocking = blockingSteps("stop");
    installSteps(blocking.steps);

    let pending: Promise<ApplyProfileResult> | undefined;
    let id = "";
    try {
      pending = caller.residencyApplyProfile({
        node: "local",
        to: "code",
        from: "chat",
        dryRun: false,
        confirm: true,
      });
      await blocking.entered;

      const dry = await caller.residencyApplyProfile({
        node: "local",
        to: "code",
        from: "chat",
      });
      expect(dry.outcome).toBe("refused");
      expect(dry.refusal?.reason).toBe("NodeBusy");
      const ops = withStore((store) => store.listNonterminal());
      expect(ops).toHaveLength(1);
      id = ops[0]?.operationId ?? "";
      expect(id).toMatch(UUID_RE);
      expect(dry.inFlightOperationId).toMatch(UUID_RE);
      expect(dry.inFlightOperationId).toBe(id);

      const cancel = await caller.residencyCancelOperation({
        operationId: id,
        confirm: true,
      });
      expect(cancel).toEqual({
        ok: true,
        outcome: "cancel-requested",
        operationId: id,
        detail: `abort delivered to profile switch ${id}; it stops before its next step boundary (a step already running completes). The recorded outcome is on the operation: see residency status or the apply-profile result`,
      });
    } finally {
      blocking.release.resolve(undefined);
      await pending?.catch(() => undefined);
    }

    const result = await pending;
    expect(result.outcome).toBe("cancelled");
    expect(result.ok).toBe(false);
    expect(result.operationId).toBe(id);
    expect(result.steps).toEqual([
      { action: "stop", workload: "chat-a", status: "ok" },
      { action: "start", workload: "code-b", status: "not-run" },
    ]);
    expect(stepCalls).toEqual([["stop", "chat-a"]]);

    const rec = withStore((store) => store.getOperation(id));
    expect(rec?.phase).toBe("terminal");
    expect(rec?.outcome).toBe("cancelled");
    expect(rec?.detail).toBe("cancelled before start code-b");
    expect(withStore((store) => store.listNonterminal())).toEqual([]);

    const inFlightIds = applyProfileModule().__residencyInFlightSwitchIdsForTests;
    expect(typeof inFlightIds).toBe("function");
    if (typeof inFlightIds === "function") {
      expect(inFlightIds()).toEqual([]);
    }
  });

  test("X2: an unknown operation id reports not-found without creating the store", async () => {
    // kills: reporting cancel-requested for an unknown id; creating the store
    // on lookup.
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyCancelOperation");
    const caller = residencyCaller();

    const result = await caller.residencyCancelOperation({
      operationId: "op-missing",
      confirm: true,
    });

    expect(result).toEqual({
      ok: false,
      outcome: "not-found",
      operationId: "op-missing",
      detail: "no residency operation op-missing in the node-local store",
    });
    expect("recordedOutcome" in result).toBe(false);
    expect(existsSync(storePath)).toBe(false);
  });

  test("X3: a terminal operation reports already-terminal with the recorded outcome", async () => {
    // kills: answering cancel-requested for a finished op.
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyCancelOperation");
    seedRouterFixture();
    const caller = residencyCaller();
    installSteps(recordingSteps());

    const applied = await caller.residencyApplyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });
    expect(applied.outcome).toBe("stops-and-starts-ran");
    const id = applied.operationId ?? "";
    expect(id).toMatch(UUID_RE);

    const cancel = await caller.residencyCancelOperation({
      operationId: id,
      confirm: true,
    });

    expect(cancel).toEqual({
      ok: false,
      outcome: "already-terminal",
      operationId: id,
      recordedOutcome: "succeeded",
      detail: `operation ${id} is already terminal (outcome succeeded)`,
    });
  });

  test("X4: a foreign in-flight row reports not-owned-by-this-process untouched", async () => {
    // kills: finishing or claiming a foreign row; answering cancel-requested.
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyCancelOperation");
    seedInflight();
    const caller = residencyCaller();

    const result = await caller.residencyCancelOperation({
      operationId: "op-inflight",
      confirm: true,
    });

    expect(result).toEqual({
      ok: false,
      outcome: "not-owned-by-this-process",
      operationId: "op-inflight",
      detail:
        "operation op-inflight is in flight but not owned by this serving process; cancel reaches only profile switches running in the process that serves this request (an agent serve process or one MCP server), so a switch run in-process by another CLI invocation cannot be cancelled here",
    });
    expect("recordedOutcome" in result).toBe(false);
    const rec = withStore((store) => store.getOperation("op-inflight"));
    expect(rec?.phase).toBe("pending");
    expect(rec?.outcome).toBeNull();
  });

  test("X5: confirm: true is required — missing or false confirm rejects before any store", async () => {
    // kills: confirm: z.boolean() instead of z.literal(true).
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyCancelOperation");
    const caller = residencyCaller();

    await expect(caller.residencyCancelOperation({ operationId: "op-missing" })).rejects.toThrow();
    await expect(
      caller.residencyCancelOperation({ operationId: "op-missing", confirm: false }),
    ).rejects.toThrow();
    expect(existsSync(storePath)).toBe(false);
  });

  test("X6: an abort during the final step does not rewrite the recorded outcome", async () => {
    // kills: naming the in-registry outcome "cancelled", or forcing the store
    // to record cancelled for a step already running.
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyCancelOperation");
    seedRouterFixture();
    const caller = residencyCaller();
    const blocking = blockingSteps("start");
    installSteps(blocking.steps);

    let pending: Promise<ApplyProfileResult> | undefined;
    let id = "";
    try {
      pending = caller.residencyApplyProfile({
        node: "local",
        to: "code",
        from: "chat",
        dryRun: false,
        confirm: true,
      });
      await blocking.entered;
      const ops = withStore((store) => store.listNonterminal());
      expect(ops).toHaveLength(1);
      id = ops[0]?.operationId ?? "";
      expect(id).toMatch(UUID_RE);

      const cancel = await caller.residencyCancelOperation({
        operationId: id,
        confirm: true,
      });
      expect(cancel).toEqual({
        ok: true,
        outcome: "cancel-requested",
        operationId: id,
        detail: `abort delivered to profile switch ${id}; it stops before its next step boundary (a step already running completes). The recorded outcome is on the operation: see residency status or the apply-profile result`,
      });
    } finally {
      blocking.release.resolve(undefined);
      await pending?.catch(() => undefined);
    }

    const result = await pending;
    expect(result.outcome).toBe("stops-and-starts-ran");
    expect(result.ok).toBe(true);
    expect(result.operationId).toBe(id);
    const rec = withStore((store) => store.getOperation(id));
    expect(rec?.phase).toBe("terminal");
    expect(rec?.outcome).toBe("succeeded");

    const second = await caller.residencyCancelOperation({
      operationId: id,
      confirm: true,
    });
    expect(second).toEqual({
      ok: false,
      outcome: "already-terminal",
      operationId: id,
      recordedOutcome: "succeeded",
      detail: `operation ${id} is already terminal (outcome succeeded)`,
    });
  });
});
