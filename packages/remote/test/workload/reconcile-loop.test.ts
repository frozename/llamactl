import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkloadClient } from "../../src/workload/apply.js";
import type { ModelRun } from "../../src/workload/schema.js";

import {
  computeModelHostSpecHash,
  readModelHostState,
  writeModelHostState,
} from "../../../core/src/engines/state.js";
import { resolveEnv } from "../../../core/src/env.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { type ModelHostManifest, specForHash } from "../../src/workload/modelhost-schema.js";
import { saveModelHost } from "../../src/workload/modelhost-store.js";
import {
  kickReconcileLoop,
  reconcileLoopStatus,
  startReconcileLoop,
  stopReconcileLoop,
} from "../../src/workload/reconcileLoop.js";
import { saveWorkload } from "../../src/workload/store.js";

function withLoopEnv(prefix: string, body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const previousWorkloadsDir = process.env["LLAMACTL_WORKLOADS_DIR"];
  const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
  process.env["LLAMACTL_WORKLOADS_DIR"] = dir;
  process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
  return body(dir).finally(() => {
    stopReconcileLoop();
    if (previousWorkloadsDir === undefined) delete process.env["LLAMACTL_WORKLOADS_DIR"];
    else process.env["LLAMACTL_WORKLOADS_DIR"] = previousWorkloadsDir;
    if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
    else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
    rmSync(dir, { recursive: true, force: true });
  });
}

function makeRun(name: string, restartPolicy: ModelRun["spec"]["restartPolicy"]): ModelRun {
  return {
    apiVersion: "llamactl/v1" as const,
    kind: "ModelRun" as const,
    metadata: { name, labels: {}, annotations: {} },
    spec: {
      node: "local",
      enabled: true,
      target: { kind: "rel" as const, value: `mlx-community/${name}.gguf` },
      extraArgs: [],
      workers: [],
      restartPolicy,
      timeoutSeconds: 60,
      gateway: false,
      allowExternalBind: false,
    },
  };
}

function makeHost(
  name: string,
  restartPolicy: ModelHostManifest["spec"]["restartPolicy"],
  port: number,
): ModelHostManifest {
  return {
    apiVersion: "llamactl/v1" as const,
    kind: "ModelHost" as const,
    metadata: { name },
    spec: {
      engine: "omlx" as const,
      node: "local",
      enabled: true,
      binary: "/usr/bin/true",
      endpoint: { host: "127.0.0.1", port },
      hostedModels: [{ rel: `mlx-community/${name}` }],
      extraArgs: [],
      restartPolicy,
      timeoutSeconds: 60,
    },
  };
}

// Launch record of a killed engine whose spec still matches the manifest:
// an Always host restarts from this state, a Never host must not.
function seedCrashedSidecar(dir: string, manifest: ModelHostManifest): void {
  writeModelHostState(
    {
      kind: "ModelHost",
      engine: manifest.spec.engine,
      pid: 1234,
      host: manifest.spec.endpoint.host,
      port: manifest.spec.endpoint.port,
      modelAliases: [manifest.spec.hostedModels[0]!.rel],
      startedAt: new Date().toISOString(),
      specHash: computeModelHostSpecHash(specForHash(manifest.spec)),
    },
    { name: manifest.metadata.name },
    resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir }),
  );
}

function loopClient(
  starts: { runs: string[]; hosts: string[] },
  hostState: string,
): WorkloadClient {
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
    serverStart: {
      subscribe: (input, callbacks): { unsubscribe: () => undefined } => {
        starts.runs.push(input.workload);
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 111, endpoint: "http://127.0.0.1:18080" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: (): undefined => undefined };
      },
    },
    modelHostStart: {
      subscribe: (input, callbacks): { unsubscribe: () => undefined } => {
        starts.hosts.push(input.workload);
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: { ok: true, pid: 4321, state: "Running" } });
          callbacks.onComplete();
        });
        return { unsubscribe: (): undefined => undefined };
      },
    },
    modelHostStop: { mutate: () => Promise.resolve({ ok: true }) },
    modelHostStatus: { query: () => Promise.resolve({ state: hostState }) },
    rpcServerStart: { subscribe: () => ({ unsubscribe: (): undefined => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ ok: true }) },
    rpcServerDoctor: {
      query: () => Promise.resolve({ ok: true, path: null, llamaCppBin: null }),
    },
  };
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for reconcile loop pass");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("reconcileLoop restartPolicy Never (#332)", () => {
  test("a loop pass skips ModelRuns whose restartPolicy is Never", async () => {
    await withLoopEnv("llamactl-loop-never-run-", async (dir) => {
      saveWorkload(makeRun("run-always", "Always"), dir);
      saveWorkload(makeRun("run-never", "Never"), dir);
      const starts = { runs: [] as string[], hosts: [] as string[] };

      await kickReconcileLoop({ getClient: () => loopClient(starts, "Stopped") });

      expect(starts.runs).toEqual(["run-always"]);
      const status = reconcileLoopStatus();
      expect(status.lastResult?.errors).toBe(0);
      expect(status.lastResult?.reports.map((r) => r.name)).toEqual(["run-always"]);
      expect(status.lastResult?.reports[0]).toMatchObject({
        kind: "ModelRun",
        action: "started",
      });
    });
  });

  test("a loop pass leaves a crashed enabled Never ModelHost down", async () => {
    await withLoopEnv("llamactl-loop-never-host-", async (dir) => {
      const neverHost = makeHost("host-never", "Never", 18094);
      const alwaysHost = makeHost("host-always", "Always", 18095);
      saveModelHost(neverHost, dir);
      saveModelHost(alwaysHost, dir);
      seedCrashedSidecar(dir, neverHost);
      seedCrashedSidecar(dir, alwaysHost);
      const starts = { runs: [] as string[], hosts: [] as string[] };

      await kickReconcileLoop({ getClient: () => loopClient(starts, "Stopped") });

      expect(starts.hosts).toEqual(["host-always"]);
      const status = reconcileLoopStatus();
      expect(status.lastResult?.errors).toBe(0);
      expect(status.lastResult?.reports).toEqual([
        {
          kind: "ModelHost",
          name: "host-always",
          node: "local",
          action: "started",
          foundDead: true,
        },
        { kind: "ModelHost", name: "host-never", node: "local", action: "unchanged" },
      ]);
      // The Never host keeps its launch record untouched.
      expect(
        readModelHostState({ name: "host-never" }, resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir })),
      ).not.toBeNull();
    });
  });

  test("a loop pass still starts a Never ModelHost that has no launch record", async () => {
    await withLoopEnv("llamactl-loop-never-fresh-", async (dir) => {
      saveModelHost(makeHost("host-never", "Never", 18094), dir);
      const starts = { runs: [] as string[], hosts: [] as string[] };

      await kickReconcileLoop({ getClient: () => loopClient(starts, "Stopped") });

      expect(starts.hosts).toEqual(["host-never"]);
      const status = reconcileLoopStatus();
      expect(status.lastResult?.errors).toBe(0);
      expect(status.lastResult?.reports).toEqual([
        { kind: "ModelHost", name: "host-never", node: "local", action: "started" },
      ]);
    });
  });

  test("startReconcileLoop runs an initial pass and stopReconcileLoop halts the loop", async () => {
    await withLoopEnv("llamactl-loop-start-stop-", async (dir) => {
      saveModelHost(makeHost("host-never", "Never", 18094), dir);
      const starts = { runs: [] as string[], hosts: [] as string[] };

      startReconcileLoop({
        getClient: () => loopClient(starts, "Stopped"),
        intervalMs: 600_000,
      });
      await waitUntil(
        () =>
          starts.hosts.length > 0 &&
          reconcileLoopStatus().lastResult?.reports.some((r) => r.action === "started") === true,
      );

      expect(starts.hosts).toEqual(["host-never"]);
      let status = reconcileLoopStatus();
      expect(status.running).toBe(true);
      expect(status.nextPassAt).not.toBeNull();
      expect(status.lastResult?.reports).toEqual([
        { kind: "ModelHost", name: "host-never", node: "local", action: "started" },
      ]);

      stopReconcileLoop();
      status = reconcileLoopStatus();
      expect(status.running).toBe(false);
      expect(status.nextPassAt).toBeNull();
      expect(starts.hosts).toEqual(["host-never"]);
    });
  });
});
