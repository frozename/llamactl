import {
  readControllerHostHistory,
  updateControllerHostHistory,
} from "@llamactl/core/engines/conditions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkloadClient } from "../src/workload/apply.js";

import { router } from "../src/router.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { parseModelHost, saveModelHost } from "../src/workload/modelhost-store.js";
import { reconcileOnce } from "../src/workload/reconciler.js";
import {
  deleteWorkload,
  parseWorkload,
  saveWorkload,
  workloadPath,
} from "../src/workload/store.js";

const modelHostYaml = `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: mlx-host
spec:
  engine: omlx
  node: local
  enabled: true
  binary: /usr/bin/omlx
  endpoint:
    host: 127.0.0.1
    port: 8094
  hostedModels:
    - rel: Qwen3-8B-MLX-4bit
`;

const remoteModelHostYaml = `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: z13-host
spec:
  engine: omlx
  node: gpu1
  enabled: true
  binary: /usr/bin/omlx
  endpoint:
    host: 127.0.0.1
    port: 8094
  hostedModels:
    - rel: Qwen3-8B-MLX-4bit
`;

const modelRunYaml = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: gemma-solo
spec:
  node: local
  target:
    kind: rel
    value: gemma.gguf
`;

let tmp = "";
let runtimeDir = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-workload-delete-"));
  runtimeDir = join(tmp, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: tmp,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    // A missing config file gives a fresh config whose `local` node is the
    // in-proc caller, so stops run against the temp runtime dir.
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

function hostRuntimeDir(): string {
  return join(runtimeDir, "workloads", "mlx-host");
}

describe("workloadDelete", () => {
  test("stops a ModelHost, then removes its manifest and runtime dir", async () => {
    saveModelHost(parseModelHost(modelHostYaml), tmp);
    mkdirSync(hostRuntimeDir(), { recursive: true });
    writeFileSync(join(hostRuntimeDir(), "leftover.log"), "x\n");

    const result = await router.createCaller({}).workloadDelete({ name: "mlx-host" });

    expect(result).toEqual({
      ok: true,
      name: "mlx-host",
      stops: ["stopped modelhost on local"],
    });
    expect(existsSync(workloadPath("mlx-host", tmp))).toBe(false);
    expect(existsSync(hostRuntimeDir())).toBe(false);
  });

  test("keepRunning removes only the ModelHost manifest", async () => {
    saveModelHost(parseModelHost(modelHostYaml), tmp);
    mkdirSync(hostRuntimeDir(), { recursive: true });

    const result = await router
      .createCaller({})
      .workloadDelete({ name: "mlx-host", keepRunning: true });

    expect(result).toEqual({ ok: true, name: "mlx-host", stops: [] });
    expect(existsSync(workloadPath("mlx-host", tmp))).toBe(false);
    expect(existsSync(hostRuntimeDir())).toBe(true);
  });

  test("still deletes a ModelRun manifest", async () => {
    saveWorkload(parseWorkload(modelRunYaml), tmp);

    const result = await router
      .createCaller({})
      .workloadDelete({ name: "gemma-solo", keepRunning: true });

    expect(result).toEqual({ ok: true, name: "gemma-solo", stops: [] });
    expect(existsSync(workloadPath("gemma-solo", tmp))).toBe(false);
  });
});

function stoppedRemoteHostClient(): WorkloadClient {
  return {
    serverStatus: {
      query: () =>
        Promise.resolve({
          state: "down",
          rel: null,
          extraArgs: [],
          pid: null,
          host: null,
          port: null,
          binary: null,
          endpoint: "",
        }),
    },
    serverStop: { mutate: () => Promise.resolve({ ok: true }) },
    serverStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    modelHostStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: { ok: true, pid: 4321, state: "Running" } });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStop: { mutate: () => Promise.resolve({ ok: true }) },
    modelHostStatus: { query: () => Promise.resolve({ state: "Stopped" }) },
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ ok: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: null, llamaCppBin: null }) },
  };
}

describe("deleteWorkload controller history (#308)", () => {
  test("removes the ModelHost's controller history with its manifest", () => {
    saveModelHost(parseModelHost(remoteModelHostYaml), tmp);
    updateControllerHostHistory(tmp, "gpu1", "z13-host", new Date(), (h) => ({
      ...h,
      lastKnownRunning: true,
      restarts: 3,
      lastRestartReason: "EngineExited",
    }));
    updateControllerHostHistory(tmp, "gpu1", "other-host", new Date(), (h) => ({
      ...h,
      lastKnownRunning: true,
    }));

    expect(deleteWorkload("z13-host", tmp)).toBe(true);
    expect(readControllerHostHistory(tmp, "gpu1", "z13-host")).toBeNull();
    expect(readControllerHostHistory(tmp, "gpu1", "other-host")).not.toBeNull();
  });

  test("deleting a ModelRun touches no controller history", () => {
    saveWorkload(parseWorkload(modelRunYaml), tmp);
    updateControllerHostHistory(tmp, "local", "gemma-solo", new Date(), (h) => ({
      ...h,
      lastKnownRunning: true,
    }));

    expect(deleteWorkload("gemma-solo", tmp)).toBe(true);
    expect(readControllerHostHistory(tmp, "local", "gemma-solo")).not.toBeNull();
  });
});

describe("workloadDelete then re-apply (#308)", () => {
  test("a re-applied ModelHost starts clean: no inherited history, no false restart", async () => {
    const manifest = parseModelHost(remoteModelHostYaml);
    saveModelHost(manifest, tmp);
    updateControllerHostHistory(tmp, "gpu1", "z13-host", new Date(), (h) => ({
      ...h,
      lastKnownRunning: true,
      restarts: 3,
      lastRestartReason: "EngineExited",
    }));

    const deleted = await router
      .createCaller({})
      .workloadDelete({ name: "z13-host", keepRunning: true });
    expect(deleted.ok).toBe(true);
    expect(readControllerHostHistory(tmp, "gpu1", "z13-host")).toBeNull();

    saveModelHost(manifest, tmp);
    const result = await reconcileOnce({
      workloadsDir: tmp,
      getClient: () => stoppedRemoteHostClient(),
    });

    expect(result.errors).toBe(0);
    expect(result.reports).toEqual([
      { kind: "ModelHost", name: "z13-host", node: "gpu1", action: "started" },
    ]);
    const history = readControllerHostHistory(tmp, "gpu1", "z13-host");
    expect(history?.restarts).toBe(0);
    expect(history?.lastRestartReason).toBeNull();
    expect(history?.lastKnownRunning).toBe(true);
  });
});
