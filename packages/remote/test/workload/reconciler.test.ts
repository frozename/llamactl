import { describe, expect, mock, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkloadClient } from "../../src/workload/apply.js";
import type { ModelRun } from "../../src/workload/schema.js";

import {
  modelhostConditionsFile,
  readModelHostRuntimeStatus,
} from "../../../core/src/engines/conditions.js";
import {
  computeModelHostSpecHash,
  readModelHostState,
  writeModelHostState,
} from "../../../core/src/engines/state.js";
import { resolveEnv } from "../../../core/src/env.js";
import * as fs from "../../src/safe-fs.js";
import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { type ModelHostManifest, specForHash } from "../../src/workload/modelhost-schema.js";
import { loadModelHostByName, saveModelHost } from "../../src/workload/modelhost-store.js";
import { reconcileOnce, type ReconcileResult } from "../../src/workload/reconciler.js";
import { saveWorkload } from "../../src/workload/store.js";

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
      specHash: computeModelHostSpecHash(specForHash(manifest.spec)),
    },
    { name: manifest.metadata.name },
    resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir }),
  );
}

interface MockModelHostStatus {
  state: string;
  pid: number;
  engine: string;
  binary: string;
  endpoint: { host: string; port: number };
  hostedModels: { rel: string }[];
  extraArgs: string[];
  resources: undefined;
  restartPolicy: string;
  timeoutSeconds: number;
}

function makeClient(): WorkloadClient {
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
      subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 111, endpoint: "http://127.0.0.1:18080" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStart: {
      subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: { ok: true } });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStop: { mutate: () => Promise.resolve({ ok: true }) },
    modelHostStatus: {
      query: () =>
        Promise.resolve({
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
    rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
    rpcServerStop: { mutate: () => Promise.resolve({ ok: true }) },
    rpcServerDoctor: { query: () => Promise.resolve({ ok: true, path: null, llamaCppBin: null }) },
  };
}

function makeRunManifest(): ModelRun {
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

function makeHostManifest(): ModelHostManifest {
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
    const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
    try {
      saveWorkload(makeRunManifest(), dir);
      saveModelHost(makeHostManifest(), dir);
      process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
      // Sidecar with matching specHash → reconciler skips applyOneModelHost.
      seedRunningSidecar(dir, makeHostManifest());

      const result: ReconcileResult = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => makeClient(),
      });

      expect(result.errors).toBe(0);
      expect(result.reports).toHaveLength(2);
      expect(result.reports.map((r) => r.name)).toEqual(["run-a", "host-a"]);
      expect(result.reports.map((r) => r.kind)).toEqual(["ModelRun", "ModelHost"]);
      expect(result.reports.map((r) => r.node)).toEqual(["local", "local"]);
      expect(result.reports.find((r) => r.name === "host-a")?.action).toBe("unchanged");
      expect(result.reports.find((r) => r.name === "run-a")?.action).toBe("started");
    } finally {
      if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
      else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persists ModelHost status returned by the reconciler outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-host-status-"));
    const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
    try {
      saveModelHost(makeHostManifest(), dir);
      process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
      const readSpy = spyOn(fs, "readFileSync");

      await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: {
            query: (): Promise<{ state: string; pid: number }> =>
              Promise.resolve({ state: "Running", pid: 1234 }),
          },
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
      if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
      else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sweeps a stale sidecar for a disabled, non-running ModelHost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-disabled-sweep-"));
    const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
    try {
      const base = makeHostManifest();
      saveModelHost({ ...base, spec: { ...base.spec, enabled: false } }, dir);
      process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
      // Leftover sidecar from a prior out-of-band exit (recorded pid now dead).
      seedRunningSidecar(dir, base);
      expect(
        readModelHostState({ name: "host-a" }, resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir })),
      ).not.toBeNull();

      const result = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: {
            query: (): Promise<{ state: string }> => Promise.resolve({ state: "Stopped" }),
          },
        }),
      });

      expect(result.errors).toBe(0);
      expect(result.reports.find((r) => r.name === "host-a")?.action).toBe("unchanged");
      // The stale sidecar is swept so it does not leak for a disabled host.
      expect(
        readModelHostState({ name: "host-a" }, resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir })),
      ).toBeNull();
    } finally {
      if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
      else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips ModelHost start when the persisted Running spec still matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-host-unchanged-"));
    const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
    const startCalls: unknown[] = [];
    try {
      saveModelHost(makeHostManifest(), dir);
      process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
      // Sidecar with matching specHash → reconciler skips applyOneModelHost.
      seedRunningSidecar(dir, makeHostManifest());

      const result = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: {
            query: (): Promise<MockModelHostStatus> =>
              Promise.resolve({
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
              return { unsubscribe: (): undefined => undefined };
            }),
          },
        }),
      });

      expect(result.errors).toBe(0);
      expect(result.reports[0]?.action).toBe("unchanged");
      expect(startCalls).toHaveLength(0);
    } finally {
      if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
      else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restarts ModelHost when the persisted spec diverges from the desired manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-host-restart-"));
    const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
    let startCalls = 0;
    const currentManifest = makeHostManifest();
    try {
      saveModelHost(currentManifest, dir);
      process.env["LOCAL_AI_RUNTIME_DIR"] = dir;

      const result = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: {
            query: (): Promise<MockModelHostStatus> => {
              saveModelHost(
                {
                  ...currentManifest,
                  spec: {
                    ...currentManifest.spec,
                    extraArgs: ["--threads", "2"],
                  },
                },
                dir,
              );
              return Promise.resolve({
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
              });
            },
          },
          modelHostStart: {
            subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
              startCalls += 1;
              queueMicrotask(() => {
                callbacks.onData({
                  type: "done",
                  result: { ok: true, pid: 4321, state: "Running" },
                });
                callbacks.onComplete();
              });
              return { unsubscribe: (): undefined => undefined };
            },
          },
        }),
      });

      expect(result.errors).toBe(0);
      expect(result.reports[0]?.action).toBe("restarted");
      expect(startCalls).toBe(1);
    } finally {
      if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
      else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restarts ModelHost when restartPolicy changes on the desired manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-host-restart-policy-"));
    const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
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
      process.env["LOCAL_AI_RUNTIME_DIR"] = dir;

      const result = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: {
            query: (): Promise<MockModelHostStatus> =>
              Promise.resolve({
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
            subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
              startCalls += 1;
              queueMicrotask(() => {
                callbacks.onData({
                  type: "done",
                  result: { ok: true, pid: 4321, state: "Running" },
                });
                callbacks.onComplete();
              });
              return { unsubscribe: (): undefined => undefined };
            },
          },
        }),
      });

      expect(result.errors).toBe(0);
      expect(result.reports[0]?.action).toBe("restarted");
      expect(startCalls).toBe(1);
    } finally {
      if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
      else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips disabling an already stopped ModelHost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-host-stopped-"));
    const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
    const stopCalls: unknown[] = [];
    try {
      saveModelHost(
        {
          ...makeHostManifest(),
          spec: {
            ...makeHostManifest().spec,
            enabled: false,
          },
        },
        dir,
      );
      process.env["LOCAL_AI_RUNTIME_DIR"] = dir;

      const result = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: {
            query: (): Promise<{ state: string; pid: null }> =>
              Promise.resolve({ state: "Stopped", pid: null }),
          },
          modelHostStop: {
            mutate: (input): Promise<{ ok: boolean }> => {
              stopCalls.push(input);
              return Promise.resolve({ ok: true });
            },
          },
        }),
      });

      expect(result.errors).toBe(0);
      expect(result.reports[0]?.action).toBe("unchanged");
      expect(stopCalls).toHaveLength(0);
    } finally {
      if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
      else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves a disabled ModelHost record when identity is unknown", async () => {
    // identityUnknown means the agent could not prove the recorded pid is
    // dead or foreign — the record may still be ours, so the sweep path must
    // keep it and surface the uncertainty instead of reporting a clean pass.
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-idunknown-"));
    const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
    try {
      const base = makeHostManifest();
      saveModelHost({ ...base, spec: { ...base.spec, enabled: false } }, dir);
      process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
      seedRunningSidecar(dir, base);

      const result = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: {
            query: (): Promise<{ state: string; identityUnknown: boolean }> =>
              Promise.resolve({ state: "Stopped", identityUnknown: true }),
          },
        }),
      });

      expect(result.errors).toBe(1);
      expect(result.reports.find((r) => r.name === "host-a")?.action).toBe("unchanged");
      expect(
        readModelHostState({ name: "host-a" }, resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir })),
      ).not.toBeNull();
    } finally {
      if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
      else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not restart an enabled ModelHost while identity is unknown", async () => {
    // Spawning a replacement over an unverifiable process would double-bind
    // the endpoint; defer the reconcile and report instead.
    const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-idunknown-start-"));
    const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
    let startCalls = 0;
    try {
      saveModelHost(makeHostManifest(), dir);
      process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
      seedRunningSidecar(dir, makeHostManifest());

      const result = await reconcileOnce({
        workloadsDir: dir,
        getClient: () => ({
          ...makeClient(),
          modelHostStatus: {
            query: (): Promise<{ state: string; identityUnknown: boolean }> =>
              Promise.resolve({ state: "Stopped", identityUnknown: true }),
          },
          modelHostStart: {
            subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
              startCalls += 1;
              queueMicrotask(() => {
                callbacks.onData({ type: "done", result: { ok: true, pid: 4321 } });
                callbacks.onComplete();
              });
              return { unsubscribe: (): undefined => undefined };
            },
          },
        }),
      });

      expect(result.errors).toBe(1);
      expect(startCalls).toBe(0);
      expect(
        readModelHostState({ name: "host-a" }, resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir })),
      ).not.toBeNull();
    } finally {
      if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
      else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  describe("ModelHost conditions", () => {
    const MISMATCH =
      'strata run-config /cfg/run.json --native must be /models/q3.gguf (models dir + ModelHost spec.hostedModels[0].rel "q3.gguf"); got /models/q4.gguf. Update the run-config --native and the manifest rel together.';

    function startStub(
      outcome: () => { ok: true; pid: number; state: string } | { ok: false; error: string },
    ): WorkloadClient["modelHostStart"] {
      return {
        subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
          queueMicrotask(() => {
            callbacks.onData({ type: "done", result: outcome() });
            callbacks.onComplete();
          });
          return { unsubscribe: (): undefined => undefined };
        },
      };
    }

    async function withRuntime(
      prefix: string,
      body: (dir: string, runtime: ReturnType<typeof resolveEnv>) => Promise<void>,
    ): Promise<void> {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
      try {
        process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
        await body(dir, resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir }));
      } finally {
        if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
        else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
        rmSync(dir, { recursive: true, force: true });
      }
    }

    test("records a ReconcileError across failing passes and clears it on the next start", async () => {
      await withRuntime("llamactl-reconciler-cond-error-", async (dir, runtime) => {
        saveModelHost(makeHostManifest(), dir);
        let startOk = false;
        const getClient = (): WorkloadClient => ({
          ...makeClient(),
          modelHostStatus: { query: () => Promise.resolve({ state: "Stopped" }) },
          modelHostStart: startStub(() =>
            startOk ? { ok: true, pid: 4321, state: "Running" } : { ok: false, error: MISMATCH },
          ),
        });

        const first = await reconcileOnce({ workloadsDir: dir, getClient });
        await reconcileOnce({ workloadsDir: dir, getClient });
        expect(first.reports).toEqual([
          {
            kind: "ModelHost",
            name: "host-a",
            node: "local",
            action: "unchanged",
            error: MISMATCH,
          },
        ]);
        expect(readModelHostRuntimeStatus({ name: "host-a" }, runtime)?.conditions).toEqual([
          expect.objectContaining({
            type: "ReconcileError",
            status: "True",
            reason: "ApplyFailed",
            message: MISMATCH,
            count: 2,
          }),
        ]);

        startOk = true;
        const recovered = await reconcileOnce({ workloadsDir: dir, getClient });
        expect(recovered.errors).toBe(0);
        const record = readModelHostRuntimeStatus({ name: "host-a" }, runtime);
        expect(record?.conditions[0]).toMatchObject({
          type: "ReconcileError",
          status: "False",
          reason: "Recovered",
          message: MISMATCH,
          count: 2,
        });
        // A first start is not a restart.
        expect(record?.restarts).toBe(0);
      });
    });

    test("flags an engine found dead and counts its restart", async () => {
      await withRuntime("llamactl-reconciler-cond-dead-", async (dir, runtime) => {
        const manifest = makeHostManifest();
        saveModelHost(manifest, dir);
        seedRunningSidecar(dir, manifest);
        const result = await reconcileOnce({
          workloadsDir: dir,
          getClient: (): WorkloadClient => ({
            ...makeClient(),
            modelHostStatus: { query: () => Promise.resolve({ state: "Stopped" }) },
            modelHostStart: startStub(() => ({ ok: true, pid: 4321, state: "Running" })),
          }),
        });
        expect(result.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "local", action: "started", foundDead: true },
        ]);
        expect(readModelHostRuntimeStatus({ name: "host-a" }, runtime)).toMatchObject({
          restarts: 1,
          lastRestartReason: "EngineExited",
          conditions: [],
        });
      });
    });

    test("leaves no local conditions for a remote host", async () => {
      await withRuntime("llamactl-reconciler-cond-remote-", async (dir, runtime) => {
        saveModelHost(
          { ...makeHostManifest(), spec: { ...makeHostManifest().spec, node: "gpu1" } },
          dir,
        );
        const result = await reconcileOnce({
          workloadsDir: dir,
          getClient: (): WorkloadClient => ({
            ...makeClient(),
            modelHostStatus: { query: () => Promise.resolve({ state: "Stopped" }) },
            modelHostStart: startStub(() => ({ ok: false, error: MISMATCH })),
          }),
        });
        expect(result.errors).toBe(1);
        expect(fs.existsSync(modelhostConditionsFile(runtime, { name: "host-a" }))).toBe(false);
      });
    });
  });

  describe("externally managed ModelHosts", () => {
    function withManagedBy(manifest: ModelHostManifest): ModelHostManifest {
      return {
        ...manifest,
        metadata: { ...manifest.metadata, labels: { "llamactl.io/managed-by": "mac-mini" } },
      };
    }

    function stoppedClient(onStart?: () => void): WorkloadClient {
      return {
        ...makeClient(),
        modelHostStatus: { query: () => Promise.resolve({ state: "Stopped" }) },
        modelHostStart: {
          subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
            onStart?.();
            queueMicrotask(() => {
              callbacks.onData({ type: "done", result: { ok: true } });
              callbacks.onComplete();
            });
            return { unsubscribe: (): undefined => undefined };
          },
        },
      };
    }

    test("reports skipped-external for an enabled labeled host without any client access", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-external-"));
      const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
      let clientCalls = 0;
      try {
        saveModelHost(withManagedBy(makeHostManifest()), dir);
        process.env["LOCAL_AI_RUNTIME_DIR"] = dir;

        const result = await reconcileOnce({
          workloadsDir: dir,
          getClient: (): WorkloadClient => {
            clientCalls++;
            return stoppedClient();
          },
        });

        expect(result.reports).toEqual([
          {
            kind: "ModelHost",
            name: "host-a",
            node: "local",
            action: "skipped-external",
            managedBy: "mac-mini",
          },
        ]);
        expect(result.errors).toBe(0);
        expect(clientCalls).toBe(0);
      } finally {
        if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
        else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("preserves the sidecar of a disabled labeled host", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-external-sweep-"));
      const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
      try {
        const base = makeHostManifest();
        saveModelHost(withManagedBy({ ...base, spec: { ...base.spec, enabled: false } }), dir);
        process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
        seedRunningSidecar(dir, base);

        const result = await reconcileOnce({
          workloadsDir: dir,
          getClient: () => stoppedClient(),
        });

        expect(result.errors).toBe(0);
        expect(result.reports[0]?.action).toBe("skipped-external");
        expect(
          readModelHostState({ name: "host-a" }, resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir })),
        ).not.toBeNull();
      } finally {
        if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
        else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("skips only the labeled host in a mixed store", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-external-mixed-"));
      const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
      let startCalls = 0;
      try {
        const base = makeHostManifest();
        const hostB: ModelHostManifest = {
          ...base,
          metadata: { name: "host-b" },
          spec: { ...base.spec, endpoint: { host: "127.0.0.1", port: 18095 } },
        };
        saveModelHost(withManagedBy(base), dir);
        saveModelHost(hostB, dir);
        process.env["LOCAL_AI_RUNTIME_DIR"] = dir;

        const result = await reconcileOnce({
          workloadsDir: dir,
          getClient: () => stoppedClient(() => startCalls++),
        });

        expect(result.errors).toBe(0);
        expect(result.reports).toEqual([
          {
            kind: "ModelHost",
            name: "host-a",
            node: "local",
            action: "skipped-external",
            managedBy: "mac-mini",
          },
          { kind: "ModelHost", name: "host-b", node: "local", action: "started" },
        ]);
        expect(startCalls).toBe(1);
      } finally {
        if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
        else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("honours a marker written to a later host while an earlier host's start awaits", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-external-race-"));
      const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
      const started: string[] = [];
      try {
        const base = makeHostManifest();
        const hostB: ModelHostManifest = {
          ...base,
          metadata: { name: "host-b" },
          spec: { ...base.spec, endpoint: { host: "127.0.0.1", port: 18095 } },
        };
        saveModelHost(base, dir);
        saveModelHost(hostB, dir);
        process.env["LOCAL_AI_RUNTIME_DIR"] = dir;

        const client: WorkloadClient = {
          ...makeClient(),
          modelHostStatus: { query: () => Promise.resolve({ state: "Stopped" }) },
          modelHostStart: {
            subscribe: (input, callbacks): { unsubscribe: () => undefined } => {
              started.push(input.workload);
              if (input.workload === "host-a") {
                saveModelHost(withManagedBy(hostB), dir);
              }
              queueMicrotask(() => {
                callbacks.onData({ type: "done", result: { ok: true } });
                callbacks.onComplete();
              });
              return { unsubscribe: (): undefined => undefined };
            },
          },
        };

        const result = await reconcileOnce({ workloadsDir: dir, getClient: () => client });

        expect(started).toEqual(["host-a"]);
        expect(loadModelHostByName("host-b", dir).metadata.labels?.["llamactl.io/managed-by"]).toBe(
          "mac-mini",
        );
        expect(result.errors).toBe(0);
        expect(result.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "local", action: "started" },
          {
            kind: "ModelHost",
            name: "host-b",
            node: "local",
            action: "skipped-external",
            managedBy: "mac-mini",
          },
        ]);
      } finally {
        if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
        else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("keeps a marker written during the host's own in-flight start", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-external-self-race-"));
      const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
      try {
        const manifest = makeHostManifest();
        saveModelHost(manifest, dir);
        process.env["LOCAL_AI_RUNTIME_DIR"] = dir;

        const client: WorkloadClient = {
          ...makeClient(),
          modelHostStatus: { query: () => Promise.resolve({ state: "Stopped" }) },
          modelHostStart: {
            subscribe: (input, callbacks): { unsubscribe: () => undefined } => {
              saveModelHost(withManagedBy(loadModelHostByName(input.workload, dir)), dir);
              queueMicrotask(() => {
                callbacks.onData({ type: "done", result: { ok: true } });
                callbacks.onComplete();
              });
              return { unsubscribe: (): undefined => undefined };
            },
          },
        };

        const result = await reconcileOnce({ workloadsDir: dir, getClient: () => client });

        expect(result.errors).toBe(0);
        expect(result.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "local", action: "started" },
        ]);
        expect(loadModelHostByName("host-a", dir).metadata.labels?.["llamactl.io/managed-by"]).toBe(
          "mac-mini",
        );
      } finally {
        if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
        else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("node RPC deadlines", () => {
    test("an unreachable node times out without stalling the pass", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-timeout-"));
      try {
        const run: ModelRun = {
          ...makeRunManifest(),
          spec: { ...makeRunManifest().spec, node: "z13" },
        };
        const host: ModelHostManifest = {
          ...makeHostManifest(),
          spec: { ...makeHostManifest().spec, node: "mac-mini" },
        };
        saveWorkload(run, dir);
        saveModelHost(host, dir);

        const startedAt = Date.now();
        const result = await reconcileOnce({
          workloadsDir: dir,
          rpcTimeouts: { queryMs: 50, mutateMs: 50 },
          getClient: (node): WorkloadClient =>
            node === "z13"
              ? {
                  ...makeClient(),
                  serverStatus: {
                    query: (): Promise<never> => new Promise<never>(() => undefined),
                  },
                }
              : {
                  ...makeClient(),
                  modelHostStatus: {
                    query: (): Promise<{ state: string; pid: number; specHash: string }> =>
                      Promise.resolve({
                        state: "Running",
                        pid: 1234,
                        specHash: computeModelHostSpecHash(specForHash(host.spec)),
                      }),
                  },
                },
        });

        expect(Date.now() - startedAt).toBeLessThan(2000);
        expect(result.errors).toBe(1);
        const runReport = result.reports.find((r) => r.name === "run-a");
        expect(runReport?.node).toBe("z13");
        expect(runReport?.action).toBe("unchanged");
        expect(runReport?.error).toMatch(/z13/);
        expect(runReport?.error).toMatch(/did not respond/);
        const hostReport = result.reports.find((r) => r.name === "host-a");
        expect(hostReport?.action).toBe("unchanged");
        expect(hostReport?.error).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
