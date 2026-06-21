import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelHostManifest } from "./modelhost-schema.js";
import type { ModelRun } from "./schema.js";

import { readModelHostState, writeModelHostState } from "../../../core/src/engines/state.js";
import { resolveEnv } from "../../../core/src/env.js";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "../safe-fs.js";
import { applyOne, applyOneModelHost, type WorkloadClient } from "./apply.js";
import { saveWorkload } from "./store.js";

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

test("disabled manifest stops the server if running and reports Disabled", async () => {
  const state = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const result = await applyOne(mkManifest("a", { enabled: false }), () => makeClient(state));
  expect(result.statusSection.phase).toBe("Stopped");
  expect(result.statusSection.conditions[0]?.reason).toBe("Disabled");
  expect(state.has("a")).toBe(false);
});

test("parallel apply does not stop other workloads on the node", async () => {
  const state = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const result = await applyOne(mkManifest("b", { port: 8090 }), () => makeClient(state));
  expect(state.has("a")).toBe(true);
  expect(state.has("b")).toBe(true);
  expect(result.action).toBe("started");
});

test("evict annotation stops named workload before starting incoming", async () => {
  const state = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const result = await applyOne(
    mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
    () => makeClient(state),
    undefined,
    undefined,
    { listManifests: () => [mkManifest("a")] },
  );
  expect(state.has("a")).toBe(false);
  expect(state.has("b")).toBe(true);
  expect(result.action).toBe("started");
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
  const result = await applyOne(
    mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090, ram: 8 }),
    () => makeClient(state),
    undefined,
    undefined,
    {
      getNodeBudgetGiB: () => 10,
      listManifests: () => [mkManifest("a", { ram: 8 }), mkManifest("c", { ram: 8 })],
    },
  );
  expect(result.action).toBe("pending");
  expect(result.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
  // The victim must still be running — a rejected workload may not
  // evict anything.
  expect(state.has("a")).toBe(true);
  expect(state.has("b")).toBe(false);
});

test("budget overflow returns pending with BudgetExceeded unless force-admit", async () => {
  const state = new Map([["a", { up: true, rel: "a.gguf", args: [] }]]);
  const result = await applyOne(
    mkManifest("b", { port: 8090, ram: 8 }),
    () => makeClient(state),
    undefined,
    undefined,
    { getNodeBudgetGiB: () => 10, listManifests: () => [mkManifest("a", { ram: 8 })] },
  );
  expect(result.action).toBe("pending");
  expect(result.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
});

test("force-admit annotation bypasses the budget check", async () => {
  const state: WorkloadStateMap = new Map();
  const result = await applyOne(
    mkManifest("b", { annotations: { "llamactl.io/force-admit": "true" }, ram: 30, port: 8090 }),
    () => makeClient(state),
    undefined,
    undefined,
    { getNodeBudgetGiB: () => 1, listManifests: () => [] },
  );
  expect(result.action).toBe("started");
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
  await Promise.all([
    applyOne(mfA, slowClient, undefined, undefined, { listManifests: () => [] }),
    applyOne(mfB, slowClient, undefined, undefined, { listManifests: () => [] }),
  ]);
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
