// #517 — RED tests pinning local `llamactl server start`/`stop` residency
// dispatch. At the pinned base, fetchStartResult/fetchStopResult short-
// circuit local dispatch to the core engine (server.startServer /
// server.stopServer), bypassing the in-process serverStart/serverStop
// procedures — so no residency_states row is recorded and an occupied
// exclusive group is never refused — and buildStartManifest rewrites the
// stored ModelRun with empty labels/annotations, wiping
// llamactl.io/residency-group. Every case fails BY ASSERTION on the
// recorded dispatch, the stored manifest, stderr text or the lifecycle
// row — never by import, type or exit code alone. All engine targets
// name a missing .gguf under a temp models dir, so the base fallback is
// hermetic: no live process, port, sleep or user state.
import type { ResidencyState } from "@llamactl/core/residency/lifecycle";

import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
import { configSchema, type NodeClient, workloadSchema, workloadStore } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../remote/src/residency/apply-profile.js";
import {
  openResidencyOperationStore,
  type ResidencyLifecycleStore,
  type ResidencyOperationStore,
  type ResidencyStateRecord,
} from "../../remote/src/residency/store.js";
import { runServer } from "../src/commands/server.js";
import { __resetTestSeams, __setTestSeams, resetGlobals } from "../src/dispatcher.js";
import { mkdirSync, mkdtempSync, rmSync } from "../src/safe-fs.js";

const GROUP = "z13-large-gpu";
const GROUP_LABEL = "llamactl.io/residency-group";
const PROFILES_ANNOTATION = "llamactl.io/residency-profiles";
const NOW = 1_000_000_000;

const ENV_KEYS = [
  "LLAMACTL_WORKLOADS_DIR",
  "LLAMACTL_CONFIG",
  "DEV_STORAGE",
  "LLAMACTL_RESIDENCY_STORE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMA_CPP_MODELS",
  "LLAMA_CPP_BIN",
  "LLAMACTL_NODE_NAME",
] as const;

const origStderrWrite = process.stderr.write.bind(process.stderr);
const origStdoutWrite = process.stdout.write.bind(process.stdout);

type Store = ResidencyOperationStore & ResidencyLifecycleStore;
type SeedRow = { model: string; target: ResidencyState; group?: string };
type SubscribeHandlers = {
  onData: (e: unknown) => void;
  onError: (e: unknown) => void;
  onComplete: () => void;
  onStarted?: () => void;
};

let tmp = "";
let workloadsDir = "";
let storePath = "";
let savedEnv: Record<string, string | undefined> = {};
let stderrChunks: string[] = [];
let stdoutChunks: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-server-residency-"));
  workloadsDir = join(tmp, "workloads");
  const modelsDir = join(tmp, "models");
  const runtimeDir = join(tmp, "runtime");
  const binDir = join(tmp, "bin");
  storePath = join(tmp, "residency-state", "operations.sqlite");
  for (const dir of [workloadsDir, modelsDir, runtimeDir, binDir, join(tmp, "residency-state")]) {
    mkdirSync(dir, { recursive: true });
  }
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    DEV_STORAGE: join(tmp, "dev"),
    LLAMACTL_RESIDENCY_STORE: storePath,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMA_CPP_MODELS: modelsDir,
    LLAMA_CPP_BIN: binDir,
    LLAMACTL_NODE_NAME: "local",
  });
  stderrChunks = [];
  stdoutChunks = [];
  __setTestSeams({ config: configSchema.freshConfig() });
  resetGlobals();
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  process.stderr.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    if (typeof chunk === "string") stderrChunks.push(chunk);
    return true;
  };
  process.stdout.write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    if (typeof chunk === "string") stdoutChunks.push(chunk);
    return true;
  };
});

afterEach(() => {
  process.stderr.write = origStderrWrite;
  process.stdout.write = origStdoutWrite;
  __resetTestSeams();
  resetGlobals();
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

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
// rule the lifecycle walks use.
function seed(rows: readonly SeedRow[]): void {
  const store = openResidencyOperationStore({ path: storePath });
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
  } finally {
    store.close();
  }
}

function withStore<T>(fn: (store: Store) => T): T {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function readState(model: string): ResidencyStateRecord | null {
  return withStore((store) => store.getResidencyState(model));
}

function writeModelRun(
  name: string,
  options: { labels?: Record<string, string>; annotations?: Record<string, string> } = {},
): void {
  workloadStore.saveWorkload(
    workloadSchema.ModelRunSchema.parse({
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: {
        name,
        ...(options.labels === undefined ? {} : { labels: options.labels }),
        ...(options.annotations === undefined ? {} : { annotations: options.annotations }),
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

const START_DONE_RESULT = {
  ok: true,
  pid: 4242,
  endpoint: "http://127.0.0.1:18080",
  advertisedEndpoint: "http://127.0.0.1:18080",
  tunedProfile: null,
  retried: false,
};

// The done event is deferred to a microtask so the subscribeRemote
// Promise constructor finishes and its locals are initialized before any
// handler fires — mirrors the serverLogs mock in server.test.ts.
// With failWith set, the subscription errors instead of emitting done.
function startClient(inputs: unknown[], failWith?: Error): NodeClient {
  return {
    serverStart: {
      subscribe: (input: unknown, handlers: SubscribeHandlers) => {
        inputs.push(input);
        queueMicrotask(() => {
          if (failWith !== undefined) {
            handlers.onError(failWith);
            return;
          }
          handlers.onData({ type: "done", result: START_DONE_RESULT });
          handlers.onComplete();
        });
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        return { unsubscribe: (): void => {} };
      },
    },
  } as unknown as NodeClient;
}

// With failWith set, the mutation rejects instead of resolving.
function stopClient(inputs: unknown[], failWith?: Error): NodeClient {
  return {
    serverStop: {
      mutate: (input: unknown) => {
        inputs.push(input);
        if (failWith !== undefined) return Promise.reject(failWith);
        return Promise.resolve({ stopped: true, pid: 4242, killed: false });
      },
    },
  } as unknown as NodeClient;
}

describe("#517 local server start/stop residency dispatch", () => {
  // Kills: fetchStopResult's isLocalDispatch() branch calling core
  // server.stopServer directly — the serverStop.mutate path is never
  // reached, so no fenceWorkloadStop/runDirectResidencyStop walk runs.
  test("S1 local stop dispatches through serverStop.mutate", async () => {
    const inputs: unknown[] = [];
    __setTestSeams({ config: configSchema.freshConfig(), nodeClient: stopClient(inputs) });
    const code = await runServer(["stop", "--name", "w"]);
    expect(inputs).toEqual([{ workload: "w", graceSeconds: 5 }]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("stopped pid=4242");
  });

  // Kills: fetchStartResult's isLocalDispatch() branch calling core
  // server.startServer directly — the serverStart.subscribe path is
  // never reached.
  test("S2 local start dispatches through serverStart.subscribe", async () => {
    const inputs: unknown[] = [];
    __setTestSeams({ config: configSchema.freshConfig(), nodeClient: startClient(inputs) });
    const code = await runServer(["start", "--name", "w", "--timeout=30", "w/missing.gguf"]);
    expect(code).toBe(0);
    expect(inputs).toEqual([{ workload: "w", target: "w/missing.gguf", timeoutSeconds: 30 }]);
    expect(stdoutChunks.join("")).toContain(
      "llama-server up pid=4242 endpoint=http://127.0.0.1:18080",
    );
  });

  // Kills: buildStartManifest hard-coding labels:{}/annotations:{},
  // which wipes the stored llamactl.io/residency-group (and every other
  // stored label/annotation) before the in-process procedures read it.
  test("S3 local start preserves stored labels and annotations", async () => {
    const labels = { [GROUP_LABEL]: GROUP, team: "x" };
    const annotations = { [PROFILES_ANNOTATION]: "p1" };
    writeModelRun("w", { labels, annotations });
    const inputs: unknown[] = [];
    __setTestSeams({ config: configSchema.freshConfig(), nodeClient: startClient(inputs) });
    await runServer(["start", "--name", "w", "--timeout=30", "w/missing.gguf"]);
    const stored = workloadStore.loadWorkloadByName("w");
    expect(stored.metadata.labels).toEqual(labels);
    expect(stored.metadata.annotations).toEqual(annotations);
    expect(stored.spec.target.value).toBe("w/missing.gguf");
  });

  // Guard, not RED: with no stored ModelRun the rewritten manifest still
  // carries empty labels/annotations (passes at base and after the fix).
  test("S3b local start with no stored ModelRun keeps empty labels", async () => {
    const inputs: unknown[] = [];
    __setTestSeams({ config: configSchema.freshConfig(), nodeClient: startClient(inputs) });
    await runServer(["start", "--name", "w", "--timeout=30", "w/missing.gguf"]);
    const stored = workloadStore.loadWorkloadByName("w");
    expect(stored.metadata.labels).toEqual({});
    expect(stored.metadata.annotations).toEqual({});
  });

  // Kills: both the fetchStartResult local-branch mutation (no
  // runDirectResidencyStart walk, no ExclusiveGroupOccupied refusal) and
  // the label wipe (with labels wiped the start records no group and
  // reaches the engine, which reports Model file not found instead).
  test("S4 local start is refused by an occupied exclusive group", async () => {
    seed([{ model: "peer-a", target: "ready", group: GROUP }]);
    writeModelRun("w", { labels: { [GROUP_LABEL]: GROUP } });
    const code = await runServer(["start", "--name", "w", "w/missing.gguf"]);
    const stderr = stderrChunks.join("");
    expect(code).toBe(1);
    expect(stderr).toContain("ExclusiveGroupOccupied");
    expect(stderr).toContain("peer-a");
    expect(stderr).not.toContain("Model file not found");
    const row = readState("w");
    const occupying =
      row !== null && (row.state === "loading" || row.state === "warming" || row.state === "ready");
    expect(occupying).toBe(false);
  });

  // Kills: fetchStopResult's direct server.stopServer call — the row
  // must walk ready -> draining -> unloading -> downloaded through
  // runDirectResidencyStop instead of staying ready.
  test("S5 local stop walks the residency row to downloaded", async () => {
    seed([{ model: "w", target: "ready", group: GROUP }]);
    writeModelRun("w", { labels: { [GROUP_LABEL]: GROUP } });
    const before = readState("w");
    expect(before?.state).toBe("ready");
    const code = await runServer(["stop", "--name", "w"]);
    expect(code).toBe(0);
    expect(stdoutChunks.join("")).toContain("stopped pid=none");
    const after = readState("w");
    expect(after?.state).toBe("downloaded");
    expect(after !== null && before !== null && after.version > before.version).toBe(true);
  });

  // Kills: applyGraceFlag accepting any positive grace (the base
  // behaviour), which forwards graceSeconds: 120 to serverStop and fails
  // there with a raw zod too_big dump instead of a clear CLI error.
  test("S6 local stop rejects --grace above 60 before any dispatch", async () => {
    const inputs: unknown[] = [];
    __setTestSeams({ config: configSchema.freshConfig(), nodeClient: stopClient(inputs) });
    const code = await runServer(["stop", "--name", "w", "--grace=120"]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toBe("server stop: --grace must be between 1 and 60\n");
    expect(inputs).toEqual([]);
    expect(stdoutChunks.join("")).toBe("");
  });

  // Kills: an off-by-one upper bound (n >= 60 rejected) that refuses the
  // largest grace serverStop accepts.
  test("S7 local stop accepts --grace=60 and forwards it", async () => {
    const inputs: unknown[] = [];
    __setTestSeams({ config: configSchema.freshConfig(), nodeClient: stopClient(inputs) });
    const code = await runServer(["stop", "--name", "w", "--grace=60"]);
    expect(code).toBe(0);
    expect(inputs).toEqual([{ workload: "w", graceSeconds: 60 }]);
    expect(stdoutChunks.join("")).toContain("stopped pid=4242");
  });

  // Kills: dispatchFailureLabel's in-process branch reverting to the
  // remote wording ("remote call to 'local'") or to an empty node label
  // ("call to ''") for a local stop with no --node.
  test("S8 local stop failure names the in-process node without 'remote'", async () => {
    const inputs: unknown[] = [];
    __setTestSeams({
      config: configSchema.freshConfig(),
      nodeClient: stopClient(inputs, new Error("boom-stop")),
    });
    const code = await runServer(["stop", "--name", "w"]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toBe("server stop: call to 'local' failed: boom-stop\n");
    expect(stdoutChunks.join("")).toBe("");
  });

  // Kills: the same label mutations on the start path, where the
  // serverStart subscription errors with no --node.
  test("S9 local start failure names the in-process node without 'remote'", async () => {
    const inputs: unknown[] = [];
    __setTestSeams({
      config: configSchema.freshConfig(),
      nodeClient: startClient(inputs, new Error("boom-start")),
    });
    const code = await runServer(["start", "--name", "w", "w/missing.gguf"]);
    expect(code).toBe(1);
    expect(stderrChunks.join("")).toBe("server start: call to 'local' failed: boom-start\n");
    expect(stdoutChunks.join("")).toBe("");
  });
});
