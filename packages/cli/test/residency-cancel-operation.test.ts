// #284 (DF-11): `llamactl residency cancel-operation` — RED tests pinning the
// CLI projection of the residencyCancelOperation mutation. At the pinned base
// the residency command knows only status/plan/apply-profile/force-unload, so
// every case fails by assertion: the procedure probe fails first, and
// runResidency would answer "Unknown residency subcommand: cancel-operation"
// (the cases additionally assert stderr never contains that text once the
// subcommand exists). The mutate path is router-backed —
// residencyCancelOperation.mutate forwards to router.createCaller({}) — and
// the apply side is reached through the same in-proc caller so the blocking
// steps seam and the in-flight registry are shared with the cancel.
import type { NodeClient } from "@llamactl/remote";

import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { noderunStore, router, workloadSchema, workloadStore } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
} from "../../remote/src/residency/store.js";
import * as workloadMod from "../src/commands/workload.js";
import { resetGlobals } from "../src/dispatcher.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const ROUTER_ENV_KEYS = [
  "LLAMACTL_WORKLOADS_DIR",
  "LLAMACTL_CONFIG",
  "DEV_STORAGE",
  "LLAMACTL_RESIDENCY_STORE",
  "LLAMACTL_NODE_NAME",
] as const;

// Non-literal specifier: tsc cannot resolve it, so the missing module at the
// pinned base surfaces as a caught import rejection (asserted below), never a
// compile error.
const APPLY_PROFILE_MODULE_PATH = "../../remote/src/residency/apply-profile.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ResidencyDeps = {
  getNodeClientByName: (node: string) => NodeClient;
};

type ResidencyRunner = (args: string[], deps?: ResidencyDeps) => Promise<number>;

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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-cancel-cli-"));
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
  resetGlobals();
  stepCalls = [];
});

afterEach(async () => {
  await resetStepsSeam();
  setResidencyLeaseRegistry(null);
  setSystemTime();
  for (const key of ROUTER_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  workloadMod.__resetWorkloadTestSeams();
  resetGlobals();
  rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

async function loadResidency(): Promise<{ run: ResidencyRunner }> {
  const mod = (await import("../src/commands/residency.js").catch(() => ({}))) as Record<
    string,
    unknown
  >;
  expect(typeof mod["runResidency"]).toBe("function");
  return { run: mod["runResidency"] as ResidencyRunner };
}

function runManifest(
  name: string,
  options: {
    profiles?: string;
    phase?: "Pending" | "Running" | "Failed" | "Stopped";
    expectedMemoryGiB?: number;
  } = {},
): workloadSchema.ModelRun {
  const annotations =
    options.profiles === undefined
      ? undefined
      : { ["llamactl.io/residency-profiles"]: options.profiles };
  return workloadSchema.ModelRunSchema.parse({
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
  workloadStore.saveWorkload(
    runManifest("chat-a", { profiles: "chat", phase: "Running", expectedMemoryGiB: 10 }),
    workloadsDir,
  );
  workloadStore.saveWorkload(
    runManifest("code-b", { profiles: "code", phase: "Stopped", expectedMemoryGiB: 12 }),
    workloadsDir,
  );
  noderunStore.saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "local", labels: {} },
      spec: { node: "local", budget: { memoryGiB: 24 }, infra: [] },
    },
    workloadsDir,
  );
}

function withStore<T>(fn: (store: StoreHandle) => T): T {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function withCapturedIo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stderrOrig = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };

  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  return fn()
    .then((result) => ({ result, stdout, stderr }))
    .finally(() => {
      process.stdout.write = stdoutOrig;
      process.stderr.write = stderrOrig;
    });
}

function leafHandler(
  calls: string[],
  inputs: unknown[],
  handlers: Record<string, (input: unknown) => Promise<unknown>>,
  proc: string,
  method: string,
): (input: unknown) => Promise<unknown> {
  return async (input: unknown): Promise<unknown> => {
    calls.push(`${proc}.${method}`);
    inputs.push(input);
    const handler = handlers[`${proc}.${method}`];
    if (handler === undefined) {
      throw new Error(`unexpected ${proc}.${method}`);
    }
    return await handler(input);
  };
}

function procedureNamespace(
  calls: string[],
  inputs: unknown[],
  handlers: Record<string, (input: unknown) => Promise<unknown>>,
  proc: string,
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(_target, prop): unknown {
      if (typeof prop !== "string") return undefined;
      return leafHandler(calls, inputs, handlers, proc, prop);
    },
  });
}

function recordingClient(
  calls: string[],
  inputs: unknown[],
  handlers: Record<string, (input: unknown) => Promise<unknown>>,
): NodeClient {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(_target, prop): unknown {
      if (typeof prop !== "string") return undefined;
      return procedureNamespace(calls, inputs, handlers, prop);
    },
  }) as unknown as NodeClient;
}

interface ResidencyRecording {
  calls: string[];
  inputs: unknown[];
  nodes: string[];
  deps: ResidencyDeps;
}

function routerRecordingDeps(): ResidencyRecording {
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const nodes: string[] = [];
  const client = recordingClient(calls, inputs, {
    "residencyCancelOperation.mutate": (input) => cancelOperationMutate(input),
  });
  return {
    calls,
    inputs,
    nodes,
    deps: {
      getNodeClientByName: (node: string): NodeClient => {
        nodes.push(node);
        return client;
      },
    },
  };
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

function routerProcedures(): Record<string, unknown> {
  return (router as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures;
}

function residencyApplyProfileProc(): ResidencyCaller {
  expect(Object.keys(routerProcedures())).toContain("residencyApplyProfile");
  return router.createCaller({}) as unknown as ResidencyCaller;
}

function residencyCancelOperationProc(): ResidencyCaller {
  expect(Object.keys(routerProcedures())).toContain("residencyCancelOperation");
  return router.createCaller({}) as unknown as ResidencyCaller;
}

function cancelOperationMutate(input: unknown): Promise<CancelOperationResult> {
  return residencyCancelOperationProc().residencyCancelOperation(
    input as { operationId: string; confirm?: boolean },
  );
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
// immediately.
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

async function applyProfileModule(): Promise<Record<string, unknown>> {
  return (await import(APPLY_PROFILE_MODULE_PATH).catch(() => ({}))) as Record<string, unknown>;
}

async function installSteps(steps: ApplyProfileSteps): Promise<void> {
  const mod = await applyProfileModule();
  const set = mod["__setResidencyApplyProfileStepsForTests"];
  expect(typeof set).toBe("function");
  (set as (steps: ApplyProfileSteps | null) => void)(steps);
}

async function resetStepsSeam(): Promise<void> {
  const mod = await applyProfileModule();
  const reset = mod["__setResidencyApplyProfileStepsForTests"];
  if (typeof reset === "function") {
    (reset as (steps: ApplyProfileSteps | null) => void)(null);
  }
}

describe("llamactl residency cancel-operation", () => {
  test("K1: cancel-operation without --yes refuses before any mutate call", async () => {
    // kills: dropping the --yes gate.
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyCancelOperation");
    const { run } = await loadResidency();
    const rec = routerRecordingDeps();

    const { result: code, stderr } = await withCapturedIo(() =>
      run(["cancel-operation", "op-x", "--node", "local"], rec.deps),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("residency cancel-operation: refusing without --yes");
    expect(stderr).not.toContain("Unknown residency subcommand");
    expect(rec.calls).toEqual([]);
    expect(rec.inputs).toEqual([]);
  });

  test("K2: an unknown operation id round-trips not-found through --json", async () => {
    // kills: not forwarding the id; exit 0 when !ok.
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyCancelOperation");
    const { run } = await loadResidency();
    const rec = routerRecordingDeps();

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      run(["cancel-operation", "op-missing", "--node", "local", "--yes", "--json"], rec.deps),
    );

    expect(code).toBe(1);
    expect(rec.calls).toEqual(["residencyCancelOperation.mutate"]);
    expect(rec.inputs).toStrictEqual([{ operationId: "op-missing", confirm: true }]);
    expect(stderr).toBe("");
    expect(stdout).toContain("not-found");
    const parsed = JSON.parse(stdout) as { outcome?: string; operationId?: string | null };
    expect(parsed.outcome).toBe("not-found");
    expect(parsed.operationId).toBe("op-missing");
  });

  test("K3: --yes cancels an in-flight switch through the real router and reports cancel-requested", async () => {
    // kills: the CLI calling another procedure or dropping confirm:true;
    // claiming the switch is already cancelled.
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyCancelOperation");
    seedRouterFixture();
    const { run } = await loadResidency();
    const rec = routerRecordingDeps();
    const caller = residencyApplyProfileProc();
    const blocking = blockingSteps("stop");
    await installSteps(blocking.steps);

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

      const {
        result: code,
        stdout,
        stderr,
      } = await withCapturedIo(() =>
        run(["cancel-operation", id, "--node", "local", "--yes"], rec.deps),
      );

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(rec.calls).toEqual(["residencyCancelOperation.mutate"]);
      expect(rec.inputs).toStrictEqual([{ operationId: id, confirm: true }]);
      expect(stdout).toContain(
        `Cancel requested for operation ${id}: abort delivered; the profile switch stops before its next step boundary`,
      );
      expect(stdout).not.toContain("Cancelled operation");
    } finally {
      blocking.release.resolve(undefined);
      await pending?.catch(() => undefined);
    }

    const result = await pending;
    expect(result.outcome).toBe("cancelled");
    expect(stepCalls).toEqual([["stop", "chat-a"]]);
  });

  test("K4: an already-terminal operation prints the recorded outcome on stderr", async () => {
    // kills: swallowing refusal details.
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyCancelOperation");
    seedRouterFixture();
    const { run } = await loadResidency();
    const rec = routerRecordingDeps();
    await installSteps(recordingSteps());
    const applied = await residencyApplyProfileProc().residencyApplyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });
    expect(applied.outcome).toBe("stops-and-starts-ran");
    const id = applied.operationId ?? "";
    expect(id).toMatch(UUID_RE);

    const { result: code, stderr } = await withCapturedIo(() =>
      run(["cancel-operation", id, "--node", "local", "--yes"], rec.deps),
    );

    expect(code).toBe(1);
    expect(stderr).toContain(
      `residency cancel-operation: already-terminal: operation ${id} is already terminal (outcome succeeded)`,
    );
  });

  test("K5: usage documents cancel-operation and its process-local limit", async () => {
    // kills: omitting the process-local limitation.
    const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs)).toContain("residencyCancelOperation");
    const { run } = await loadResidency();

    const { result: code, stdout, stderr } = await withCapturedIo(() => run(["--help"]));

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("cancel-operation <operationId> --yes");
    expect(stdout).toContain("cannot be cancelled from another CLI invocation");
  });
});
