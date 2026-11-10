/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects/resolves matchers are typed as void. */
import { readModelHostState, writeModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelHostManifest } from "./modelhost-schema.js";
import type { ModelRun } from "./schema.js";

import { envForTemp, makeTempRuntime } from "../../../core/test/helpers.js";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "../safe-fs.js";
import { createTargetAdmissionAuthority, type TargetAdmissionAuthority } from "./admission.js";
import * as remoteAdmission from "./admission.js";
import {
  type ApplyEvent,
  applyOne,
  applyOneModelHost,
  type ApplyResult,
  type WorkloadClient,
} from "./apply.js";
import { saveModelHost } from "./modelhost-store.js";
import { loadWorkloadByNameAny, saveWorkload } from "./store.js";

type WorkloadState = { up: boolean; rel: string; args: string[] };
type WorkloadStateMap = Map<string, WorkloadState>;

function makeClient(state: WorkloadStateMap): WorkloadClient {
  return {
    serverStatus: {
      query: ({ workload }): ReturnType<WorkloadClient["serverStatus"]["query"]> => {
        const s = state.get(workload);
        return Promise.resolve(
          s
            ? {
                state: "up",
                pid: 1,
                rel: s.rel,
                extraArgs: s.args,
                host: "127.0.0.1",
                port: 8181,
                binary: null,
                endpoint: "http://127.0.0.1:8181",
              }
            : {
                state: "down",
                pid: null,
                rel: null,
                extraArgs: [],
                host: null,
                port: null,
                binary: null,
                endpoint: "http://127.0.0.1:8181",
              },
        );
      },
    },
    serverStop: {
      mutate: ({ workload }): Promise<{ stopped: boolean }> => {
        state.delete(workload);
        return Promise.resolve({ stopped: true });
      },
    },
    serverStart: {
      subscribe: ({ workload, target, extraArgs }, callbacks): { unsubscribe: () => undefined } => {
        state.set(workload, { up: true, rel: target, args: extraArgs ?? [] });
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 100, endpoint: "http://127.0.0.1:8181" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    modelHostStop: { mutate: () => Promise.resolve({ stopped: true }) },
    modelHostStatus: { query: () => Promise.resolve({ state: "Stopped", pid: null }) },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: "", llamaCppBin: "" }) },
  };
}

function makeRecordingClient(state: WorkloadStateMap): {
  client: WorkloadClient;
  stops: string[];
  starts: string[];
} {
  const stops: string[] = [];
  const starts: string[] = [];
  const base = makeClient(state);
  const client: WorkloadClient = {
    ...base,
    serverStop: {
      mutate: (input): Promise<unknown> => {
        stops.push(input.workload);
        return base.serverStop.mutate(input);
      },
    },
    serverStart: {
      subscribe: (input, callbacks): UnsubscribableLike => {
        starts.push(input.workload);
        return base.serverStart.subscribe(input, callbacks);
      },
    },
  };
  return { client, stops, starts };
}

type UnsubscribableLike = ReturnType<WorkloadClient["serverStart"]["subscribe"]>;
type ServerStartCallbacks = Parameters<WorkloadClient["serverStart"]["subscribe"]>[1];

const mkManifest = (
  name: string,
  overrides: Partial<{
    annotations: Record<string, string>;
    enabled: boolean;
    port: number;
    ram: number;
    node: string;
  }> = {},
): ModelRun => ({
  apiVersion: "llamactl/v1",
  kind: "ModelRun",
  metadata: { name, labels: {}, annotations: overrides.annotations ?? {} },
  spec: {
    node: overrides.node ?? "local",
    enabled: overrides.enabled ?? true,
    target: { kind: "rel", value: `${name}.gguf` },
    extraArgs: [],
    workers: [],
    restartPolicy: "Always",
    gateway: false,
    allowExternalBind: false,
    timeoutSeconds: 60,
    endpoint: { host: "127.0.0.1", port: overrides.port ?? 8181 },
    resources: { expectedMemoryGiB: overrides.ram ?? 8 },
  },
});

function mkModelHostManifest(
  name: string,
  overrides: Partial<ModelHostManifest["spec"]> = {},
): ModelHostManifest {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name },
    spec: {
      engine: "omlx",
      node: "local",
      enabled: true,
      binary: "/usr/bin/true",
      endpoint: { host: "127.0.0.1", port: 18094 },
      hostedModels: [{ rel: `${name}.gguf` }],
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 60,
      ...overrides,
    },
  };
}

function makeModelHostClient(): WorkloadClient {
  return {
    serverStatus: {
      query: () =>
        Promise.resolve({
          state: "down",
          pid: null,
          rel: null,
          extraArgs: [],
          host: null,
          port: null,
          binary: null,
          endpoint: "",
        }),
    },
    serverStop: { mutate: () => Promise.resolve({ stopped: true }) },
    serverStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    modelHostStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: { ok: true, pid: 12345, state: "Running" } });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStop: { mutate: () => Promise.resolve({ stopped: true }) },
    modelHostStatus: { query: () => Promise.resolve({ state: "Running", pid: 12345 }) },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: "", llamaCppBin: "" }) },
  };
}

function seedModelDir(modelsDir: string, rel: string, sizeBytes: number): void {
  const dir = join(modelsDir, rel);
  mkdirSync(dir, { recursive: true });
  const weights = join(dir, "weights.bin");
  writeFileSync(weights, "");
  truncateSync(weights, sizeBytes);
}

// #520: applyOne consults an optional session gate before evicting. The gate
// is a structural fake — the real store lives in
// @llamactl/core/residency/sessions and is never imported here.
type SessionGateCheck =
  | { ok: true; released: string[] }
  | { ok: false; reason: string; sessions: string[] };

type SessionGate = {
  checkUnload: (workload: string) => SessionGateCheck;
};

function makeSessionGate(checkUnload: (workload: string) => SessionGateCheck): SessionGate {
  return { checkUnload };
}

// DF-02 (#275): a fault handler that returns a promise replaces the healthy
// behavior for that one workload; returning undefined delegates to the
// recording client. Fault paths still push into the shared stops array
// exactly once so call counts stay honest.
function makeEvictFaultClient(
  state: WorkloadStateMap,
  faults: {
    stop?: (workload: string) => Promise<unknown> | undefined;
    status?: (workload: string) => ReturnType<WorkloadClient["serverStatus"]["query"]> | undefined;
  } = {},
): { client: WorkloadClient; stops: string[]; starts: string[] } {
  const { client: rec, stops, starts } = makeRecordingClient(state);
  const client: WorkloadClient = {
    ...rec,
    serverStatus: {
      query: (input) => faults.status?.(input.workload) ?? rec.serverStatus.query(input),
    },
    serverStop: {
      mutate: (input) => {
        const fault = faults.stop?.(input.workload);
        if (fault !== undefined) {
          stops.push(input.workload);
          return fault;
        }
        return rec.serverStop.mutate(input);
      },
    },
  };
  return { client, stops, starts };
}

function makeEventRecorder(): {
  events: { type: string; message: string }[];
  onEvent: (event: ApplyEvent) => void;
} {
  const events: { type: string; message: string }[] = [];
  return {
    events,
    onEvent: (event: ApplyEvent): void => {
      events.push({ type: event.type, message: event.message });
    },
  };
}

test("disabled manifest stops the server if running and reports Disabled", async () => {
  const state = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const result = await applyOne(mkManifest("a", { enabled: false }), () => makeClient(state));
  expect(result.statusSection.phase).toBe("Stopped");
  expect(result.statusSection.conditions[0]?.reason).toBe("Disabled");
  expect(state.has("a")).toBe(false);
});

test("parallel apply does not stop other workloads on the node", async () => {
  const state = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-parallel-apply-"));
  try {
    const result = await applyOne(
      mkManifest("b", { port: 8090 }),
      () => makeClient(state),
      undefined,
      undefined,
      {
        workloadsDir,
        getNodeBudgetGiB: () => 32,
      },
    );
    expect(state.has("a")).toBe(true);
    expect(state.has("b")).toBe(true);
    expect(result.action).toBe("started");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("running server with port-only endpoint manifest is unchanged", async () => {
  const state = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const manifest = mkManifest("a");
  manifest.spec.endpoint = {
    port: 8181,
  };
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-port-only-"));
  try {
    const result = await applyOne(manifest, () => makeClient(state), undefined, undefined, {
      workloadsDir,
      getNodeBudgetGiB: () => 32,
    });
    expect(result.action).toBe("unchanged");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("running server with alias target resolved to live rel is unchanged", async () => {
  const state = new Map([["alias", { up: true, rel: "qwen3.6-35b-mtp.gguf", args: [] }]]);
  const manifest = mkManifest("alias");
  manifest.spec.target = { kind: "alias", value: "best" };
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-alias-target-"));
  try {
    const result = await applyOne(
      manifest,
      () => ({
        ...makeClient(state),
        resolveTarget: {
          query: (): Promise<string | null> => Promise.resolve("qwen3.6-35b-mtp.gguf"),
        },
      }),
      undefined,
      undefined,
      { workloadsDir, getNodeBudgetGiB: () => 32 },
    );
    expect(result.action).toBe("unchanged");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("genuinely changed rel/host/port still triggers restart", async () => {
  const state = new Map([["delta", { up: true, rel: "a.gguf", args: [] }]]);
  const manifest = mkManifest("delta");
  manifest.spec.target = { kind: "rel", value: "b.gguf" };
  manifest.spec.endpoint = {
    host: "localhost",
    port: 8199,
  };
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-changed-rel-"));
  try {
    const result = await applyOne(manifest, () => makeClient(state), undefined, undefined, {
      workloadsDir,
      getNodeBudgetGiB: () => 32,
    });
    expect(result.action).toBe("restarted");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("evict annotation stops named workload before starting incoming", async () => {
  const state = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-evict-"));
  saveWorkload(mkManifest("a"), workloadsDir);
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => makeClient(state),
      undefined,
      undefined,
      { workloadsDir, getNodeBudgetGiB: () => 32 },
    );
    expect(state.has("a")).toBe(false);
    expect(state.has("b")).toBe(true);
    expect(result.action).toBe("started");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-01A: evict naming a stored ModelHost is refused before any stop or start", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  saveModelHost(
    mkModelHostManifest("resident-host", { resources: { expectedMemoryGiB: 24 } }),
    workloadsDir,
  );
  const state: WorkloadStateMap = new Map();
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("incoming-run", { ram: 8, annotations: { "llamactl.io/evict": "resident-host" } }),
      () => client,
      undefined,
      undefined,
      { env, workloadsDir, getNodeBudgetGiB: () => 24 },
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictKindUnsupported");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(loadWorkloadByNameAny("resident-host", workloadsDir).kind).toBe("ModelHost");
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: evict naming an unparseable manifest is refused without freeing capacity", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  mkdirSync(workloadsDir, { recursive: true });
  writeFileSync(join(workloadsDir, "ghost-host.yaml"), "kind: ModelHost\nspec: [unterminated\n");
  const state: WorkloadStateMap = new Map();
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("incoming-run", { ram: 8, annotations: { "llamactl.io/evict": "ghost-host" } }),
      () => client,
      undefined,
      undefined,
      { env, workloadsDir, getNodeBudgetGiB: () => 24 },
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictKindUnsupported");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: evict naming a missing manifest is a legacy skip that still proceeds", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  const state: WorkloadStateMap = new Map();
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("incoming-run", { ram: 8, annotations: { "llamactl.io/evict": "ghost-run" } }),
      () => client,
      undefined,
      undefined,
      { env, workloadsDir, getNodeBudgetGiB: () => 24 },
    );
    expect(result.action).toBe("started");
    expect(stops).toEqual([]);
    expect(starts).toEqual(["incoming-run"]);
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: runtime-up ghost-run with no canonical manifest must remain up", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  const state: WorkloadStateMap = new Map();
  state.set("ghost-run", { up: true, rel: "ghost.gguf", args: [] });
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("incoming-run", { ram: 8, annotations: { "llamactl.io/evict": "ghost-run" } }),
      () => client,
      undefined,
      undefined,
      {
        env,
        workloadsDir,
        getNodeBudgetGiB: () => 24,
      },
    );
    expect(state.get("ghost-run")?.up).toBe(true);
    expect(result.action).toBe("started");
    expect(stops).toEqual([]);
    expect(starts).toEqual(["incoming-run"]);
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: a missing evict victim listed as living grants no capacity credit", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  const state: WorkloadStateMap = new Map();
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("incoming-run", { ram: 8, annotations: { "llamactl.io/evict": "ghost-run" } }),
      () => client,
      undefined,
      undefined,
      {
        env,
        workloadsDir,
        listManifests: () => [mkManifest("ghost-run", { ram: 24 })],
        getNodeBudgetGiB: () => 24,
      },
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
    expect(result.error).toContain("ghost-run");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
  } finally {
    temp.cleanup();
  }
});

test("rejected admission does NOT evict its targets (destructive eviction guard)", async () => {
  // "a" is the eviction target (running). "c" is another living
  // workload on the same node that the incoming "b" does NOT evict —
  // its 8 GiB plus b's 8 GiB exceeds the 10 GiB node budget, so
  // admission fails. The eviction of "a" must NOT happen for a
  // workload that is then rejected. RED before the reorder: "a" was
  // stopped before admission ran, so a rejected apply still destroyed
  // the victim.
  const state = new Map([
    ["a", { up: true, rel: "a.gguf", args: [] }],
    ["c", { up: true, rel: "c.gguf", args: [] }],
  ]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-evict-guard-"));
  saveWorkload(mkManifest("a", { ram: 8 }), workloadsDir);
  saveWorkload(mkManifest("c", { ram: 8 }), workloadsDir);
  const result = await applyOne(
    mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090, ram: 8 }),
    () => makeClient(state),
    undefined,
    undefined,
    {
      workloadsDir,
      getNodeBudgetGiB: () => 10,
    },
  );
  expect(result.action).toBe("pending");
  expect(result.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
  // The victim must still be running — a rejected workload may not
  // evict anything.
  expect(state.has("a")).toBe(true);
  expect(state.has("b")).toBe(false);
  rmSync(workloadsDir, { recursive: true, force: true });
});

test("budget overflow returns pending with BudgetExceeded unless force-admit", async () => {
  const state = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-budget-overflow-"));
  try {
    const result = await applyOne(
      mkManifest("b", { port: 8090, ram: 8 }),
      () => makeClient(state),
      undefined,
      undefined,
      {
        workloadsDir,
        getNodeBudgetGiB: () => 10,
        listManifests: () => [mkManifest("a", { ram: 8 })],
      },
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("force-admit annotation bypasses the budget check", async () => {
  const state: WorkloadStateMap = new Map();
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-force-admit-"));
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/force-admit": "true" }, ram: 30, port: 8090 }),
      () => makeClient(state),
      undefined,
      undefined,
      { workloadsDir, getNodeBudgetGiB: () => 1, listManifests: () => [] },
    );
    expect(result.action).toBe("started");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("concurrent applies on the same node serialize through the mutex", async () => {
  const callOrder: string[] = [];
  const slowClient = (): WorkloadClient => ({
    serverStatus: {
      query: () =>
        Promise.resolve({
          state: "down",
          pid: null,
          rel: null,
          extraArgs: [],
          host: null,
          port: null,
          binary: null,
          endpoint: "",
        }),
    },
    serverStop: { mutate: () => Promise.resolve({ stopped: true }) },
    serverStart: {
      subscribe: ({ workload }, callbacks): { unsubscribe: () => undefined } => {
        callOrder.push(`start:${workload}`);
        setTimeout(() => {
          callOrder.push(`done:${workload}`);
          callbacks.onData({ type: "done", result: { ok: true, pid: 1, endpoint: "" } });
          callbacks.onComplete();
        }, 50);
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    modelHostStop: { mutate: () => Promise.resolve({ stopped: true }) },
    modelHostStatus: { query: () => Promise.resolve({ state: "Stopped", pid: null }) },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ stopped: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: "", llamaCppBin: "" }) },
  });
  const mfA = mkManifest("a", { port: 8181, node: "same" });
  const mfB = mkManifest("b", { port: 8090, node: "same" });
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-concurrent-apply-"));
  try {
    await Promise.all([
      applyOne(mfA, slowClient, undefined, undefined, {
        workloadsDir,
        listManifests: () => [],
        getNodeBudgetGiB: () => 32,
      }),
      applyOne(mfB, slowClient, undefined, undefined, {
        workloadsDir,
        listManifests: () => [],
        getNodeBudgetGiB: () => 32,
      }),
    ]);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
  expect(callOrder[0]?.startsWith("start:")).toBe(true);
  expect(callOrder[1]).toBe(callOrder[0]!.replace("start:", "done:"));
});

test("ModelHost on a remote node does not write a local sidecar", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-modelhost-sidecar-"));
  const env = { ...process.env, LOCAL_AI_RUNTIME_DIR: runtimeDir };
  const resolved = resolveEnv(env);
  const manifest = mkModelHostManifest("remote-host", { node: "mac-mini" });
  try {
    const result = await applyOneModelHost(manifest, () => makeModelHostClient(), undefined, {
      env,
      workloadsDir: join(runtimeDir, "workloads"),
    });
    expect(result.ok).toBe(true);
    expect(readModelHostState({ name: manifest.metadata.name }, resolved)).toBeNull();
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("ModelHost disable on a remote node sweeps any pre-existing local sidecar (handles pre-fix leaks)", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-modelhost-sidecar-"));
  const env = { ...process.env, LOCAL_AI_RUNTIME_DIR: runtimeDir };
  const resolved = resolveEnv(env);
  const name = "remote-host-disabled";
  writeModelHostState(
    {
      kind: "ModelHost",
      engine: "omlx",
      pid: 4444,
      host: "127.0.0.1",
      port: 18094,
      modelAliases: ["seed.gguf"],
      startedAt: new Date().toISOString(),
    },
    { name },
    resolved,
  );
  const manifest = mkModelHostManifest(name, { node: "mac-mini", enabled: false });
  try {
    const result = await applyOneModelHost(manifest, () => makeModelHostClient(), undefined, {
      env,
      workloadsDir: join(runtimeDir, "workloads"),
    });
    expect(result.ok).toBe(true);
    expect(readModelHostState({ name }, resolved)).toBeNull();
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("ModelHost on local node still writes local sidecar", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-modelhost-sidecar-"));
  const env = { ...process.env, LOCAL_AI_RUNTIME_DIR: runtimeDir };
  const resolved = resolveEnv(env);
  const manifest = mkModelHostManifest("local-host", { node: "local" });
  try {
    const result = await applyOneModelHost(manifest, () => makeModelHostClient(), undefined, {
      env,
      workloadsDir: join(runtimeDir, "workloads"),
    });
    expect(result.ok).toBe(true);
    expect(readModelHostState({ name: manifest.metadata.name }, resolved)?.pid).toBe(12345);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("ModelHost admission uses expectedMemoryGiB instead of model-size fallback when present", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-expected-memory-"));
  const workloadsDir = join(tmp, "workloads");
  const modelsDir = join(tmp, "models");
  const rel = "mlx-community/big-model";
  const env = { ...process.env, LOCAL_AI_RUNTIME_DIR: tmp, LLAMA_CPP_MODELS: modelsDir };
  seedModelDir(modelsDir, rel, 23 * 1024 ** 3);
  saveWorkload(mkManifest("small-run", { ram: 5 }), workloadsDir);
  const manifest = mkModelHostManifest("mlx-host-expected", {
    hostedModels: [{ rel }],
    resources: { expectedMemoryGiB: 24 },
  });
  try {
    const result = await applyOneModelHost(manifest, () => makeModelHostClient(), undefined, {
      env,
      workloadsDir,
      getNodeBudgetGiB: () => 36,
    });
    expect(result.ok).toBe(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ModelHost admission falls back to model-size heuristic when expectedMemoryGiB is absent", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "llamactl-modelhost-memory-fallback-"));
  const workloadsDir = join(tmp, "workloads");
  const modelsDir = join(tmp, "models");
  const rel = "mlx-community/big-model";
  const env = { ...process.env, LOCAL_AI_RUNTIME_DIR: tmp, LLAMA_CPP_MODELS: modelsDir };
  seedModelDir(modelsDir, rel, 23 * 1024 ** 3);
  saveWorkload(mkManifest("small-run", { ram: 5 }), workloadsDir);
  const manifest = mkModelHostManifest("mlx-host-fallback", {
    hostedModels: [{ rel }],
    resources: undefined,
  });
  try {
    const result = await applyOneModelHost(manifest, () => makeModelHostClient(), undefined, {
      env,
      workloadsDir,
      getNodeBudgetGiB: () => 36,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("would reserve");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("DF-01A: ModelHost over-budget error does not prescribe the unsupported force-admit annotation", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  saveWorkload(mkManifest("resident-run", { ram: 16 }), workloadsDir);
  try {
    const result = await applyOneModelHost(
      mkModelHostManifest("mlx-host-over", { resources: { expectedMemoryGiB: 8 } }),
      () => makeModelHostClient(),
      undefined,
      { env, workloadsDir, getNodeBudgetGiB: () => 20 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Budget is 20.0 GiB");
      expect(result.error).not.toContain("force-admit");
    }
  } finally {
    temp.cleanup();
  }
});

test("DF-01: ModelRun admission counts a resident ModelHost before starting", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df01-mixed-"));
  const state: WorkloadStateMap = new Map();
  try {
    saveModelHost(
      mkModelHostManifest("resident-host", { resources: { expectedMemoryGiB: 24 } }),
      workloadsDir,
    );
    const result = await applyOne(
      mkManifest("incoming-run", { ram: 8 }),
      () => makeClient(state),
      undefined,
      undefined,
      { workloadsDir, getNodeBudgetGiB: () => 24 },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
    expect(result.action).toBe("pending");
    expect(result.error).toContain("resident-host");
    expect(state.has("incoming-run")).toBe(false);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-01: ModelRun admission uses a finite local budget without a supplied resolver", async () => {
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df01-finite-"));
  const state: WorkloadStateMap = new Map();
  try {
    const result = await applyOne(
      mkManifest("oversized-run", { ram: 1000 }),
      () => makeClient(state),
      undefined,
      undefined,
      { workloadsDir },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
    expect(result.action).toBe("pending");
    expect(state.has("oversized-run")).toBe(false);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-01: ModelRun admission counts living workloads on an alias of the same physical node", async () => {
  const state: WorkloadStateMap = new Map();
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df01-alias-"));
  try {
    const result = await applyOne(
      mkManifest("b", { port: 8090, ram: 8, node: "mac-mini" }),
      () => makeClient(state),
      undefined,
      undefined,
      {
        workloadsDir,
        getNodeBudgetGiB: () => 10,
        listManifests: () => [mkManifest("a", { ram: 8, node: "mac-mini.local" })],
        resolveNodeIdentity: (n) =>
          n === "mac-mini" || n === "mac-mini.local" ? "mac-mini" : null,
      },
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-01: an unverifiable remote budget refuses instead of admitting unlimited", async () => {
  const state: WorkloadStateMap = new Map();
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df01-unknown-"));
  try {
    const result = await applyOne(
      mkManifest("b", { port: 8090, ram: 8, node: "mac-mini" }),
      () => makeClient(state),
      undefined,
      undefined,
      { workloadsDir, listManifests: () => [] },
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.conditions[0]?.reason).toBe("BudgetUnknown");
    expect(result.error).toContain("budget is unknown");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-01: a zero-declared workload passes admission even with an unknown budget", async () => {
  const state: WorkloadStateMap = new Map();
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df01-zero-"));
  try {
    const result = await applyOne(
      mkManifest("b", { port: 8090, ram: 0, node: "mac-mini" }),
      () => makeClient(state),
      undefined,
      undefined,
      { workloadsDir, listManifests: () => [] },
    );
    expect(result.action).toBe("started");
    const reserved = result.statusSection.conditions.find((c) => c.type === "BudgetReserved");
    expect(reserved?.message).toContain("unknown");
    expect(reserved?.message).not.toContain("unbounded");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-01A: zero-declared incoming still refuses when a living reservation exists and the budget is unknown", async () => {
  const state: WorkloadStateMap = new Map();
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df01a-zero-living-"));
  try {
    const result = await applyOne(
      mkManifest("b", { port: 8090, ram: 0, node: "mac-mini" }),
      () => makeClient(state),
      undefined,
      undefined,
      {
        workloadsDir,
        listManifests: () => [mkManifest("a", { ram: 8, node: "mac-mini" })],
      },
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.conditions[0]?.reason).toBe("BudgetUnknown");
    expect(state.has("b")).toBe(false);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-01A: ModelRun admission charges a heuristic-sized ModelHost through the forwarded apply env", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  const rel = "mlx-community/df01a-host-model";
  seedModelDir(temp.modelsDir, rel, 1024 ** 3);
  saveModelHost(mkModelHostManifest("host-no-declared", { hostedModels: [{ rel }] }), workloadsDir);
  const state: WorkloadStateMap = new Map();
  const { client, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("incoming-run", { ram: 8 }),
      () => client,
      undefined,
      undefined,
      { env, workloadsDir, getNodeBudgetGiB: () => 9 },
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
    expect(result.error).toContain("host-no-declared");
    expect(starts).toEqual([]);
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: no-op apply of a matching running server keeps Running with its pid on an unknown budget", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  const state: WorkloadStateMap = new Map([["b", { up: true, rel: "b.gguf", args: [] }]]);
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("b", { ram: 8, node: "mac-mini" }),
      () => client,
      undefined,
      undefined,
      { env, workloadsDir, listManifests: () => [] },
    );
    expect(result.action).toBe("unchanged");
    expect(result.statusSection.phase).toBe("Running");
    expect(result.statusSection.serverPid).toBe(1);
    expect(result.statusSection.endpoint).toBe("http://127.0.0.1:8181");
    expect(result.error).toBeUndefined();
    expect(result.statusSection.conditions[0]?.reason).toBe("unchanged");
    const refusal = result.statusSection.conditions.find((c) => c.type === "BudgetRefused");
    expect(refusal?.reason).toBe("BudgetUnknown");
    expect(refusal?.message).toContain("budget is unknown");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: duplicate manifests claiming an evict target name are refused before credit, stop or start", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  saveWorkload(mkManifest("victim", { ram: 8 }), workloadsDir);
  const staged = saveModelHost(
    mkModelHostManifest("victim", { resources: { expectedMemoryGiB: 16 } }),
    join(temp.devStorage, "host-staging"),
  );
  const shadowPath = join(workloadsDir, "shadow.yaml");
  writeFileSync(shadowPath, readFileSync(staged));
  const shadowBefore = readFileSync(shadowPath, "utf8");
  const state: WorkloadStateMap = new Map([["victim", { up: true, rel: "victim.gguf", args: [] }]]);
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("incoming", {
        ram: 8,
        port: 8090,
        annotations: { "llamactl.io/evict": "victim" },
      }),
      () => client,
      undefined,
      undefined,
      { env, workloadsDir, getNodeBudgetGiB: () => 16 },
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictAmbiguousIdentity");
    expect(result.error).toContain("victim");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(readFileSync(shadowPath, "utf8")).toBe(shadowBefore);
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: force-admit cannot bypass an ambiguous duplicate evict identity", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  saveWorkload(mkManifest("victim", { ram: 8 }), workloadsDir);
  const staged = saveModelHost(
    mkModelHostManifest("victim", { resources: { expectedMemoryGiB: 16 } }),
    join(temp.devStorage, "host-staging"),
  );
  writeFileSync(join(workloadsDir, "shadow.yaml"), readFileSync(staged));
  const state: WorkloadStateMap = new Map([["victim", { up: true, rel: "victim.gguf", args: [] }]]);
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("incoming", {
        ram: 8,
        port: 8090,
        annotations: {
          "llamactl.io/evict": "victim",
          "llamactl.io/force-admit": "true",
        },
      }),
      () => client,
      undefined,
      undefined,
      { env, workloadsDir, getNodeBudgetGiB: () => 1 },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictAmbiguousIdentity");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: evict target whose canonical filename disagrees with metadata.name is refused", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  mkdirSync(workloadsDir, { recursive: true });
  const staged = saveWorkload(
    mkManifest("other-victim", { ram: 8 }),
    join(temp.devStorage, "staging"),
  );
  writeFileSync(join(workloadsDir, "victim.yaml"), readFileSync(staged));
  const state: WorkloadStateMap = new Map([["victim", { up: true, rel: "victim.gguf", args: [] }]]);
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("incoming", {
        ram: 8,
        port: 8090,
        annotations: { "llamactl.io/evict": "victim" },
      }),
      () => client,
      undefined,
      undefined,
      { env, workloadsDir, getNodeBudgetGiB: () => 16 },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictAmbiguousIdentity");
    expect(result.error).toContain("metadata.name");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: evict target owned by an unverifiable other node is refused before credit", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  saveWorkload(mkManifest("victim", { ram: 8, node: "other-node" }), workloadsDir);
  const state: WorkloadStateMap = new Map([["victim", { up: true, rel: "victim.gguf", args: [] }]]);
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("incoming", {
        ram: 8,
        port: 8090,
        annotations: { "llamactl.io/evict": "victim" },
      }),
      () => client,
      undefined,
      undefined,
      { env, workloadsDir, getNodeBudgetGiB: () => 16 },
    );
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictNodeUnverified");
    expect(result.error).toContain("other-node");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: a valid node alias for the evict target passes the identity guard through resolveNodeIdentity", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  saveWorkload(mkManifest("victim", { ram: 8, node: "mac-mini.local" }), workloadsDir);
  const state: WorkloadStateMap = new Map([["victim", { up: true, rel: "victim.gguf", args: [] }]]);
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("incoming", {
        ram: 8,
        port: 8090,
        node: "mac-mini",
        annotations: { "llamactl.io/evict": "victim" },
      }),
      () => client,
      undefined,
      undefined,
      {
        env,
        workloadsDir,
        getNodeBudgetGiB: () => 16,
        resolveNodeIdentity: (n) =>
          n === "mac-mini" || n === "mac-mini.local" ? "mac-mini" : null,
      },
    );
    expect(result.action).toBe("started");
    expect(stops).toEqual(["victim"]);
    expect(starts).toEqual(["incoming"]);
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: budget admission reads the env-scoped store, never the ambient process default", async () => {
  const scoped = makeTempRuntime();
  const ambient = makeTempRuntime();
  const scopedDir = join(scoped.devStorage, "workloads");
  const ambientDir = join(ambient.devStorage, "workloads");
  saveWorkload(mkManifest("victim", { ram: 8 }), scopedDir);
  saveWorkload(mkManifest("ambient-resident", { ram: 24 }), ambientDir);
  const env = { ...envForTemp(scoped), LLAMACTL_WORKLOADS_DIR: scopedDir };
  const state: WorkloadStateMap = new Map([["victim", { up: true, rel: "victim.gguf", args: [] }]]);
  const { client, stops, starts } = makeRecordingClient(state);
  const prevAmbient = process.env["LLAMACTL_WORKLOADS_DIR"];
  process.env["LLAMACTL_WORKLOADS_DIR"] = ambientDir;
  try {
    const result = await applyOne(
      mkManifest("incoming", {
        ram: 8,
        port: 8090,
        annotations: { "llamactl.io/evict": "victim" },
      }),
      () => client,
      undefined,
      undefined,
      { env, getNodeBudgetGiB: () => 16 },
    );
    expect(result.action).toBe("started");
    expect(stops).toEqual(["victim"]);
    expect(starts).toEqual(["incoming"]);
  } finally {
    if (prevAmbient === undefined) delete process.env["LLAMACTL_WORKLOADS_DIR"];
    else process.env["LLAMACTL_WORKLOADS_DIR"] = prevAmbient;
    scoped.cleanup();
    ambient.cleanup();
  }
});

test("DF-01A: port-collision preflight reads the env-scoped store, never the ambient process default", async () => {
  const scoped = makeTempRuntime();
  const ambient = makeTempRuntime();
  const scopedDir = join(scoped.devStorage, "workloads");
  saveWorkload(mkManifest("resident-port", { ram: 4, port: 8090 }), scopedDir);
  const env = { ...envForTemp(scoped), LLAMACTL_WORKLOADS_DIR: scopedDir };
  const state: WorkloadStateMap = new Map();
  const { client, starts } = makeRecordingClient(state);
  const prevAmbient = process.env["LLAMACTL_WORKLOADS_DIR"];
  process.env["LLAMACTL_WORKLOADS_DIR"] = join(ambient.devStorage, "workloads");
  try {
    const result = await applyOne(
      mkManifest("incoming", { ram: 4, port: 8090 }),
      () => client,
      undefined,
      undefined,
      {
        env,
        getNodeBudgetGiB: () => 32,
      },
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.conditions[0]?.reason).toBe("PortCollision");
    expect(starts).toEqual([]);
  } finally {
    if (prevAmbient === undefined) delete process.env["LLAMACTL_WORKLOADS_DIR"];
    else process.env["LLAMACTL_WORKLOADS_DIR"] = prevAmbient;
    scoped.cleanup();
    ambient.cleanup();
  }
});

test("DF-01A: ModelHost admission reads the env-scoped store, never the ambient process default", async () => {
  const scoped = makeTempRuntime();
  const ambient = makeTempRuntime();
  const scopedDir = join(scoped.devStorage, "workloads");
  const ambientDir = join(ambient.devStorage, "workloads");
  saveWorkload(mkManifest("ambient-resident", { ram: 24 }), ambientDir);
  const env = { ...envForTemp(scoped), LLAMACTL_WORKLOADS_DIR: scopedDir };
  const prevAmbient = process.env["LLAMACTL_WORKLOADS_DIR"];
  process.env["LLAMACTL_WORKLOADS_DIR"] = ambientDir;
  try {
    const result = await applyOneModelHost(
      mkModelHostManifest("mlx-env-host", { resources: { expectedMemoryGiB: 8 } }),
      () => makeModelHostClient(),
      undefined,
      { env, getNodeBudgetGiB: () => 16 },
    );
    expect(result.ok).toBe(true);
  } finally {
    if (prevAmbient === undefined) delete process.env["LLAMACTL_WORKLOADS_DIR"];
    else process.env["LLAMACTL_WORKLOADS_DIR"] = prevAmbient;
    scoped.cleanup();
    ambient.cleanup();
  }
});

test("DF-01A: matching running server with evict request keeps Running on budget refusal and reports the refusal", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  saveWorkload(mkManifest("resident-b", { ram: 16, port: 8182 }), workloadsDir);
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("a", { ram: 8, annotations: { "llamactl.io/evict": "ghost" } }),
      () => client,
      undefined,
      undefined,
      { env, workloadsDir, getNodeBudgetGiB: () => 20 },
    );
    expect(result.action).toBe("unchanged");
    expect(result.statusSection.phase).toBe("Running");
    expect(result.statusSection.serverPid).toBe(1);
    expect(result.statusSection.endpoint).toBe("http://127.0.0.1:8181");
    expect(result.error).toContain("eviction");
    expect(result.error).toContain("ghost");
    expect(result.statusSection.conditions.some((c) => c.type === "BudgetRefused")).toBe(true);
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: matching running server with refused evict keeps Running with EvictRefused condition", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  saveModelHost(
    mkModelHostManifest("resident-host", { resources: { expectedMemoryGiB: 24 } }),
    workloadsDir,
  );
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("a", { ram: 8, annotations: { "llamactl.io/evict": "resident-host" } }),
      () => client,
      undefined,
      undefined,
      { env, workloadsDir, getNodeBudgetGiB: () => 32 },
    );
    expect(result.action).toBe("unchanged");
    expect(result.statusSection.phase).toBe("Running");
    expect(result.statusSection.serverPid).toBe(1);
    expect(result.statusSection.endpoint).toBe("http://127.0.0.1:8181");
    expect(result.error).toContain("resident-host");
    const refused = result.statusSection.conditions.find((c) => c.type === "EvictRefused");
    expect(refused?.status).toBe("False");
    expect(refused?.reason).toBe("EvictKindUnsupported");
    expect(result.statusSection.conditions[0]?.reason).toBe("unchanged");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
  } finally {
    temp.cleanup();
  }
});

test("DF-01A: no-op apply of a matching running server keeps Running on an over-budget accounting", async () => {
  const temp = makeTempRuntime();
  const env = envForTemp(temp);
  const workloadsDir = join(temp.devStorage, "workloads");
  const state: WorkloadStateMap = new Map([["b", { up: true, rel: "b.gguf", args: [] }]]);
  const { client, stops, starts } = makeRecordingClient(state);
  try {
    const result = await applyOne(
      mkManifest("b", { ram: 8, node: "mac-mini" }),
      () => client,
      undefined,
      undefined,
      {
        env,
        workloadsDir,
        listManifests: () => [mkManifest("a", { ram: 8, node: "mac-mini" })],
        getNodeBudgetGiB: () => 10,
      },
    );
    expect(result.action).toBe("unchanged");
    expect(result.statusSection.phase).toBe("Running");
    expect(result.statusSection.serverPid).toBe(1);
    expect(result.statusSection.endpoint).toBe("http://127.0.0.1:8181");
    expect(result.error).toBeUndefined();
    const refusal = result.statusSection.conditions.find((c) => c.type === "BudgetRefused");
    expect(refusal?.reason).toBe("BudgetExceeded");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(state.has("b")).toBe(true);
  } finally {
    temp.cleanup();
  }
});

test("E-1: two aliases of one target with a 24 GiB budget admit exactly one of two 16 GiB loads while both starts are pending", async () => {
  const make = (remoteAdmission as Partial<typeof remoteAdmission>).createTargetAdmissionAuthority;
  const targetAdmission: TargetAdmissionAuthority | undefined = make?.();
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-e1-alias-"));
  const starts: string[] = [];
  const held: ServerStartCallbacks[] = [];
  const client: WorkloadClient = {
    ...makeClient(new Map<string, WorkloadState>()),
    serverStart: {
      subscribe: (input, callbacks): UnsubscribableLike => {
        starts.push(input.workload);
        held.push(callbacks);
        return { unsubscribe: () => undefined };
      },
    },
  };
  const opts = {
    workloadsDir,
    getNodeBudgetGiB: (): number => 24,
    listManifests: (): ModelRun[] => [],
    resolveNodeIdentity: (n: string): string | null =>
      n === "mac-mini" || n === "mac-mini.local" ? "mac-mini" : null,
    ...(targetAdmission ? { targetAdmission } : {}),
  };
  const settled: { name: string; result?: ApplyResult; error?: unknown }[] = [];
  const pa = applyOne(
    mkManifest("a", { port: 8090, ram: 16, node: "mac-mini" }),
    () => client,
    undefined,
    undefined,
    opts,
  );
  const pb = applyOne(
    mkManifest("b", { port: 8091, ram: 16, node: "mac-mini.local" }),
    () => client,
    undefined,
    undefined,
    opts,
  );
  void pa.then(
    (result) => settled.push({ name: "a", result }),
    (error: unknown) => settled.push({ name: "a", error }),
  );
  void pb.then(
    (result) => settled.push({ name: "b", result }),
    (error: unknown) => settled.push({ name: "b", error }),
  );
  let startsAtPeak: string[] = [];
  try {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && starts.length < 2 && settled.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    startsAtPeak = [...starts];
  } finally {
    for (const callbacks of held) {
      callbacks.onData({
        type: "done",
        result: { ok: true, pid: 100, endpoint: "http://127.0.0.1:8181" },
      });
      callbacks.onComplete();
    }
    await Promise.allSettled([pa, pb]);
    rmSync(workloadsDir, { recursive: true, force: true });
  }
  expect(startsAtPeak).toHaveLength(1);
  expect(settled.filter((s) => s.result?.action === "started")).toHaveLength(1);
  const pendingEntry = settled.find((s) => s.result?.action === "pending");
  expect(pendingEntry).toBeDefined();
  expect(startsAtPeak).not.toContain(pendingEntry!.name);
  expect(pendingEntry!.result!.statusSection.phase).toBe("Failed");
  expect(pendingEntry!.result!.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
  expect(pendingEntry!.result!.error).toContain("mac-mini");
  const snapshot = targetAdmission!.snapshot("mac-mini");
  expect(snapshot).toHaveLength(1);
  expect(snapshot[0]?.state).toBe("resident");
  expect(snapshot[0]?.allocationGiB).toBe(16);
});

test("E-1: llamactl.io/force-admit does not bypass the target authority", async () => {
  const make = (remoteAdmission as Partial<typeof remoteAdmission>).createTargetAdmissionAuthority;
  const targetAdmission: TargetAdmissionAuthority | undefined = make?.();
  const state: WorkloadStateMap = new Map();
  const { client, starts } = makeRecordingClient(state);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-e1-force-"));
  try {
    const opts = {
      workloadsDir,
      getNodeBudgetGiB: (): number => 24,
      listManifests: (): ModelRun[] => [],
      resolveNodeIdentity: (n: string): string | null =>
        n === "mac-mini" || n === "mac-mini.local" ? "mac-mini" : null,
      ...(targetAdmission ? { targetAdmission } : {}),
    };
    await applyOne(
      mkManifest("a", { port: 8090, ram: 16, node: "mac-mini" }),
      () => client,
      undefined,
      undefined,
      opts,
    );
    const refused = await applyOne(
      mkManifest("b", {
        port: 8091,
        ram: 16,
        node: "mac-mini.local",
        annotations: { "llamactl.io/force-admit": "true" },
      }),
      () => client,
      undefined,
      undefined,
      opts,
    );
    expect(starts).toEqual(["a"]);
    expect(refused.action).toBe("pending");
    expect(refused.statusSection.phase).toBe("Failed");
    expect(refused.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("E-1: a claim never stays pending when the start path throws", async () => {
  const make = (remoteAdmission as Partial<typeof remoteAdmission>).createTargetAdmissionAuthority;
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-e1-throw-"));
  try {
    const targetAdmission: TargetAdmissionAuthority | undefined = make?.();
    const baseOpts = {
      workloadsDir,
      getNodeBudgetGiB: (): number => 24,
      listManifests: (): ModelRun[] => [],
      resolveNodeIdentity: (n: string): string | null =>
        n === "mac-mini" || n === "mac-mini.local" ? "mac-mini" : null,
    };
    const opts = {
      ...baseOpts,
      ...(targetAdmission ? { targetAdmission } : {}),
    };
    const stateC: WorkloadStateMap = new Map([["c", { up: true, rel: "old.gguf", args: [] }]]);
    const recordingC = makeRecordingClient(stateC);
    const clientC: WorkloadClient = {
      ...recordingC.client,
      serverStop: { mutate: () => Promise.reject(new Error("stop boom")) },
    };
    await expect(
      applyOne(
        mkManifest("c", { ram: 16, node: "mac-mini" }),
        () => clientC,
        undefined,
        undefined,
        opts,
      ),
    ).rejects.toThrow("stop boom");
    expect(targetAdmission?.snapshot("mac-mini").filter((x) => x.state === "pending")).toEqual([]);
    expect(targetAdmission?.snapshot("mac-mini").map((x) => x.state)).toEqual(["uncertain"]);

    const targetAdmission2: TargetAdmissionAuthority | undefined = make?.();
    const opts2 = {
      ...baseOpts,
      ...(targetAdmission2 ? { targetAdmission: targetAdmission2 } : {}),
    };
    const { client: clientD } = makeRecordingClient(new Map<string, WorkloadState>());
    await expect(
      applyOne(
        mkManifest("d", { ram: 16, node: "mac-mini" }),
        () => clientD,
        (e): void => {
          if (e.type === "start") throw new Error("event boom");
        },
        undefined,
        opts2,
      ),
    ).rejects.toThrow("event boom");
    expect(targetAdmission2?.snapshot("mac-mini")).toEqual([]);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("E-1: resident claims are absorbing in this slice (pins the deferred-replacement limitation)", async () => {
  const make = (remoteAdmission as Partial<typeof remoteAdmission>).createTargetAdmissionAuthority;
  const targetAdmission: TargetAdmissionAuthority | undefined = make?.();
  const m: WorkloadStateMap = new Map();
  const { client, starts } = makeRecordingClient(m);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-e1-resident-"));
  try {
    const opts = {
      workloadsDir,
      getNodeBudgetGiB: (): number => 24,
      listManifests: (): ModelRun[] => [],
      resolveNodeIdentity: (n: string): string | null =>
        n === "mac-mini" || n === "mac-mini.local" ? "mac-mini" : null,
      ...(targetAdmission ? { targetAdmission } : {}),
    };
    const manifest = mkManifest("a", { ram: 16, node: "mac-mini" });
    const first = await applyOne(manifest, () => client, undefined, undefined, opts);
    expect(first.action).toBe("started");
    m.delete("a");
    const second = await applyOne(manifest, () => client, undefined, undefined, opts);
    expect(starts).toEqual(["a"]);
    expect(second.action).toBe("pending");
    expect(second.statusSection.phase).toBe("Failed");
    expect(second.statusSection.conditions[0]?.reason).toBe("AlreadyResident");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("E-1: committed manifests charge the target ledger so two aliases admit exactly one load", async () => {
  const make = (remoteAdmission as Partial<typeof remoteAdmission>).createTargetAdmissionAuthority;
  const targetAdmission: TargetAdmissionAuthority | undefined = make?.();
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-e1-living-"));
  const starts: string[] = [];
  const held: ServerStartCallbacks[] = [];
  const client: WorkloadClient = {
    ...makeClient(new Map<string, WorkloadState>()),
    serverStart: {
      subscribe: (input, callbacks): UnsubscribableLike => {
        starts.push(input.workload);
        held.push(callbacks);
        return { unsubscribe: () => undefined };
      },
    },
  };
  const opts = {
    workloadsDir,
    getNodeBudgetGiB: (): number => 20,
    listManifests: (): ModelRun[] => [mkManifest("resident", { ram: 8, node: "mac-mini.local" })],
    resolveNodeIdentity: (n: string): string | null =>
      n === "mac-mini" || n === "mac-mini.local" ? "mac-mini" : null,
    ...(targetAdmission ? { targetAdmission } : {}),
  };
  const settled: { name: string; result?: ApplyResult; error?: unknown }[] = [];
  const pa = applyOne(
    mkManifest("a", { port: 8090, ram: 8, node: "mac-mini" }),
    () => client,
    undefined,
    undefined,
    opts,
  );
  const pb = applyOne(
    mkManifest("b", { port: 8091, ram: 8, node: "mac-mini.local" }),
    () => client,
    undefined,
    undefined,
    opts,
  );
  void pa.then(
    (result) => settled.push({ name: "a", result }),
    (error: unknown) => settled.push({ name: "a", error }),
  );
  void pb.then(
    (result) => settled.push({ name: "b", result }),
    (error: unknown) => settled.push({ name: "b", error }),
  );
  let startsAtPeak: string[] = [];
  try {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && starts.length < 1 && settled.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    startsAtPeak = [...starts];
  } finally {
    for (const callbacks of held) {
      callbacks.onData({
        type: "done",
        result: { ok: true, pid: 100, endpoint: "http://127.0.0.1:8181" },
      });
      callbacks.onComplete();
    }
    await Promise.allSettled([pa, pb]);
    rmSync(workloadsDir, { recursive: true, force: true });
  }
  // 8 GiB living + the winner's 8 GiB pending claim leaves no room for the
  // second 8 GiB load: 8 + 8 + 8 > 20 GiB.
  expect(startsAtPeak).toHaveLength(1);
  expect(settled.filter((s) => s.result?.action === "started")).toHaveLength(1);
  const pendingEntry = settled.find((s) => s.result?.action === "pending");
  expect(pendingEntry).toBeDefined();
  expect(startsAtPeak).not.toContain(pendingEntry!.name);
  expect(pendingEntry!.result!.statusSection.phase).toBe("Failed");
  expect(pendingEntry!.result!.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
  expect(pendingEntry!.result!.error).toContain("mac-mini");
  const snapshot = targetAdmission!.snapshot("mac-mini");
  expect(snapshot).toHaveLength(1);
  expect(snapshot[0]?.state).toBe("resident");
  expect(snapshot[0]?.allocationGiB).toBe(8);
});

test("E-1: a worker-start failure releases the target claim so a later load can use the capacity", async () => {
  const make = (remoteAdmission as Partial<typeof remoteAdmission>).createTargetAdmissionAuthority;
  const targetAdmission: TargetAdmissionAuthority | undefined = make?.();
  const state: WorkloadStateMap = new Map();
  const base = makeClient(state);
  const client: WorkloadClient = {
    ...base,
    rpcServerStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: { ok: false, error: "rpc boom" } });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
  };
  const workerManifest = mkManifest("w", { ram: 8 });
  workerManifest.spec.workers = [
    { node: "w1", rpcHost: "127.0.0.1", rpcPort: 5001, extraArgs: [], timeoutSeconds: 5 },
  ];
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-e1-workerfail-"));
  try {
    const opts = {
      workloadsDir,
      getNodeBudgetGiB: (): number => 12,
      listManifests: (): ModelRun[] => [],
      ...(targetAdmission ? { targetAdmission } : {}),
    };
    const failed = await applyOne(workerManifest, () => client, undefined, undefined, opts);
    expect(failed.statusSection.phase).toBe("Failed");
    expect(failed.error).toContain("worker w1");
    expect(state.has("w")).toBe(false);
    expect(targetAdmission?.snapshot("local")).toEqual([]);

    const later = await applyOne(
      mkManifest("x", { port: 8090, ram: 8 }),
      () => client,
      undefined,
      undefined,
      opts,
    );
    expect(later.action).toBe("started");
    expect(state.has("x")).toBe(true);
    expect(targetAdmission?.snapshot("local")).toHaveLength(1);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("E-1: specDigestFor includes args so reconfiguring ONLY args on a held runtimeKey returns WorkloadBusy", async () => {
  const targetAdmission: TargetAdmissionAuthority = createTargetAdmissionAuthority();
  const state: WorkloadStateMap = new Map();
  const { client } = makeRecordingClient(state);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-e1-specdigest-"));
  try {
    const opts = {
      workloadsDir,
      getNodeBudgetGiB: (): number => 24,
      listManifests: (): ModelRun[] => [],
      resolveNodeIdentity: (n: string): string | null =>
        n === "mac-mini" || n === "mac-mini.local" ? "mac-mini" : null,
      targetAdmission,
    };
    // First, apply a manifest with no extra args — this creates a pending
    // claim with specDigest based on [].
    const manifest1 = mkManifest("a", { ram: 8, node: "mac-mini" });
    const first = await applyOne(manifest1, () => client, undefined, undefined, opts);
    expect(first.action).toBe("started");
    // The pending claim holds runtimeKey "a" with specDigest =
    // JSON.stringify(["rel", "x.gguf", []]).
    // Now apply a second manifest "a" with different args — same runtimeKey
    // but different specDigest (args differ). This should be WorkloadBusy.
    const manifest2 = mkManifest("a", { ram: 8, node: "mac-mini" });
    manifest2.spec.extraArgs = ["--some-arg"];
    const second = await applyOne(manifest2, () => client, undefined, undefined, opts);
    expect(second.action).toBe("pending");
    expect(second.statusSection.phase).toBe("Failed");
    expect(second.statusSection.conditions[0]?.reason).toBe("WorkloadBusy");
    expect(second.error).toContain("mac-mini");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("E-1: a no-op apply of a matching running server bypasses the target ledger", async () => {
  const make = (remoteAdmission as Partial<typeof remoteAdmission>).createTargetAdmissionAuthority;
  const targetAdmission: TargetAdmissionAuthority | undefined = make?.();
  const state: WorkloadStateMap = new Map();
  const { client, starts } = makeRecordingClient(state);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-e1-noop-"));
  try {
    const opts = {
      workloadsDir,
      getNodeBudgetGiB: (): number => 20,
      listManifests: (): ModelRun[] => [],
      ...(targetAdmission ? { targetAdmission } : {}),
    };
    const manifest = mkManifest("a", { ram: 8 });
    const first = await applyOne(manifest, () => client, undefined, undefined, opts);
    expect(first.action).toBe("started");
    expect(targetAdmission?.snapshot("local")).toHaveLength(1);

    // The resident claim would answer already-resident if the ledger were
    // consulted; the matching-server bypass must keep this a no-op.
    const second = await applyOne(manifest, () => client, undefined, undefined, opts);
    expect(second.action).toBe("unchanged");
    expect(second.statusSection.phase).toBe("Running");
    expect(second.statusSection.serverPid).toBe(1);
    expect(second.error).toBeUndefined();
    expect(starts).toEqual(["a"]);
    expect(targetAdmission?.snapshot("local")).toHaveLength(1);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("#520: evict is refused while the session gate reports an active session", async () => {
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-evict-session-"));
  saveWorkload(mkManifest("a"), workloadsDir);
  const { client, stops, starts } = makeRecordingClient(state);
  const calls: string[] = [];
  const opts = {
    workloadsDir,
    getNodeBudgetGiB: (): number => 32,
    sessionGate: makeSessionGate((workload) => {
      calls.push(workload);
      return { ok: false, reason: "SessionActive", sessions: ["sess-1"] };
    }),
  };
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      opts,
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictSessionActive");
    expect(result.error).toMatch(/sess-1/);
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(calls).toEqual(["a"]);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("#520: a clean session gate lets eviction proceed after authorize and pre-stop checks", async () => {
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-evict-session-ok-"));
  saveWorkload(mkManifest("a"), workloadsDir);
  const { client, stops, starts } = makeRecordingClient(state);
  const calls: string[] = [];
  const opts = {
    workloadsDir,
    getNodeBudgetGiB: (): number => 32,
    sessionGate: makeSessionGate((workload) => {
      calls.push(workload);
      return { ok: true, released: [] };
    }),
  };
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      opts,
    );
    expect(result.action).toBe("started");
    expect(stops).toEqual(["a"]);
    expect(starts).toEqual(["b"]);
    expect(calls).toEqual(["a", "a"]);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("#520: a throwing session gate fails closed as EvictSessionUnknown", async () => {
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-evict-session-throw-"));
  saveWorkload(mkManifest("a"), workloadsDir);
  const { client, stops, starts } = makeRecordingClient(state);
  const calls: string[] = [];
  const opts = {
    workloadsDir,
    getNodeBudgetGiB: (): number => 32,
    sessionGate: makeSessionGate((workload) => {
      calls.push(workload);
      throw new Error("session gate exploded");
    }),
  };
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      opts,
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictSessionUnknown");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(calls).toEqual(["a"]);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("#520: a refused session on any evict target stops the whole eviction", async () => {
  const state: WorkloadStateMap = new Map([
    ["a", { up: true, rel: "a.gguf", args: [] }],
    ["c", { up: true, rel: "c.gguf", args: [] }],
  ]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-evict-session-multi-"));
  saveWorkload(mkManifest("a"), workloadsDir);
  saveWorkload(mkManifest("c", { port: 8182 }), workloadsDir);
  const { client, stops, starts } = makeRecordingClient(state);
  const calls: string[] = [];
  const opts = {
    workloadsDir,
    getNodeBudgetGiB: (): number => 32,
    sessionGate: makeSessionGate((workload) => {
      calls.push(workload);
      if (workload === "c") {
        return { ok: false, reason: "SessionActive", sessions: ["sess-c"] };
      }
      return { ok: true, released: [] };
    }),
  };
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a,c" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      opts,
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictSessionActive");
    expect(result.error).toContain("sess-c");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(calls).toContain("c");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("#520: a session appearing after authorization is caught by the pre-stop re-check", async () => {
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-evict-session-late-"));
  saveWorkload(mkManifest("a"), workloadsDir);
  const { client, stops, starts } = makeRecordingClient(state);
  const calls: string[] = [];
  let gateCalls = 0;
  const opts = {
    workloadsDir,
    getNodeBudgetGiB: (): number => 32,
    sessionGate: makeSessionGate((workload) => {
      calls.push(workload);
      gateCalls += 1;
      if (gateCalls === 1) {
        return { ok: true, released: [] };
      }
      return { ok: false, reason: "SessionActive", sessions: ["late-1"] };
    }),
  };
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      opts,
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictSessionActive");
    expect(result.error).toMatch(/late-1/);
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(calls).toEqual(["a", "a"]);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("#520: the pre-stop re-check covers every evict target, not just the first", async () => {
  const state: WorkloadStateMap = new Map([
    ["a", { up: true, rel: "a.gguf", args: [] }],
    ["c", { up: true, rel: "c.gguf", args: [] }],
  ]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-evict-session-late-multi-"));
  saveWorkload(mkManifest("a"), workloadsDir);
  saveWorkload(mkManifest("c", { port: 8182 }), workloadsDir);
  const { client, stops, starts } = makeRecordingClient(state);
  const calls: string[] = [];
  const callsPerTarget = new Map<string, number>();
  const opts = {
    workloadsDir,
    getNodeBudgetGiB: (): number => 32,
    sessionGate: makeSessionGate((workload) => {
      calls.push(workload);
      const seen = (callsPerTarget.get(workload) ?? 0) + 1;
      callsPerTarget.set(workload, seen);
      // 'c' looks clean during authorization, then a late session appears
      // just in time for the pre-stop re-check.
      if (workload === "c" && seen >= 2) {
        return { ok: false, reason: "SessionActive", sessions: ["late-c"] };
      }
      return { ok: true, released: [] };
    }),
  };
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a,c" }, port: 8090 }),
      () => client,
      undefined,
      undefined,
      opts,
    );
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictSessionActive");
    expect(result.error).toContain("late-c");
    expect(result.error).toContain("'c'");
    expect(stops).toEqual([]);
    expect(starts).toEqual([]);
    expect(calls).toEqual(["a", "c", "a", "c"]);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

// DF-02 (#275): verified eviction. Every victim manifest is saved into
// workloadsDir so authorizeEvictTargets verifies it, and each victim gets a
// port distinct from the incoming 8090 so checkPortCollision cannot
// short-circuit the apply.
test("DF-02: a refused evict stop fails the apply before the replacement starts", async () => {
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df02-stop-refused-"));
  saveWorkload(mkManifest("a", { port: 8182 }), workloadsDir);
  const { client, stops, starts } = makeEvictFaultClient(state, {
    stop: (workload) => (workload === "a" ? Promise.resolve({ stopped: false }) : undefined),
  });
  const { events, onEvent } = makeEventRecorder();
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      onEvent,
      undefined,
      { workloadsDir, getNodeBudgetGiB: () => 32 },
    );
    expect(starts).toEqual([]);
    expect(stops).toEqual(["a"]);
    expect(state.has("a")).toBe(true);
    expect(state.has("b")).toBe(false);
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictStopRefused");
    expect(result.error).toMatch(/evict/i);
    expect(result.error).toContain("a");
    expect(events.some((e) => e.message.includes("a not found"))).toBe(false);
    expect(events.some((e) => e.type === "evict-failed")).toBe(true);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-02: a throwing evict stop fails the apply with EvictStopFailed", async () => {
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df02-stop-threw-"));
  saveWorkload(mkManifest("a", { port: 8182 }), workloadsDir);
  const { client, stops, starts } = makeEvictFaultClient(state, {
    stop: (workload) => (workload === "a" ? Promise.reject(new Error("rpc boom")) : undefined),
  });
  const { onEvent } = makeEventRecorder();
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      onEvent,
      undefined,
      { workloadsDir, getNodeBudgetGiB: () => 32 },
    );
    expect(starts).toEqual([]);
    expect(stops).toEqual(["a"]);
    expect(state.has("a")).toBe(true);
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictStopFailed");
    expect(result.error).toMatch(/evict/i);
    expect(result.error).toContain("rpc boom");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-02: an evict stop that leaves the victim up fails with EvictReleaseUnverified", async () => {
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df02-release-unverified-"));
  saveWorkload(mkManifest("a", { port: 8182 }), workloadsDir);
  const { client, stops, starts } = makeEvictFaultClient(state, {
    // stopped:true, but "a" stays in state so the follow-up status still says up.
    stop: (workload) => (workload === "a" ? Promise.resolve({ stopped: true }) : undefined),
  });
  const { onEvent } = makeEventRecorder();
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      onEvent,
      undefined,
      { workloadsDir, getNodeBudgetGiB: () => 32 },
    );
    expect(starts).toEqual([]);
    expect(stops).toEqual(["a"]);
    expect(state.has("a")).toBe(true);
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictReleaseUnverified");
    expect(result.error).toMatch(/evict/i);
    expect(result.error).toContain("a");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-02: an unreadable evict target status fails with EvictStatusUnknown", async () => {
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df02-status-unknown-"));
  saveWorkload(mkManifest("a", { port: 8182 }), workloadsDir);
  const { client, stops, starts } = makeEvictFaultClient(state, {
    status: (workload) =>
      workload === "a" ? Promise.reject(new Error("status rpc boom")) : undefined,
  });
  const { onEvent } = makeEventRecorder();
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      onEvent,
      undefined,
      { workloadsDir, getNodeBudgetGiB: () => 32 },
    );
    expect(starts).toEqual([]);
    expect(stops).toEqual([]);
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictStatusUnknown");
    expect(result.error).toMatch(/evict/i);
    expect(result.error).toContain("a");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-02: EvictStatusUnknown releases the claim and a healthy retry starts", async () => {
  const targetAdmission = createTargetAdmissionAuthority();
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df02-claim-release-"));
  saveWorkload(mkManifest("a", { port: 8182 }), workloadsDir);
  const failing = makeEvictFaultClient(state, {
    status: (workload) =>
      workload === "a" ? Promise.reject(new Error("status rpc boom")) : undefined,
  });
  const incoming = mkManifest("b", {
    annotations: { "llamactl.io/evict": "a" },
    port: 8090,
  });
  const { onEvent } = makeEventRecorder();
  const opts = { workloadsDir, getNodeBudgetGiB: (): number => 32, targetAdmission };
  try {
    const result = await applyOne(incoming, () => failing.client, onEvent, undefined, opts);
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictStatusUnknown");
    expect(result.error).toMatch(/evict/i);
    expect(failing.starts).toEqual([]);
    expect(failing.stops).toEqual([]);
    // Nothing destructive ran, so the claim was released, not marked uncertain.
    expect(targetAdmission.snapshot("local")).toHaveLength(0);

    const healthy = makeRecordingClient(state);
    const retry = await applyOne(incoming, () => healthy.client, undefined, undefined, opts);
    expect(retry.action).toBe("started");
    expect(healthy.starts).toContain("b");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-02: a refused evict stop marks the admission claim uncertain", async () => {
  const targetAdmission = createTargetAdmissionAuthority();
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df02-claim-uncertain-"));
  saveWorkload(mkManifest("a", { port: 8182 }), workloadsDir);
  const { client, stops, starts } = makeEvictFaultClient(state, {
    stop: (workload) => (workload === "a" ? Promise.resolve({ stopped: false }) : undefined),
  });
  const { onEvent } = makeEventRecorder();
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      onEvent,
      undefined,
      { workloadsDir, getNodeBudgetGiB: () => 32, targetAdmission },
    );
    expect(starts).toEqual([]);
    expect(stops).toEqual(["a"]);
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictStopRefused");
    const snapshot = targetAdmission.snapshot("local");
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.state).toBe("uncertain");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-02: the first failed evict stop leaves later victims untouched", async () => {
  const state: WorkloadStateMap = new Map([
    ["a", { up: true, rel: "a.gguf", args: [] }],
    ["v2", { up: true, rel: "v2.gguf", args: [] }],
  ]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df02-multi-victim-"));
  saveWorkload(mkManifest("a", { port: 8182 }), workloadsDir);
  saveWorkload(mkManifest("v2", { port: 8183 }), workloadsDir);
  const { client, stops, starts } = makeEvictFaultClient(state, {
    stop: (workload) => (workload === "a" ? Promise.resolve({ stopped: false }) : undefined),
  });
  const { onEvent } = makeEventRecorder();
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a,v2" }, port: 8090 }),
      () => client,
      onEvent,
      undefined,
      { workloadsDir, getNodeBudgetGiB: () => 32 },
    );
    expect(stops).toEqual(["a"]);
    expect(starts).toEqual([]);
    expect(state.has("v2")).toBe(true);
    expect(state.has("b")).toBe(false);
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictStopRefused");
    expect(result.error).toMatch(/evict/i);
    expect(result.error).toContain("a");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-02: a failed evict on a matching running server reports EvictFailed and stays Running", async () => {
  const state: WorkloadStateMap = new Map([
    ["a", { up: true, rel: "a.gguf", args: [] }],
    ["v", { up: true, rel: "v.gguf", args: [] }],
  ]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df02-matching-evict-"));
  saveWorkload(mkManifest("v", { port: 8182 }), workloadsDir);
  const { client, stops, starts } = makeEvictFaultClient(state, {
    stop: (workload) => (workload === "v" ? Promise.resolve({ stopped: false }) : undefined),
  });
  const { onEvent } = makeEventRecorder();
  try {
    const result = await applyOne(
      mkManifest("a", { annotations: { "llamactl.io/evict": "v" } }),
      () => client,
      onEvent,
      undefined,
      { workloadsDir, getNodeBudgetGiB: () => 32 },
    );
    expect(stops).toEqual(["v"]);
    expect(starts).toEqual([]);
    expect(result.action).toBe("unchanged");
    expect(result.statusSection.phase).toBe("Running");
    expect(result.error).toMatch(/evict/i);
    const evictFailed = result.statusSection.conditions.find((c) => c.type === "EvictFailed");
    expect(evictFailed?.status).toBe("False");
    expect(evictFailed?.reason).toBe("EvictStopRefused");
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-02: an evict stop past its deadline fails with EvictStopTimedOut", async () => {
  const state: WorkloadStateMap = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df02-stop-timeout-"));
  saveWorkload(mkManifest("a", { port: 8182 }), workloadsDir);
  const { client, stops, starts } = makeEvictFaultClient(state, {
    stop: (workload) =>
      workload === "a"
        ? new Promise((resolve) => {
            setTimeout(() => {
              state.delete("a");
              resolve({ stopped: true });
            }, 200);
          })
        : undefined,
  });
  const { onEvent } = makeEventRecorder();
  const opts = {
    workloadsDir,
    getNodeBudgetGiB: (): number => 32,
    evictStopTimeoutMs: 25,
  };
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      onEvent,
      undefined,
      opts,
    );
    expect(starts).toEqual([]);
    expect(stops).toEqual(["a"]);
    expect(state.has("b")).toBe(false);
    expect(result.action).toBe("pending");
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("EvictStopTimedOut");
    expect(result.error).toMatch(/evict/i);
  } finally {
    // The 200ms stop resolves after the 25ms deadline; let it drain.
    await new Promise((resolve) => setTimeout(resolve, 250));
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});

test("DF-02: an evict victim already down is skipped without a stop call", async () => {
  const state: WorkloadStateMap = new Map();
  const workloadsDir = mkdtempSync(join(tmpdir(), "llamactl-df02-victim-down-"));
  saveWorkload(mkManifest("a", { port: 8182 }), workloadsDir);
  const { client, stops, starts } = makeRecordingClient(state);
  const { onEvent } = makeEventRecorder();
  try {
    const result = await applyOne(
      mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
      () => client,
      onEvent,
      undefined,
      { workloadsDir, getNodeBudgetGiB: () => 32 },
    );
    expect(result.action).toBe("started");
    expect(stops).toEqual([]);
    expect(starts).toEqual(["b"]);
    expect(state.has("b")).toBe(true);
  } finally {
    rmSync(workloadsDir, { recursive: true, force: true });
  }
});
