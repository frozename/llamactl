import { describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileOnce, type ReconcileResult } from "../../src/workload/reconciler.js";
import { saveWorkload } from "../../src/workload/store.js";
import { saveModelHost } from "../../src/workload/modelhost-store.js";
import { resolveEnv } from "../../../core/src/env.js";
import {
  computeModelHostSpecHash,
  readModelHostState,
  writeModelHostState,
} from "../../../core/src/engines/state.js";

function seedRunningSidecar(dir: string, manifest: ReturnType<typeof makeHostManifest>): void {
  writeModelHostState(
    {
      kind: "ModelHost",
      engine: manifest.spec.engine,
      pid: 1234,
      host: manifest.spec.endpoint.host,
      port: manifest.spec.endpoint.port,
      modelAliases: [manifest.spec.hostedModels[0]!.rel],
      startedAt: new Date().toISOString(),
      specHash: computeModelHostSpecHash(manifest.spec),
    },
    { name: manifest.metadata.name },
    resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir }),
  );
}
import type { WorkloadClient } from "../../src/workload/apply.js";

function makeClient(): WorkloadClient {
  return {
    serverStatus: {
      query: async () => ({
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
    serverStop: { mutate: async () => ({ ok: true }) },
    serverStart: {
      subscribe: (_input, callbacks) => {
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 111, endpoint: "http://127.0.0.1:18080" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe() {} };
      },
    },
    modelHostStart: {
      subscribe: (_input, callbacks) => {
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: { ok: true } });
          callbacks.onComplete();
        });
        return { unsubscribe() {} };
      },
    },
    modelHostStop: { mutate: async () => ({ ok: true }) },
    modelHostStatus: {
      query: async () => ({
        state: "Running",
        engine: "omlx",
        binary: "/usr/bin/true",
        endpoint: { host: "127.0.0.1", port: 18094 },
        hostedModels: [{ rel: "mlx-community/host-a" }],
        extraArgs: [],
        resources: undefined,
        restartPolicy: "Always",
        timeoutSeconds: 60,
      }),
    },
    rpcServerStart: { subscribe: () => ({ unsubscribe() {} }) },
    rpcServerStop: { mutate: async () => ({ ok: true }) },
    rpcServerDoctor: { query: async () => ({ ok: true, path: null, llamaCppBin: null }) },
  };
}

function makeRunManifest() {
  return {
    apiVersion: "llamactl/v1" as const,
    kind: "ModelRun" as const,
    metadata: { name: "run-a", labels: {}, annotations: {} },
    spec: {
      node: "local",
      enabled: true,
      target: { kind: "rel" as const, value: "mlx-community/run-a.gguf" },
      extraArgs: [],
      workers: [],
      restartPolicy: "Always" as const,
      timeoutSeconds: 60,
      gateway: false,
      allowExternalBind: false,
    },
  };
}

function makeHostManifest() {
  return {
    apiVersion: "llamactl/v1" as const,
    kind: "ModelHost" as const,
    metadata: { name: "host-a" },
    spec: {
      engine: "omlx" as const,
      node: "local",
      enabled: true,
      binary: "/usr/bin/true",
      endpoint: { host: "127.0.0.1", port: 18094 },
      hostedModels: [{ rel: "mlx-community/host-a" }],
      extraArgs: [],
      restartPolicy: "Always" as const,
      timeoutSeconds: 60,
    },
  };
}

describe("reconcileOnce", () => {
  test("processes ModelRun and ModelHost manifests from the shared store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-"));
    const previousRuntimeDir = process.env.LOCAL_AI_RUNTIME_DIR;
    try {
      saveWorkload(makeRunManifest(), dir);
      saveModelHost(makeHostManifest(), dir);
      process.env.LOCAL_AI_RUNTIME_DIR = dir;
      // Sidecar with matching specHash → reconciler skips applyOneModelHost.
      seedRunningSidecar(dir, makeHostManifest());

      const result: ReconcileResult = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => makeClient(),
      });

      expect(result.errors).toBe(0);
      expect(result.reports).toHaveLength(2);
      expect(result.reports.map((r) => r.name)).toEqual(["run-a", "host-a"]);
      expect(result.reports.map((r) => r.node)).toEqual(["local", "local"]);
      expect(result.reports.find((r) => r.name === "host-a")?.action).toBe("unchanged");
      expect(result.reports.find((r) => r.name === "run-a")?.action).toBe("started");
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
      else process.env.LOCAL_AI_RUNTIME_DIR = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persists ModelHost status returned by the reconciler outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-host-status-"));
    const previousRuntimeDir = process.env.LOCAL_AI_RUNTIME_DIR;
    try {
      saveModelHost(makeHostManifest(), dir);
      process.env.LOCAL_AI_RUNTIME_DIR = dir;
      const readSpy = spyOn(fs, "readFileSync");

      await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: { query: async () => ({ state: "Running", pid: 1234 }) },
        }),
      });

      expect(readSpy).toHaveBeenCalled();
      readSpy.mockRestore();
      const state = readModelHostState(
        { name: "host-a" },
        resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir }),
      );
      expect(state?.pid).toBe(1234);
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
      else process.env.LOCAL_AI_RUNTIME_DIR = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sweeps a stale sidecar for a disabled, non-running ModelHost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-disabled-sweep-"));
    const previousRuntimeDir = process.env.LOCAL_AI_RUNTIME_DIR;
    try {
      const base = makeHostManifest();
      saveModelHost({ ...base, spec: { ...base.spec, enabled: false } }, dir);
      process.env.LOCAL_AI_RUNTIME_DIR = dir;
      // Leftover sidecar from a prior out-of-band exit (recorded pid now dead).
      seedRunningSidecar(dir, base);
      expect(
        readModelHostState({ name: "host-a" }, resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir })),
      ).not.toBeNull();

      const result = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: { query: async () => ({ state: "Stopped" }) },
        }),
      });

      expect(result.errors).toBe(0);
      expect(result.reports.find((r) => r.name === "host-a")?.action).toBe("unchanged");
      // The stale sidecar is swept so it does not leak for a disabled host.
      expect(
        readModelHostState({ name: "host-a" }, resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir })),
      ).toBeNull();
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
      else process.env.LOCAL_AI_RUNTIME_DIR = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips ModelHost start when the persisted Running spec still matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-host-unchanged-"));
    const previousRuntimeDir = process.env.LOCAL_AI_RUNTIME_DIR;
    const startCalls: unknown[] = [];
    try {
      saveModelHost(makeHostManifest(), dir);
      process.env.LOCAL_AI_RUNTIME_DIR = dir;
      // Sidecar with matching specHash → reconciler skips applyOneModelHost.
      seedRunningSidecar(dir, makeHostManifest());

      const result = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: {
            query: async () => ({
              state: "Running",
              pid: 1234,
              engine: "omlx",
              binary: "/usr/bin/true",
              endpoint: { host: "127.0.0.1", port: 18094 },
              hostedModels: [{ rel: "mlx-community/host-a" }],
              extraArgs: [],
              resources: undefined,
              restartPolicy: "Always",
              timeoutSeconds: 60,
            }),
          },
          modelHostStart: {
            subscribe: mock((_input, _callbacks) => {
              startCalls.push(_input);
              return { unsubscribe() {} };
            }),
          },
        }),
      });

      expect(result.errors).toBe(0);
      expect(result.reports[0]?.action).toBe("unchanged");
      expect(startCalls).toHaveLength(0);
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
      else process.env.LOCAL_AI_RUNTIME_DIR = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restarts ModelHost when the persisted spec diverges from the desired manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-host-restart-"));
    const previousRuntimeDir = process.env.LOCAL_AI_RUNTIME_DIR;
    let startCalls = 0;
    const currentManifest = makeHostManifest();
    try {
      saveModelHost(currentManifest, dir);
      process.env.LOCAL_AI_RUNTIME_DIR = dir;

      const result = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: {
            query: async () => {
              saveModelHost(
                {
                  ...currentManifest,
                  spec: {
                    ...currentManifest.spec,
                    extraArgs: ["--threads", "2"],
                  },
                } as never,
                dir,
              );
              return {
                state: "Running",
                pid: 1234,
                engine: "omlx",
                binary: "/usr/bin/true",
                endpoint: { host: "127.0.0.1", port: 18094 },
                hostedModels: [{ rel: "mlx-community/host-a" }],
                extraArgs: ["--threads", "2"],
                resources: undefined,
                restartPolicy: "Always",
                timeoutSeconds: 60,
              };
            },
          },
          modelHostStart: {
            subscribe: (_input, callbacks) => {
              startCalls += 1;
              queueMicrotask(() => {
                callbacks.onData({
                  type: "done",
                  result: { ok: true, pid: 4321, state: "Running" },
                });
                callbacks.onComplete();
              });
              return { unsubscribe() {} };
            },
          },
        }),
      });

      expect(result.errors).toBe(0);
      expect(result.reports[0]?.action).toBe("restarted");
      expect(startCalls).toBe(1);
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
      else process.env.LOCAL_AI_RUNTIME_DIR = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restarts ModelHost when restartPolicy changes on the desired manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-host-restart-policy-"));
    const previousRuntimeDir = process.env.LOCAL_AI_RUNTIME_DIR;
    let startCalls = 0;
    try {
      saveModelHost(
        {
          ...makeHostManifest(),
          spec: {
            ...makeHostManifest().spec,
            restartPolicy: "OnFailure",
          },
        } as never,
        dir,
      );
      saveModelHost(makeHostManifest(), dir);
      process.env.LOCAL_AI_RUNTIME_DIR = dir;

      const result = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: {
            query: async () => ({
              state: "Running",
              pid: 1234,
              engine: "omlx",
              binary: "/usr/bin/true",
              endpoint: { host: "127.0.0.1", port: 18094 },
              hostedModels: [{ rel: "mlx-community/host-a" }],
              extraArgs: [],
              resources: undefined,
              restartPolicy: "OnFailure",
              timeoutSeconds: 60,
            }),
          },
          modelHostStart: {
            subscribe: (_input, callbacks) => {
              startCalls += 1;
              queueMicrotask(() => {
                callbacks.onData({
                  type: "done",
                  result: { ok: true, pid: 4321, state: "Running" },
                });
                callbacks.onComplete();
              });
              return { unsubscribe() {} };
            },
          },
        }),
      });

      expect(result.errors).toBe(0);
      expect(result.reports[0]?.action).toBe("restarted");
      expect(startCalls).toBe(1);
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
      else process.env.LOCAL_AI_RUNTIME_DIR = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips disabling an already stopped ModelHost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-host-stopped-"));
    const previousRuntimeDir = process.env.LOCAL_AI_RUNTIME_DIR;
    const stopCalls: unknown[] = [];
    try {
      saveModelHost(
        {
          ...makeHostManifest(),
          spec: {
            ...makeHostManifest().spec,
            enabled: false,
          },
        } as never,
        dir,
      );
      process.env.LOCAL_AI_RUNTIME_DIR = dir;

      const result = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: {
            query: async () => ({ state: "Stopped", pid: null }),
          },
          modelHostStop: {
            mutate: async (input) => {
              stopCalls.push(input);
              return { ok: true };
            },
          },
        }),
      });

      expect(result.errors).toBe(0);
      expect(result.reports[0]?.action).toBe("unchanged");
      expect(stopCalls).toHaveLength(0);
    } finally {
      if (previousRuntimeDir === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
      else process.env.LOCAL_AI_RUNTIME_DIR = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
