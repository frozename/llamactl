import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

/**
 * #517 — RED tests for the direct ModelRun lifecycle slice: serverStart
 * and serverStop must drive residency_states rows through the same
 * fenced walks the ModelHost direct paths and the profile-switch
 * executor use (pre-walk to loading / unloading, dep, post-walk to
 * ready|failed / downloaded|failed), gated on the store file existing,
 * refuse a start while a profile switch is in flight, reconcile
 * proven-down same-group peers of either workload kind, never record a
 * stop while a switch holds the fence, and bypass the whole wrapper
 * inside the switch's own scope. Every ModelRun target names a missing
 * .gguf, so startServer returns `Model file not found` before any
 * spawn — the lifecycle row is the only thing under test. At base the
 * router's serverStart/serverStop never touch the residency store, so
 * every case fails BY ASSERTION on the rows, fence, result text or
 * stderr — never by import, type or exit code.
 */
import { env as coreEnv, server } from "@llamactl/core";
import { saveConfig } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../src/residency/apply-profile.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
  type ResidencyStateRecord,
} from "../../src/residency/store.js";
import { router } from "../../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { parseModelHost, saveModelHost } from "../../src/workload/modelhost-store.js";
import { saveNodeRun } from "../../src/workload/noderun-store.js";
import { ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

const GROUP = "z13-large-gpu";
const OTHER_GROUP = "m4-other";
const GROUP_LABEL = "llamactl.io/residency-group";
const PROFILES_ANNOTATION = "llamactl.io/residency-profiles";
const NOW = 1_000_000_000;

type Store = ResidencyOperationStore & ResidencyLifecycleStore;
type Fence = { ownerId: string; incarnation: string; fenceToken: number };
type SeedRow = { model: string; target: ResidencyState; group?: string };
type RunStartResult = {
  ok: boolean;
  pid: number | null;
  endpoint: string;
  advertisedEndpoint: string;
  tunedProfile: string | null;
  retried: boolean;
  error?: string;
};
type RunStopResult = { stopped: boolean; pid: number | null; killed: boolean };
type HostResult = { ok: boolean; pid: number | null; error?: string };
type SwitchScopeRunner = (fn: () => Promise<unknown>) => Promise<unknown>;

const originalEnv = { ...process.env };
let root = "";
let workloadsDir = "";
let runtimeDir = "";
let modelsDir = "";
let fakeBinary = "";

const storePath = (): string => defaultResidencyStorePath();

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

// Walks each row along legal edges under a fence claimed by the
// apply-profile owner — the same owner the production lifecycle wrapper
// claims under — passing the group only on the 'loading' hop, the same
// rule the lifecycle walks use. `switchOp` leaves a nonterminal
// profile-switch:local operation row behind, the in-flight marker the
// direct paths must respect.
function seed(rows: readonly SeedRow[], opts?: { switchOp?: boolean }): Fence {
  const store = openResidencyOperationStore({ path: storePath() });
  try {
    const fence = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    });
    for (const row of rows) {
      for (const to of seedPathTo(row.target)) {
        const result = store.transitionResidencyState({
          fenceToken: fence.fenceToken,
          model: row.model,
          ...(to === "loading" && row.group !== undefined ? { group: row.group } : {}),
          to,
          expectedVersion: store.getResidencyState(row.model)?.version ?? 0,
          nowMs: NOW,
        });
        expect(result.ok).toBe(true);
      }
    }
    if (opts?.switchOp === true) {
      const begun = store.beginOperation({
        fenceToken: fence.fenceToken,
        operationId: "op-seed",
        model: "profile-switch:local",
        targetState: "x",
        desiredRevision: 1,
        reservationGiB: 0,
        nowMs: NOW,
      });
      expect(begun.ok).toBe(true);
    }
    return fence;
  } finally {
    store.close();
  }
}

function withStore<T>(fn: (store: Store) => T): T {
  const store = openResidencyOperationStore({ path: storePath() });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function readState(model: string): ResidencyStateRecord | null {
  return withStore((store) => store.getResidencyState(model));
}

function readFence(): Fence | null {
  return withStore((store) => store.currentFence());
}

function bindRefusal(name: string): string {
  return `refusing to bind ModelHost ${name} to 0.0.0.0 without \`allowExternalBind: true\` in the workload spec`;
}

function writeRun(name: string, group: string): void {
  saveWorkload(
    ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: {
        name,
        labels: { [GROUP_LABEL]: group },
      },
      spec: {
        node: "local",
        enabled: true,
        target: { kind: "rel", value: `${name}/missing.gguf` },
      },
    }),
    workloadsDir,
  );
}

function writeProfileRun(
  name: string,
  profiles: string,
  phase: "Running" | "Stopped",
  memoryGiB: number,
): void {
  saveWorkload(
    ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: {
        name,
        labels: { [GROUP_LABEL]: GROUP },
        annotations: { [PROFILES_ANNOTATION]: profiles },
      },
      spec: {
        node: "local",
        enabled: true,
        target: { kind: "rel", value: `${name}/missing.gguf` },
        resources: { expectedMemoryGiB: memoryGiB },
      },
      status: { phase, lastTransitionTime: "2026-01-01T00:00:00.000Z" },
    }),
    workloadsDir,
  );
}

function writeHost(name: string, group: string, port: number): void {
  saveModelHost(
    parseModelHost(`
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: ${name}
  labels:
    llamactl.io/residency-group: ${group}
spec:
  engine: omlx
  node: local
  enabled: true
  binary: ${fakeBinary}
  endpoint:
    host: 0.0.0.0
    port: ${String(port)}
  hostedModels:
    - rel: ${name}.gguf
`),
    workloadsDir,
  );
}

// serverStart is a subscription: collect the stream and take the done
// event's result (the last one wins if a wrapper ever emits its own).
async function startRun(
  name: string,
  extra?: { endpoint?: { host?: string; port?: number } },
): Promise<RunStartResult> {
  const stream = await router
    .createCaller({})
    .serverStart({ workload: name, target: `${name}/missing.gguf`, ...extra });
  let result: RunStartResult | undefined;
  for await (const event of stream) {
    const done = event as { type?: string; result?: RunStartResult } | null;
    if (done?.type === "done" && done.result !== undefined) {
      result = done.result;
    }
  }
  if (result === undefined) {
    throw new Error(`serverStart(${name}) stream ended without a done event`);
  }
  return result;
}

function stopRun(name: string): Promise<RunStopResult> {
  return router.createCaller({}).serverStop({ workload: name });
}

// modelHostStart is a subscription like serverStart; same done-event rule.
async function startHost(name: string): Promise<HostResult> {
  const stream = await router.createCaller({}).modelHostStart({ workload: name });
  let result: HostResult | undefined;
  for await (const event of stream) {
    const done = event as { type?: string; result?: HostResult } | null;
    if (done?.type === "done" && done.result !== undefined) {
      result = done.result;
    }
  }
  if (result === undefined) {
    throw new Error(`modelHostStart(${name}) stream ended without a done event`);
  }
  return result;
}

// A chat -> code wet switch on the serving node: chat-x Running, code-y
// Stopped in one exclusive group, under a 24 GiB NodeRun budget. code-y's
// target is a missing .gguf, so the switch's own start step fails with the
// model-file error whenever it reaches the engine.
async function wetSwitchChatToCode(): Promise<{
  operationId?: string | null;
  steps: { action: string; workload: string; status: string; detail?: string | null }[];
}> {
  writeProfileRun("chat-x", "chat", "Running", 10);
  writeProfileRun("code-y", "code", "Stopped", 12);
  saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "local", labels: {} },
      spec: { node: "local", budget: { memoryGiB: 24 }, infra: [] },
    },
    workloadsDir,
  );
  return await router.createCaller({}).residencyApplyProfile({
    node: "local",
    to: "code",
    from: "chat",
    dryRun: false,
    confirm: true,
  });
}

// A loopback port nothing listens on: bind an ephemeral port, then release
// it. Any HTTP hop to it is refused locally; nothing off this host is dialled.
function closedLoopbackPort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket): void {
        socket.end();
      },
    },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += chunk.toString();
    return true;
  };
  return {
    text: () => captured,
    restore: (): void => {
      process.stderr.write = original;
    },
  };
}

// Makes every residency_states write abort, standing in for a store that
// cannot record (disk full, a corrupt page) while the fence stays claimable.
function blockResidencyWrites(): void {
  const db = new Database(storePath());
  try {
    db.run(
      "CREATE TRIGGER block_residency_update BEFORE UPDATE ON residency_states BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    db.run(
      "CREATE TRIGGER block_residency_insert BEFORE INSERT ON residency_states BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
  } finally {
    db.close();
  }
}

// Records this test process as the ModelRun's llama-server pid: alive, so
// readServerPid returns it, but not a llama-server, so stopServer's identity
// check reads unknown and refuses to signal it.
function writePidFile(name: string): void {
  const pidDir = join(runtimeDir, "workloads", name);
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(join(pidDir, "llama-server.pid"), `${String(process.pid)}\n`);
  expect(server.readServerPid({ name })).toBe(process.pid);
}

async function directLifecycleModule(): Promise<Record<string, unknown>> {
  return await import("../../src/residency/direct-lifecycle.js");
}

beforeEach(() => {
  // Null registries keep fenceWorkloadStop on its pass-through path: these
  // cases pin the residency lifecycle rows, not lease/session fencing, and
  // a registry leaked by another file must not refuse the stop.
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  root = mkdtempSync(join(tmpdir(), "llamactl-direct-modelrun-"));
  workloadsDir = join(root, "workloads");
  runtimeDir = join(root, "runtime");
  modelsDir = join(root, "models");
  mkdirSync(workloadsDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  // omlx validateSpec requires the binary to exist; the bind refusal fires
  // before any spawn, so an empty file is enough.
  fakeBinary = join(root, "fake-omlx");
  writeFileSync(fakeBinary, "");
  Object.assign(process.env, {
    DEV_STORAGE: join(root, "dev"),
    LLAMACTL_RESIDENCY_STORE: join(root, "residency", "operations.sqlite"),
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_MODELS: modelsDir,
    LLAMACTL_CONFIG: join(root, "config-missing"),
    LLAMACTL_NODE_NAME: "local",
  });
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, originalEnv);
  if (root !== "") {
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("serverStart/serverStop direct residency lifecycle", () => {
  test("MR1: no store file leaves the model-file error untouched; a seeded store records the failed row", async () => {
    // kills: serverStart not wrapped in runDirectResidencyStart; dropping
    // the store-existence gate (the first start must not create the store).
    writeRun("run-a", GROUP);

    const first = await startRun("run-a");
    expect(first.ok).toBe(false);
    expect(first.pid).toBeNull();
    expect(first.error ?? "").toMatch(/^Model file not found:/);
    expect(existsSync(storePath())).toBe(false);

    seed([]);

    const second = await startRun("run-a");
    expect(second.ok).toBe(false);
    expect(second.error ?? "").toMatch(/^Model file not found:/);
    expect(readState("run-a")).toMatchObject({
      state: "failed",
      group: GROUP,
      version: 3,
    });
  });

  test("MR2: a loading exclusive-group peer refuses the start with the full StartServerResult shape", async () => {
    // kills: not wrapping serverStart; a refusal that drops the
    // StartServerResult shape (endpoint/advertisedEndpoint/tunedProfile).
    writeRun("run-a", GROUP);
    writeRun("run-b", GROUP);
    seed([{ model: "run-b", target: "loading", group: GROUP }]);

    const result = await startRun("run-a");

    expect(result.ok).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.error).toBe(
      "residency lifecycle refused run-a downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by run-b in state loading",
    );
    expect(result.error ?? "").not.toContain("Model file not found");
    expect(typeof result.endpoint).toBe("string");
    expect(typeof result.advertisedEndpoint).toBe("string");
    expect(result.tunedProfile).toBeNull();
    expect(readState("run-b")?.state).toBe("loading");
    expect(readState("run-a")?.state).toBe("downloaded");
  });

  test("MR3: an in-flight profile switch refuses the start without claiming the fence", async () => {
    // kills: claiming the fence over an external switch.
    writeRun("run-a", GROUP);
    const fence = seed([], { switchOp: true });

    const result = await startRun("run-a");

    expect(result.ok).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.error).toBe(
      "residency lifecycle refused run-a: profile switch in flight on this node; retry after it settles",
    );
    expect(readState("run-a")).toBeNull();
    expect(readFence()).toEqual(fence);
  });

  test("MR4: serverStop walks a ready row down to downloaded and returns the dep result", async () => {
    // kills: serverStop not wrapped; returning the dep wrapper.
    writeRun("run-a", GROUP);
    seed([{ model: "run-a", target: "ready", group: GROUP }]);
    const seededVersion = readState("run-a")?.version ?? 0;

    const result = await stopRun("run-a");

    expect(result).toEqual({ stopped: true, pid: null, killed: false });
    expect(readState("run-a")).toMatchObject({
      state: "downloaded",
      version: seededVersion + 3,
    });
  });

  test("MR5: a stop during an in-flight profile switch runs but records nothing", async () => {
    // kills: blocking or recording a stop during an external switch.
    writeRun("run-a", GROUP);
    const fence = seed([{ model: "run-a", target: "ready", group: GROUP }], {
      switchOp: true,
    });
    const seededVersion = readState("run-a")?.version ?? 0;
    const stderr = captureStderr();
    try {
      const result = await stopRun("run-a");

      expect(result.stopped).toBe(true);
      expect(readState("run-a")).toMatchObject({ state: "ready", version: seededVersion });
      expect(readFence()).toEqual(fence);
      expect(stderr.text()).toContain(
        "[residency] lifecycle run-a stop not recorded: profile switch in flight",
      );
    } finally {
      stderr.restore();
    }
  });

  test("MR6: a stop whose residency writes fail still runs and returns the stop result", async () => {
    // kills: mapping a refused pre-walk to stopped:false.
    writeRun("run-a", GROUP);
    seed([{ model: "run-a", target: "ready", group: GROUP }]);
    const seeded = readState("run-a");
    blockResidencyWrites();
    const stderr = captureStderr();
    try {
      const result = await stopRun("run-a");

      expect(result.stopped).toBe(true);
      expect(readState("run-a")).toEqual(seeded);
      expect(stderr.text()).toContain("run-a stop not recorded:");
      expect(stderr.text()).toContain("disk full");
    } finally {
      stderr.restore();
    }
  });

  test("MR7: a proven-down ready ModelRun peer is reconciled before the group check", async () => {
    // kills: isProvenDown staying ModelHost-only.
    writeRun("run-a", GROUP);
    writeRun("run-b", GROUP);
    seed([{ model: "run-b", target: "ready", group: GROUP }]);
    const stderr = captureStderr();
    try {
      const result = await startRun("run-a");

      expect(result.ok).toBe(false);
      expect(result.error ?? "").toMatch(/^Model file not found:/);
      expect(readState("run-b")).toMatchObject({ state: "downloaded", group: GROUP });
      expect(readState("run-a")?.state).toBe("failed");
      expect(stderr.text()).toContain(
        "[residency] lifecycle reconciled stale run-b ready -> downloaded in group z13-large-gpu",
      );
    } finally {
      stderr.restore();
    }
  });

  test("MR8: a ModelRun peer with a recorded pid is not proven down and still refuses", async () => {
    // kills: dropping the readServerPid gate (a ModelRun with any recorded
    // pid is treated as proven down). Pins only this slice's fail-closed
    // gate, not a design invariant; identity-based proof (#517 remaining
    // scope) may relax it.
    writeRun("run-a", GROUP);
    writeRun("run-b", GROUP);
    seed([{ model: "run-b", target: "ready", group: GROUP }]);
    const pidDir = join(runtimeDir, "workloads", "run-b");
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(join(pidDir, "llama-server.pid"), `${String(process.pid)}\n`);
    expect(server.readServerPid({ name: "run-b" })).toBe(process.pid);

    const result = await startRun("run-a");

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "residency lifecycle refused run-a downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by run-b in state ready",
    );
    expect(readState("run-b")?.state).toBe("ready");
  });

  test("MR9: a ModelHost start reconciles a proven-down ModelRun peer in the same group", async () => {
    // kills: modelHostStart opts keeping directModelHostProvenDown.
    writeRun("run-b", GROUP);
    writeHost("z13-h", GROUP, 18097);
    seed([{ model: "run-b", target: "ready", group: GROUP }]);

    const result = await startHost("z13-h");

    expect(result.ok).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.error).toBe(bindRefusal("z13-h"));
    expect(readState("run-b")).toMatchObject({ state: "downloaded" });
    expect(readState("z13-h")?.state).toBe("failed");
  });

  test("MR10: an undeclared label group records no group and still hits the model-file error", async () => {
    // kills: passing an undeclared group to the store.
    writeRun("run-c", OTHER_GROUP);
    seed([]);

    const result = await startRun("run-c");

    expect(result.ok).toBe(false);
    expect(result.error ?? "").toMatch(/^Model file not found:/);
    expect(result.error ?? "").not.toContain("UnknownGroup");
    expect(readState("run-c")).toMatchObject({ state: "failed", group: null, version: 3 });
  });

  test("MR11: a stop inside the residency switch scope bypasses the direct lifecycle", async () => {
    // kills: serverStop ignoring the switch scope (noisy log on the
    // switch's own applyManifest stops).
    const mod = await directLifecycleModule();
    expect(typeof mod["runInResidencySwitchScope"]).toBe("function");
    writeRun("run-a", GROUP);
    const fence = seed([{ model: "run-a", target: "ready", group: GROUP }], {
      switchOp: true,
    });
    const seededVersion = readState("run-a")?.version ?? 0;
    const stderr = captureStderr();
    try {
      const runInScope = mod["runInResidencySwitchScope"] as SwitchScopeRunner;
      let stopResult: RunStopResult | undefined;
      await runInScope(async () => {
        stopResult = await stopRun("run-a");
      });

      expect(stopResult?.stopped).toBe(true);
      expect(readState("run-a")).toMatchObject({ state: "ready", version: seededVersion });
      expect(readFence()).toEqual(fence);
      expect(stderr.text()).not.toContain("stop not recorded");
    } finally {
      stderr.restore();
    }
  });

  test("MR12: a start inside the residency switch scope bypasses the direct lifecycle", async () => {
    // kills: serverStart ignoring the switch scope.
    const mod = await directLifecycleModule();
    expect(typeof mod["runInResidencySwitchScope"]).toBe("function");
    writeRun("run-a", GROUP);
    seed([], { switchOp: true });

    const runInScope = mod["runInResidencySwitchScope"] as SwitchScopeRunner;
    let result: RunStartResult | undefined;
    await runInScope(async () => {
      result = await startRun("run-a");
    });

    expect(result?.ok).toBe(false);
    expect(result?.error ?? "").toMatch(/^Model file not found:/);
    expect(result?.error ?? "").not.toContain("profile switch in flight");
    expect(readState("run-a")).toBeNull();
  });

  test("MS1: a real wet switch runs its own start past the in-flight gate, then an external start walks the row", async () => {
    // kills: no in-switch bypass in serverStart / applyModelRun not
    // running in the scope. The last assertion (the external start's
    // version bump) is the one that fails at base by assertion. With no
    // config file the serving node resolves to inproc://local, so
    // clientForNode already returns the in-process caller here: this case
    // does NOT cover the forced-local getClient; MS2 does.
    const applied = await wetSwitchChatToCode();

    const startStep = applied.steps.find((s) => s.action === "start" && s.workload === "code-y");
    expect(startStep?.status).toBe("failed");
    const detail = startStep?.detail ?? "";
    expect(detail).not.toContain("profile switch in flight");
    expect(detail).not.toContain("residency lifecycle refused");
    expect(detail).toBe(`Model file not found: ${join(modelsDir, "code-y/missing.gguf")}`);

    const settled = readState("code-y");
    expect(settled).toMatchObject({ state: "failed", group: GROUP });
    const settledVersion = settled?.version ?? 0;
    const operationId = applied.operationId;
    expect(typeof operationId).toBe("string");
    expect(withStore((store) => store.getOperation(operationId!))?.phase).toBe("terminal");

    const external = await startRun("code-y");
    expect(external.ok).toBe(false);
    expect(external.error ?? "").toMatch(/^Model file not found:/);
    expect(readState("code-y")?.state).toBe("failed");
    expect(readState("code-y")?.version ?? 0).toBeGreaterThan(settledVersion);
  });

  test("MS2: the switch forces its serving node in-process even when the config names a remote endpoint", async () => {
    // kills: applyModelRun.getClient using clientForNode for input.node.
    // The serving node's configured endpoint is a non-inproc https URL on a
    // closed loopback port, so a cross-hop serverStart would lose the
    // switch scope (and fail the hop) instead of reaching the engine's
    // model-file error.
    const config = freshConfig();
    const cluster = config.clusters[0];
    const localNode = cluster?.nodes[0];
    if (cluster === undefined || localNode?.name !== "local") {
      throw new Error("freshConfig no longer seeds a local node");
    }
    localNode.endpoint = `https://127.0.0.1:${String(closedLoopbackPort())}`;
    const configPath = join(root, "config");
    saveConfig(config, configPath);
    process.env["LLAMACTL_CONFIG"] = configPath;

    const applied = await wetSwitchChatToCode();

    const startStep = applied.steps.find((s) => s.action === "start" && s.workload === "code-y");
    expect(startStep?.status).toBe("failed");
    const detail = startStep?.detail ?? "";
    expect(detail).not.toContain("profile switch in flight");
    expect(detail).toBe(`Model file not found: ${join(modelsDir, "code-y/missing.gguf")}`);
    expect(readState("code-y")).toMatchObject({ state: "failed", group: GROUP });
  });

  test("MR13: a stop that does not confirm removal leaves the row occupying and logs it unrecorded", async () => {
    // kills: an unconfirmed stop walking the row to failed or downloaded
    // (both non-occupying, freeing the exclusive group while the process may
    // still be alive); serverStop mapping ok to anything but stop.stopped.
    // The recorded pid is this test process (alive, but not a llama-server),
    // so stopServer's identity check reads unknown: no signal is sent and it
    // returns stopped:false with the pid file retained.
    writeRun("run-a", GROUP);
    seed([{ model: "run-a", target: "ready", group: GROUP }]);
    const seeded = readState("run-a");
    writePidFile("run-a");
    const stderr = captureStderr();
    try {
      const result = await stopRun("run-a");

      expect(result).toEqual({ stopped: false, pid: process.pid, killed: false });
      expect(server.readServerPid({ name: "run-a" })).toBe(process.pid);
      expect(readState("run-a")).toEqual(seeded);
      expect(stderr.text()).toContain(
        "[residency] lifecycle run-a stop not recorded: unconfirmed stop (process may be alive)",
      );
    } finally {
      stderr.restore();
    }
  });

  test("MR13b: a same-group peer start is still refused after an unconfirmed stop", async () => {
    // kills: an unconfirmed stop freeing the exclusive group (a failed or
    // downloaded row lets a peer load beside a process that may be alive).
    writeRun("run-a", GROUP);
    writeRun("run-b", GROUP);
    seed([{ model: "run-a", target: "ready", group: GROUP }]);
    writePidFile("run-a");

    const stopped = await stopRun("run-a");
    expect(stopped.stopped).toBe(false);

    const result = await startRun("run-b");

    expect(result.ok).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.error).toBe(
      "residency lifecycle refused run-b downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by run-a in state ready",
    );
    expect(readState("run-a")?.state).toBe("ready");
    expect(readState("run-b")?.state).toBe("downloaded");
  });

  test("MR14: a refused start honours the endpoint override in its StartServerResult", async () => {
    // kills: serverStartRefusal ignoring input.endpoint (env-default
    // endpoints on the refusal done event).
    writeRun("run-a", GROUP);
    writeRun("run-b", GROUP);
    seed([{ model: "run-b", target: "loading", group: GROUP }]);
    const override = { host: "127.0.0.9", port: 18555 };

    const result = await startRun("run-a", { endpoint: override });

    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("ExclusiveGroupOccupied");
    const resolved = coreEnv.resolveEnv();
    expect(result.endpoint).toBe("http://127.0.0.9:18555");
    expect(result.endpoint).toBe(server.endpoint(resolved, override));
    expect(result.advertisedEndpoint).toBe(server.advertisedEndpoint(resolved, override));
    expect(result.advertisedEndpoint).toMatch(/:18555$/);
    expect(result.endpoint).not.toBe(server.endpoint(resolved));
  });

  test("MR15: a start of a ModelRun whose own ready row has a live pid file adopts the row", async () => {
    // kills: directModelRunOpts.isRunning not reading the ModelRun pid file
    // (e.g. reusing the ModelHost status probe, which reads Stopped for a
    // ModelRun): the start would walk its own ready row down instead of
    // adopting it.
    writeRun("run-a", GROUP);
    seed([{ model: "run-a", target: "ready", group: GROUP }]);
    const seeded = readState("run-a");
    writePidFile("run-a");
    const stderr = captureStderr();
    try {
      await startRun("run-a");

      expect(readState("run-a")).toEqual(seeded);
      expect(stderr.text()).toContain(
        "[residency] lifecycle run-a start kept ready: host already running",
      );
    } finally {
      stderr.restore();
    }
  });

  test("MR15b: a start of a ModelRun whose own ready row has no pid file walks the row", async () => {
    // kills: directModelRunOpts.isRunning reading true without a pid file
    // (adopting a stale ready row for a ModelRun that is not running).
    writeRun("run-a", GROUP);
    seed([{ model: "run-a", target: "ready", group: GROUP }]);
    const seededVersion = readState("run-a")?.version ?? 0;
    const stderr = captureStderr();
    try {
      const result = await startRun("run-a");

      expect(result.ok).toBe(false);
      expect(result.error ?? "").toMatch(/^Model file not found:/);
      // ready -> draining -> unloading -> downloaded -> loading -> failed.
      expect(readState("run-a")).toMatchObject({
        state: "failed",
        group: GROUP,
        version: seededVersion + 5,
      });
      expect(stderr.text()).not.toContain("start kept ready");
    } finally {
      stderr.restore();
    }
  });
});
