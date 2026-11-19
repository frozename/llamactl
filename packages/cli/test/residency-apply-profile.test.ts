// #284 (DF-11): `llamactl residency apply-profile` — RED tests pinning the CLI
// projection of the residencyApplyProfile mutation. At the pinned base the
// residency command knows only status/plan/force-unload, so every case fails
// by assertion: runResidency answers "Unknown residency subcommand:
// apply-profile" (and the cases additionally assert stderr never contains
// that text once the subcommand exists). The mutate path is router-backed —
// residencyApplyProfile.mutate forwards to router.createCaller({}) — and the
// new remote module is reached only through a guarded dynamic import whose
// exports are asserted `typeof === "function"`.
import type { NodeClient } from "@llamactl/remote";

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
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";

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
  refusal?: { reason: string; detail: string };
  inFlightOperationId?: string | null;
};

type FenceIdentity = { ownerId: string; incarnation: string };

type Fence = { ownerId: string; incarnation: string; fenceToken: number };

type StoreHandle = ResidencyOperationStore & ResidencyLifecycleStore;

let tmp = "";
let workloadsDir = "";
let storePath = "";
let savedEnv: Record<string, string | undefined> = {};
let stepCalls: [string, string][] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-apply-cli-"));
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
  resetGlobals();
  stepCalls = [];
});

afterEach(async () => {
  await resetStepsSeam();
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
    "residencyApplyProfile.mutate": (input) => applyProfileMutate(input),
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

type ApplyProfileCaller = {
  residencyApplyProfile: (input: Record<string, unknown>) => Promise<ApplyProfileResult>;
};

function residencyApplyProfileProc(): ApplyProfileCaller {
  const procs = (router as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  expect(Object.keys(procs)).toContain("residencyApplyProfile");
  return router.createCaller({}) as unknown as ApplyProfileCaller;
}

function applyProfileMutate(input: unknown): Promise<ApplyProfileResult> {
  return residencyApplyProfileProc().residencyApplyProfile(input as Record<string, unknown>);
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

async function applyProfileModule(): Promise<Record<string, unknown>> {
  return (await import(APPLY_PROFILE_MODULE_PATH).catch(() => ({}))) as Record<string, unknown>;
}

async function installStepsFake(): Promise<void> {
  const mod = await applyProfileModule();
  const set = mod["__setResidencyApplyProfileStepsForTests"];
  expect(typeof set).toBe("function");
  (set as (steps: ApplyProfileSteps | null) => void)(recordingSteps());
}

async function resetStepsSeam(): Promise<void> {
  const mod = await applyProfileModule();
  const reset = mod["__setResidencyApplyProfileStepsForTests"];
  if (typeof reset === "function") {
    (reset as (steps: ApplyProfileSteps | null) => void)(null);
  }
}

describe("llamactl residency apply-profile", () => {
  test("C1: apply-profile defaults to a dry run and prints the plan summary", async () => {
    // kills: the CLI defaulting to dryRun:false.
    seedRouterFixture();
    const { run } = await loadResidency();
    const rec = routerRecordingDeps();
    const before = snapshotTree(tmp);

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      run(["apply-profile", "--node", "local", "--to", "code", "--from", "chat"], rec.deps),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stderr).not.toContain("Unknown residency subcommand");
    expect(rec.calls).toEqual(["residencyApplyProfile.mutate"]);
    expect(rec.inputs).toStrictEqual([{ node: "local", to: "code", from: "chat", dryRun: true }]);
    expect(stdout).toContain("Mode:         dry-run (no starts, stops, loads or store writes)");
    expect(stdout).toContain("Switch:       chat -> code");
    expect(stdout).toContain("Outcome:      dry-run");
    const after = snapshotTree(tmp);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(join(tmp, "residency-state"))).toBe(false);
  });

  test("C2: --execute without --yes refuses before any mutate call", async () => {
    // kills: dropping the --yes gate.
    seedRouterFixture();
    const { run } = await loadResidency();
    const rec = routerRecordingDeps();

    const { result: code, stderr } = await withCapturedIo(() =>
      run(
        ["apply-profile", "--node", "local", "--to", "code", "--from", "chat", "--execute"],
        rec.deps,
      ),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("residency apply-profile: refusing --execute without --yes");
    expect(stderr).not.toContain("Unknown residency subcommand");
    expect(rec.calls).toEqual([]);
    expect(rec.inputs).toEqual([]);
  });

  test("C3: --execute --yes runs the mutation and prints the operation id", async () => {
    // kills: dropping operationId, or calling with dryRun:true.
    seedRouterFixture();
    await installStepsFake();
    const { run } = await loadResidency();
    const rec = routerRecordingDeps();

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      run(
        [
          "apply-profile",
          "--node",
          "local",
          "--to",
          "code",
          "--from",
          "chat",
          "--execute",
          "--yes",
          "--json",
        ],
        rec.deps,
      ),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stderr).not.toContain("Unknown residency subcommand");
    expect(rec.calls).toEqual(["residencyApplyProfile.mutate"]);
    expect(rec.inputs).toStrictEqual([
      { node: "local", to: "code", from: "chat", dryRun: false, confirm: true },
    ]);
    const parsed = JSON.parse(stdout) as {
      outcome?: string;
      from?: string | null;
      operationId?: string | null;
    };
    expect(parsed.outcome).toBe("stops-and-starts-ran");
    expect(parsed.from).toBe("chat");
    expect(typeof parsed.operationId).toBe("string");
    const opId = parsed.operationId!;
    const rec2 = withStore((store) => store.getOperation(opId));
    expect(rec2).not.toBeNull();
    expect(rec2?.phase).toBe("terminal");
    expect(rec2?.outcome).toBe("succeeded");
  });

  test("C4: a NodeBusy refusal round-trips through --json and text output", async () => {
    // kills: swallowing refusal details, or exiting 0 when !ok.
    seedRouterFixture();
    seedInflight();
    const { run } = await loadResidency();
    const direct = await residencyApplyProfileProc().residencyApplyProfile({
      node: "local",
      to: "code",
      from: "chat",
      dryRun: false,
      confirm: true,
    });

    const jsonRec = routerRecordingDeps();
    const json = await withCapturedIo(() =>
      run(
        [
          "apply-profile",
          "--node",
          "local",
          "--to",
          "code",
          "--from",
          "chat",
          "--execute",
          "--yes",
          "--json",
        ],
        jsonRec.deps,
      ),
    );
    expect(json.result).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual(direct);
    const parsed = JSON.parse(json.stdout) as {
      refusal?: { reason?: string };
      inFlightOperationId?: string | null;
    };
    expect(parsed.refusal?.reason).toBe("NodeBusy");
    expect(parsed.inFlightOperationId).toBe("op-inflight");

    const textRec = routerRecordingDeps();
    const text = await withCapturedIo(() =>
      run(
        [
          "apply-profile",
          "--node",
          "local",
          "--to",
          "code",
          "--from",
          "chat",
          "--execute",
          "--yes",
        ],
        textRec.deps,
      ),
    );
    expect(text.result).toBe(1);
    expect(text.stderr).toContain(
      "residency apply-profile: NodeBusy: an in-flight operation is already in progress",
    );
    expect(text.stderr).not.toContain("Unknown residency subcommand");
  });

  test("C5: a live controller lock surfaces ControllerActive on stderr", async () => {
    // kills: the CLI dropping refusal text.
    seedRouterFixture();
    writeFileSync(join(workloadsDir, ".controller.lock"), String(process.pid));
    const { run } = await loadResidency();
    const rec = routerRecordingDeps();

    const { result: code, stderr } = await withCapturedIo(() =>
      run(
        [
          "apply-profile",
          "--node",
          "local",
          "--to",
          "code",
          "--from",
          "chat",
          "--execute",
          "--yes",
        ],
        rec.deps,
      ),
    );

    expect(code).toBe(1);
    expect(stderr).toContain("residency apply-profile: ControllerActive:");
    expect(stderr).not.toContain("Unknown residency subcommand");
  });
});

function craftedApplyProfileDeps(result: unknown): {
  calls: string[];
  inputs: unknown[];
  deps: ResidencyDeps;
} {
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const client = recordingClient(calls, inputs, {
    "residencyApplyProfile.mutate": () => Promise.resolve(result),
  });
  return {
    calls,
    inputs,
    deps: { getNodeClientByName: () => client },
  };
}

describe("#520 apply-profile session detail", () => {
  test("C6: dry-run renders optional step detail for the bound victim only", async () => {
    // kills: dropping step.detail from the dry-run renderer.
    const { run } = await loadResidency();
    const rec = craftedApplyProfileDeps({
      ok: true,
      dryRun: true,
      outcome: "dry-run",
      node: "local",
      from: "chat",
      to: "code",
      deferred: [],
      steps: [
        { action: "fence", workload: "v-a", status: "planned", detail: "SessionsActive: s1" },
        { action: "fence", workload: "v-b", status: "planned" },
      ],
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      run(["apply-profile", "--node", "local", "--to", "code", "--from", "chat"], rec.deps),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(rec.calls).toEqual(["residencyApplyProfile.mutate"]);
    expect(stdout).toContain("v-a (planned; SessionsActive: s1)");
    expect(stdout).toContain("v-b (planned)\n");
  });

  test("C7: a failed step detail surfaces in the refusal/error text", async () => {
    // kills: printing an empty detail on a failed (non-refusal) result.
    const { run } = await loadResidency();
    const rec = craftedApplyProfileDeps({
      ok: false,
      dryRun: false,
      outcome: "failed",
      node: "local",
      from: "chat",
      to: "code",
      deferred: [],
      steps: [
        { action: "fence", workload: "v-a", status: "failed", detail: "SessionsActive: s1" },
        { action: "drain", workload: "v-a", status: "not-run" },
      ],
    });

    const { result: code, stderr } = await withCapturedIo(() =>
      run(
        [
          "apply-profile",
          "--node",
          "local",
          "--to",
          "code",
          "--from",
          "chat",
          "--execute",
          "--yes",
        ],
        rec.deps,
      ),
    );

    expect(code).toBe(1);
    expect(rec.calls).toEqual(["residencyApplyProfile.mutate"]);
    expect(stderr).toContain("residency apply-profile: failed: fence v-a: SessionsActive: s1");
    expect(stderr).not.toMatch(/failed: \n/);
  });

  test("C8: refusal text takes precedence over a failed step detail", async () => {
    // guard: a refusal result still reports the refusal, not the step detail.
    const { run } = await loadResidency();
    const rec = craftedApplyProfileDeps({
      ok: false,
      dryRun: false,
      outcome: "failed",
      node: "local",
      from: "chat",
      to: "code",
      deferred: [],
      refusal: { reason: "ControllerActive", detail: "x" },
      steps: [{ action: "fence", workload: "v-a", status: "failed", detail: "SessionsActive: s1" }],
    });

    const { result: code, stderr } = await withCapturedIo(() =>
      run(
        [
          "apply-profile",
          "--node",
          "local",
          "--to",
          "code",
          "--from",
          "chat",
          "--execute",
          "--yes",
        ],
        rec.deps,
      ),
    );

    expect(code).toBe(1);
    expect(rec.calls).toEqual(["residencyApplyProfile.mutate"]);
    expect(stderr).toContain("residency apply-profile: ControllerActive: x");
    expect(stderr).not.toContain("Unknown residency subcommand");
  });
});
