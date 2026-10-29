import { readModelHostState, writeModelHostState } from "@llamactl/core/engines/state";
import { resolveEnv } from "@llamactl/core/env";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelHostManifest } from "./modelhost-schema.js";
import type { ModelRun } from "./schema.js";

import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "../safe-fs.js";
import { applyOne, applyOneModelHost, type WorkloadClient } from "./apply.js";
import { saveModelHost } from "./modelhost-store.js";
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
  const result = await applyOne(
    mkManifest("b", { annotations: { "llamactl.io/evict": "a" }, port: 8090 }),
    () => makeClient(state),
    undefined,
    undefined,
    { listManifests: () => [mkManifest("a")], getNodeBudgetGiB: () => 32 },
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
    applyOne(mfA, slowClient, undefined, undefined, {
      listManifests: () => [],
      getNodeBudgetGiB: () => 32,
    }),
    applyOne(mfB, slowClient, undefined, undefined, {
      listManifests: () => [],
      getNodeBudgetGiB: () => 32,
    }),
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
  const result = await applyOne(
    mkManifest("b", { port: 8090, ram: 8, node: "mac-mini" }),
    () => makeClient(state),
    undefined,
    undefined,
    {
      getNodeBudgetGiB: () => 10,
      listManifests: () => [mkManifest("a", { ram: 8, node: "mac-mini.local" })],
      resolveNodeIdentity: (n) => (n === "mac-mini" || n === "mac-mini.local" ? "mac-mini" : null),
    },
  );
  expect(result.action).toBe("pending");
  expect(result.statusSection.conditions[0]?.reason).toBe("BudgetExceeded");
});

test("DF-01: an unverifiable remote budget refuses instead of admitting unlimited", async () => {
  const state: WorkloadStateMap = new Map();
  const result = await applyOne(
    mkManifest("b", { port: 8090, ram: 8, node: "mac-mini" }),
    () => makeClient(state),
    undefined,
    undefined,
    { listManifests: () => [] },
  );
  expect(result.action).toBe("pending");
  expect(result.statusSection.conditions[0]?.reason).toBe("BudgetUnknown");
  expect(result.error).toContain("budget is unknown");
});

test("DF-01: a zero-declared workload passes admission even with an unknown budget", async () => {
  const state: WorkloadStateMap = new Map();
  const result = await applyOne(
    mkManifest("b", { port: 8090, ram: 0, node: "mac-mini" }),
    () => makeClient(state),
    undefined,
    undefined,
    { listManifests: () => [] },
  );
  expect(result.action).toBe("started");
  const reserved = result.statusSection.conditions.find((c) => c.type === "BudgetReserved");
  expect(reserved?.message).toContain("unknown");
  expect(reserved?.message).not.toContain("unbounded");
});
