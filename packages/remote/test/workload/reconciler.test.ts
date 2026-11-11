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
import {
  type ReconcileNodeReport,
  reconcileOnce,
  type ReconcileResult,
} from "../../src/workload/reconciler.js";
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

type ServerStatusResult = Awaited<ReturnType<WorkloadClient["serverStatus"]["query"]>>;

function downStatus(): ServerStatusResult {
  return {
    state: "down",
    rel: null,
    extraArgs: [],
    pid: null,
    host: null,
    port: null,
    binary: null,
    endpoint: "",
  };
}

/**
 * #221: a query that never answers on its own. The deadline wrapper hands
 * every query an AbortSignal as its second argument; when the pass deadline
 * fires it aborts that signal, which lands `${tag}:deadline` in the log and
 * rejects the call — the observable proof a node's deadline elapsed.
 */
function hangingStatusQuery(log: string[], tag: string) {
  return (_input?: unknown, o?: { signal?: AbortSignal }): Promise<never> => {
    log.push(`${tag}:query`);
    const signal = o?.signal;
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        log.push(`${tag}:deadline`);
        reject(signal.reason as Error);
      });
    });
  };
}

/** #221: counts queries in flight across every client sharing `counter`. */
function inFlightStatusQuery(counter: { current: number; max: number }) {
  return async (): Promise<ServerStatusResult> => {
    counter.current += 1;
    counter.max = Math.max(counter.max, counter.current);
    await new Promise((resolve) => setTimeout(resolve, 30));
    counter.current -= 1;
    return downStatus();
  };
}

function modelRunOn(node: string, name: string, rel: string): ModelRun {
  const base = makeRunManifest();
  return {
    ...base,
    metadata: { name, labels: {}, annotations: {} },
    spec: { ...base.spec, node, target: { kind: "rel", value: rel } },
  };
}

function hostManifestOn(node: string): ModelHostManifest {
  const base = makeHostManifest();
  return { ...base, spec: { ...base.spec, node } };
}

/** A client whose modelHostStatus reports Running with the manifest's own specHash. */
function runningHostClient(host: ModelHostManifest, onQuery?: () => void): WorkloadClient {
  return {
    ...makeClient(),
    modelHostStatus: {
      query: (): ReturnType<WorkloadClient["modelHostStatus"]["query"]> => {
        onQuery?.();
        return Promise.resolve({
          state: "Running",
          pid: 1234,
          specHash: computeModelHostSpecHash(specForHash(host.spec)),
        });
      },
    },
  };
}

/**
 * #221 ordering contract: the healthy node's query must land before the
 * slow node's deadline fires, and the deadline must be the last entry —
 * proof the two nodes reconciled concurrently rather than in series.
 */
function expectMacMiniBeforeZ13Deadline(log: string[]): void {
  expect(log).toHaveLength(3);
  expect(log.indexOf("mac-mini:query")).toBeGreaterThanOrEqual(0);
  expect(log.indexOf("mac-mini:query")).toBeLessThan(log.indexOf("z13:deadline"));
  expect(log[log.length - 1]).toBe("z13:deadline");
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

    test("records a NodeUnreachable ReconcileError when the local node times out", async () => {
      await withRuntime("llamactl-reconciler-cond-unreachable-", async (dir, runtime) => {
        saveModelHost(makeHostManifest(), dir);
        const message = "node 'local' did not respond to modelHostStatus.query within 20 ms";
        const result = await reconcileOnce({
          workloadsDir: dir,
          rpcTimeouts: { queryMs: 20, mutateMs: 20 },
          getClient: (): WorkloadClient => ({
            ...makeClient(),
            modelHostStatus: { query: (): Promise<never> => new Promise<never>(() => undefined) },
          }),
        });
        expect(result.errors).toBe(1);
        expect(result.reports).toEqual([
          {
            kind: "ModelHost",
            name: "host-a",
            node: "local",
            action: "unchanged",
            error: message,
            reason: "NodeUnreachable",
          },
        ]);
        expect(readModelHostRuntimeStatus({ name: "host-a" }, runtime)?.conditions).toEqual([
          expect.objectContaining({
            type: "ReconcileError",
            status: "True",
            reason: "NodeUnreachable",
            message,
          }),
        ]);
      });
    });

    describe("remote ModelHost controller history (#308)", () => {
      const T1 = new Date("2026-11-05T12:00:00.000Z");
      const T2 = new Date("2026-11-05T12:05:00.000Z");

      type HostStatus = { state: string; specHash?: string };
      type HostStartOutcome =
        | { ok: true; pid: number; state: string }
        | { ok: false; error: string };

      interface ControllerHistory {
        conditions?: {
          count?: number;
          firstSeen?: string;
          lastSeen?: string;
          message?: string;
          reason?: string;
          status?: string;
          type?: string;
        }[];
        lastKnownRunning?: boolean;
        lastRestartAt?: string | null;
        lastRestartReason?: string | null;
        node?: string;
        restarts?: number;
        updatedAt?: string;
        workload?: string;
      }

      function remoteHostManifest(): ModelHostManifest {
        return {
          ...makeHostManifest(),
          spec: { ...makeHostManifest().spec, node: "gpu1" },
        };
      }

      function historyPath(dir: string): string {
        return join(dir, ".modelhost-history", "gpu1", "host-a.json");
      }

      function readHistory(dir: string): ControllerHistory {
        const path = historyPath(dir);
        expect(fs.existsSync(path)).toBe(true);
        return JSON.parse(fs.readFileSync(path, "utf8")) as ControllerHistory;
      }

      function remoteGetClient(
        readStatus: () => HostStatus,
        readStart: () => HostStartOutcome,
      ): () => WorkloadClient {
        return (): WorkloadClient => ({
          ...makeClient(),
          modelHostStatus: { query: () => Promise.resolve(readStatus()) },
          modelHostStart: startStub(readStart),
        });
      }

      test("records a remote restart in controller history when the engine is found dead", async () => {
        await withRuntime("llamactl-reconciler-hist-dead-", async (dir) => {
          const manifest = remoteHostManifest();
          saveModelHost(manifest, dir);
          let clock = T1;
          const now = (): Date => clock;
          let status: HostStatus = {
            state: "Running",
            specHash: computeModelHostSpecHash(specForHash(manifest.spec)),
          };
          const startOutcome: HostStartOutcome = { ok: true, pid: 4321, state: "Running" };
          const getClient = remoteGetClient(
            () => status,
            () => startOutcome,
          );
          const opts = { workloadsDir: dir, getClient, now };

          const converged = await reconcileOnce(opts);
          expect(converged.reports).toEqual([
            { kind: "ModelHost", name: "host-a", node: "gpu1", action: "unchanged" },
          ]);

          clock = T2;
          status = { state: "Stopped" };
          const restarted = await reconcileOnce(opts);
          expect(restarted.reports).toEqual([
            {
              kind: "ModelHost",
              name: "host-a",
              node: "gpu1",
              action: "started",
              foundDead: true,
            },
          ]);

          expect(readHistory(dir)).toMatchObject({
            node: "gpu1",
            workload: "host-a",
            restarts: 1,
            lastRestartReason: "EngineExited",
            lastRestartAt: T2.toISOString(),
            lastKnownRunning: true,
            updatedAt: T2.toISOString(),
          });
        });
      });

      test("records a remote spec-drift restart in controller history", async () => {
        await withRuntime("llamactl-reconciler-hist-drift-", async (dir) => {
          saveModelHost(remoteHostManifest(), dir);
          const clock = T1;
          const now = (): Date => clock;
          const status: HostStatus = { state: "Running", specHash: "other" };
          const startOutcome: HostStartOutcome = { ok: true, pid: 4321, state: "Running" };
          const getClient = remoteGetClient(
            () => status,
            () => startOutcome,
          );
          const opts = { workloadsDir: dir, getClient, now };

          const result = await reconcileOnce(opts);
          expect(result.reports).toEqual([
            { kind: "ModelHost", name: "host-a", node: "gpu1", action: "restarted" },
          ]);
          expect(readHistory(dir)).toMatchObject({
            restarts: 1,
            lastRestartReason: "SpecChanged",
            lastRestartAt: T1.toISOString(),
          });
        });
      });

      test("records a remote reconcile-error episode and its recovery in controller history", async () => {
        await withRuntime("llamactl-reconciler-hist-errors-", async (dir) => {
          saveModelHost(remoteHostManifest(), dir);
          let clock = T1;
          const now = (): Date => clock;
          const status: HostStatus = { state: "Stopped" };
          let startOutcome: HostStartOutcome = { ok: false, error: MISMATCH };
          const getClient = remoteGetClient(
            () => status,
            () => startOutcome,
          );
          const opts = { workloadsDir: dir, getClient, now };
          const failedReport: ReconcileNodeReport = {
            kind: "ModelHost",
            name: "host-a",
            node: "gpu1",
            action: "unchanged",
            error: MISMATCH,
          };

          const first = await reconcileOnce(opts);
          clock = T2;
          const second = await reconcileOnce(opts);
          expect(first.reports).toEqual([failedReport]);
          expect(second.reports).toEqual([failedReport]);
          expect(readHistory(dir).conditions).toEqual([
            expect.objectContaining({
              type: "ReconcileError",
              status: "True",
              reason: "ApplyFailed",
              message: MISMATCH,
              count: 2,
              firstSeen: T1.toISOString(),
              lastSeen: T2.toISOString(),
            }),
          ]);

          startOutcome = { ok: true, pid: 4321, state: "Running" };
          const recovered = await reconcileOnce(opts);
          expect(recovered.reports).toEqual([
            { kind: "ModelHost", name: "host-a", node: "gpu1", action: "started" },
          ]);
          const history = readHistory(dir);
          expect(history.conditions?.[0]).toMatchObject({
            status: "False",
            reason: "Recovered",
            count: 2,
          });
          expect(history.restarts).toBe(0);
          expect(history.lastKnownRunning).toBe(true);
        });
      });

      test("records a remote NodeUnreachable condition in controller history", async () => {
        await withRuntime("llamactl-reconciler-hist-unreachable-", async (dir) => {
          saveModelHost(remoteHostManifest(), dir);
          const clock = T1;
          const now = (): Date => clock;
          const getClient = (): WorkloadClient => ({
            ...makeClient(),
            modelHostStatus: {
              query: (): Promise<never> => new Promise<never>(() => undefined),
            },
          });
          const opts = {
            workloadsDir: dir,
            getClient,
            now,
            rpcTimeouts: { queryMs: 20, mutateMs: 20 },
          };

          const result = await reconcileOnce(opts);
          expect(result.errors).toBe(1);
          expect(readHistory(dir).conditions?.[0]).toMatchObject({
            type: "ReconcileError",
            status: "True",
            reason: "NodeUnreachable",
          });
        });
      });

      test("records a fresh remote start in controller history without a restart", async () => {
        await withRuntime("llamactl-reconciler-hist-fresh-", async (dir) => {
          saveModelHost(remoteHostManifest(), dir);
          const clock = T1;
          const now = (): Date => clock;
          const status: HostStatus = { state: "Stopped" };
          const startOutcome: HostStartOutcome = { ok: true, pid: 4321, state: "Running" };
          const getClient = remoteGetClient(
            () => status,
            () => startOutcome,
          );
          const opts = { workloadsDir: dir, getClient, now };

          const result = await reconcileOnce(opts);
          expect(result.reports).toEqual([
            { kind: "ModelHost", name: "host-a", node: "gpu1", action: "started" },
          ]);
          expect(readHistory(dir)).toMatchObject({ restarts: 0, lastKnownRunning: true });
        });
      });

      test("resets lastKnownRunning when a remote host is disabled", async () => {
        await withRuntime("llamactl-reconciler-hist-toggle-", async (dir) => {
          const manifest = remoteHostManifest();
          saveModelHost(manifest, dir);
          let clock = T1;
          const now = (): Date => clock;
          let status: HostStatus = {
            state: "Running",
            specHash: computeModelHostSpecHash(specForHash(manifest.spec)),
          };
          const startOutcome: HostStartOutcome = { ok: true, pid: 4321, state: "Running" };
          const getClient = remoteGetClient(
            () => status,
            () => startOutcome,
          );
          const opts = { workloadsDir: dir, getClient, now };

          const converged = await reconcileOnce(opts);
          expect(converged.reports).toEqual([
            { kind: "ModelHost", name: "host-a", node: "gpu1", action: "unchanged" },
          ]);

          clock = T2;
          status = { state: "Stopped" };
          saveModelHost({ ...manifest, spec: { ...manifest.spec, enabled: false } }, dir);
          await reconcileOnce(opts);
          expect(readHistory(dir).lastKnownRunning).toBe(false);

          saveModelHost({ ...manifest, spec: { ...manifest.spec, enabled: true } }, dir);
          const restarted = await reconcileOnce(opts);
          expect(restarted.reports).toEqual([
            { kind: "ModelHost", name: "host-a", node: "gpu1", action: "started" },
          ]);
          expect(readHistory(dir).restarts).toBe(0);
        });
      });

      test("writes no controller history on an unchanged pass after the first converged one", async () => {
        await withRuntime("llamactl-reconciler-hist-unchanged-", async (dir) => {
          const manifest = remoteHostManifest();
          saveModelHost(manifest, dir);
          let clock = T1;
          const now = (): Date => clock;
          const status: HostStatus = {
            state: "Running",
            specHash: computeModelHostSpecHash(specForHash(manifest.spec)),
          };
          const startOutcome: HostStartOutcome = { ok: true, pid: 4321, state: "Running" };
          const getClient = remoteGetClient(
            () => status,
            () => startOutcome,
          );
          const opts = { workloadsDir: dir, getClient, now };

          const first = await reconcileOnce(opts);
          expect(first.reports).toEqual([
            { kind: "ModelHost", name: "host-a", node: "gpu1", action: "unchanged" },
          ]);
          expect(readHistory(dir)).toMatchObject({
            updatedAt: T1.toISOString(),
            lastKnownRunning: true,
          });
          const written = fs.readFileSync(historyPath(dir), "utf8");

          clock = T2;
          const second = await reconcileOnce(opts);
          expect(second.reports).toEqual([
            { kind: "ModelHost", name: "host-a", node: "gpu1", action: "unchanged" },
          ]);
          expect(fs.readFileSync(historyPath(dir), "utf8")).toBe(written);
          expect(readHistory(dir).updatedAt).toBe(T1.toISOString());
        });
      });

      test("writes no controller history for a local host", async () => {
        await withRuntime("llamactl-reconciler-hist-local-", async (dir) => {
          const manifest = makeHostManifest();
          saveModelHost(manifest, dir);
          seedRunningSidecar(dir, manifest);
          const clock = T1;
          const now = (): Date => clock;
          const getClient = (): WorkloadClient => ({
            ...makeClient(),
            modelHostStatus: { query: () => Promise.resolve({ state: "Stopped" }) },
            modelHostStart: startStub(() => ({ ok: true, pid: 4321, state: "Running" })),
          });
          const opts = { workloadsDir: dir, getClient, now };

          const result = await reconcileOnce(opts);
          expect(result.reports).toEqual([
            {
              kind: "ModelHost",
              name: "host-a",
              node: "local",
              action: "started",
              foundDead: true,
            },
          ]);
          expect(fs.existsSync(join(dir, ".modelhost-history"))).toBe(false);
        });
      });
    });
  });

  describe("restartPolicy Never ModelHosts (#332)", () => {
    function hostOn(
      node: string,
      restartPolicy: ModelHostManifest["spec"]["restartPolicy"],
    ): ModelHostManifest {
      const base = makeHostManifest();
      return { ...base, spec: { ...base.spec, node, restartPolicy } };
    }

    function countingClient(state: string, starts: { count: number }): WorkloadClient {
      return {
        ...makeClient(),
        modelHostStatus: { query: () => Promise.resolve({ state }) },
        modelHostStart: {
          subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
            starts.count += 1;
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
      };
    }

    function failingStartClient(state: string, starts: { count: number }): WorkloadClient {
      return {
        ...makeClient(),
        modelHostStatus: { query: () => Promise.resolve({ state }) },
        modelHostStart: {
          subscribe: (_input, callbacks): { unsubscribe: () => undefined } => {
            starts.count += 1;
            queueMicrotask(() => {
              callbacks.onData({
                type: "done",
                result: { ok: false, error: "engine exited before ready" },
              });
              callbacks.onComplete();
            });
            return { unsubscribe: (): undefined => undefined };
          },
        },
      };
    }

    async function inRuntimeDir(
      prefix: string,
      body: (dir: string) => Promise<void>,
    ): Promise<void> {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      const previousRuntimeDir = process.env["LOCAL_AI_RUNTIME_DIR"];
      try {
        process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
        await body(dir);
      } finally {
        if (previousRuntimeDir === undefined) delete process.env["LOCAL_AI_RUNTIME_DIR"];
        else process.env["LOCAL_AI_RUNTIME_DIR"] = previousRuntimeDir;
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // Launch record of a killed engine; specHash null writes a record without the field.
    function seedLaunchRecord(
      dir: string,
      manifest: ModelHostManifest,
      specHash: string | null,
    ): void {
      writeModelHostState(
        {
          kind: "ModelHost",
          engine: manifest.spec.engine,
          pid: 1234,
          host: manifest.spec.endpoint.host,
          port: manifest.spec.endpoint.port,
          modelAliases: [manifest.spec.hostedModels[0]!.rel],
          startedAt: new Date().toISOString(),
          ...(specHash !== null ? { specHash } : {}),
        },
        { name: manifest.metadata.name },
        resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir }),
      );
    }

    test("does not restart an enabled local Never host whose engine died", async () => {
      await inRuntimeDir("llamactl-reconciler-never-local-", async (dir) => {
        const manifest = hostOn("local", "Never");
        saveModelHost(manifest, dir);
        // Launch record of the killed engine: an Always host would restart with foundDead.
        seedRunningSidecar(dir, manifest);
        const starts = { count: 0 };
        const result = await reconcileOnce({
          workloadsDir: dir,
          getClient: () => countingClient("Stopped", starts),
        });
        expect(starts.count).toBe(0);
        expect(result.errors).toBe(0);
        expect(result.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "local", action: "unchanged" },
        ]);
      });
    });

    test("does not restart an enabled remote Never host that is stopped", async () => {
      await inRuntimeDir("llamactl-reconciler-never-remote-", async (dir) => {
        saveModelHost(hostOn("gpu1", "Never"), dir);
        const starts = { count: 0 };
        const result = await reconcileOnce({
          workloadsDir: dir,
          getClient: () => countingClient("Stopped", starts),
        });
        expect(starts.count).toBe(0);
        expect(result.errors).toBe(0);
        expect(result.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "gpu1", action: "unchanged" },
        ]);
      });
    });

    test("still starts a local Never host that has no launch record", async () => {
      await inRuntimeDir("llamactl-reconciler-never-fresh-", async (dir) => {
        // No launch record: never started here, as after an `apply -f` hand-off.
        saveModelHost(hostOn("local", "Never"), dir);
        const starts = { count: 0 };
        const result = await reconcileOnce({
          workloadsDir: dir,
          getClient: () => countingClient("Stopped", starts),
        });
        expect(starts.count).toBe(1);
        expect(result.errors).toBe(0);
        expect(result.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "local", action: "started" },
        ]);
      });
    });

    test("still starts a stopped remote Always host", async () => {
      await inRuntimeDir("llamactl-reconciler-always-remote-", async (dir) => {
        saveModelHost(hostOn("gpu1", "Always"), dir);
        const starts = { count: 0 };
        const result = await reconcileOnce({
          workloadsDir: dir,
          getClient: () => countingClient("Stopped", starts),
        });
        expect(starts.count).toBe(1);
        expect(result.errors).toBe(0);
        expect(result.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "gpu1", action: "started" },
        ]);
      });
    });

    test("still restarts a Running remote Never host whose spec hash does not match", async () => {
      await inRuntimeDir("llamactl-reconciler-never-running-", async (dir) => {
        saveModelHost(hostOn("gpu1", "Never"), dir);
        const starts = { count: 0 };
        // No specHash in the status: observed differs from desired, so this is drift.
        const result = await reconcileOnce({
          workloadsDir: dir,
          getClient: () => countingClient("Running", starts),
        });
        expect(starts.count).toBe(1);
        expect(result.errors).toBe(0);
        expect(result.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "gpu1", action: "restarted" },
        ]);
      });
    });

    test("starts a local Never host whose spec changed while it was down", async () => {
      await inRuntimeDir("llamactl-reconciler-never-edited-", async (dir) => {
        const launched = hostOn("local", "Never");
        // The killed engine's launch record carries the hash of the spec it ran with.
        seedLaunchRecord(dir, launched, computeModelHostSpecHash(specForHash(launched.spec)));
        // The manifest was edited while the engine was down.
        saveModelHost({ ...launched, spec: { ...launched.spec, timeoutSeconds: 120 } }, dir);
        const starts = { count: 0 };
        const result = await reconcileOnce({
          workloadsDir: dir,
          getClient: () => countingClient("Stopped", starts),
        });
        expect(starts.count).toBe(1);
        expect(result.errors).toBe(0);
        expect(result.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "local", action: "started", foundDead: true },
        ]);
        const runtime = resolveEnv({ LOCAL_AI_RUNTIME_DIR: dir });
        expect(readModelHostRuntimeStatus({ name: "host-a" }, runtime)).toMatchObject({
          restarts: 1,
          lastRestartReason: "EngineExited",
        });
      });
    });

    test("does not restart a local Never host whose launch record has no specHash", async () => {
      await inRuntimeDir("llamactl-reconciler-never-nohash-", async (dir) => {
        const manifest = hostOn("local", "Never");
        saveModelHost(manifest, dir);
        // A record written before specHash existed proves no spec change.
        seedLaunchRecord(dir, manifest, null);
        const starts = { count: 0 };
        const result = await reconcileOnce({
          workloadsDir: dir,
          getClient: () => countingClient("Stopped", starts),
        });
        expect(starts.count).toBe(0);
        expect(result.errors).toBe(0);
        expect(result.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "local", action: "unchanged" },
        ]);
      });
    });

    test("does not restart a stopped remote Never host that reports another specHash", async () => {
      await inRuntimeDir("llamactl-reconciler-never-remote-hash-", async (dir) => {
        saveModelHost(hostOn("gpu1", "Never"), dir);
        const starts = { count: 0 };
        const client: WorkloadClient = {
          ...countingClient("Stopped", starts),
          modelHostStatus: {
            query: () => Promise.resolve({ state: "Stopped", specHash: "remote-other" }),
          },
        };
        const result = await reconcileOnce({ workloadsDir: dir, getClient: () => client });
        expect(starts.count).toBe(0);
        expect(result.errors).toBe(0);
        expect(result.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "gpu1", action: "unchanged" },
        ]);
      });
    });

    // #358: a first start that fails before readiness is still the Never
    // host's one attempt — later passes must not retry it.
    test("starts a fresh local Never host at most once when its first start fails before readiness", async () => {
      await inRuntimeDir("llamactl-reconciler-never-failed-", async (dir) => {
        saveModelHost(hostOn("local", "Never"), dir);
        const starts = { count: 0 };
        const getClient = (): WorkloadClient => failingStartClient("Stopped", starts);

        const r1 = await reconcileOnce({ workloadsDir: dir, getClient });
        expect(starts.count).toBe(1);
        expect(r1.errors).toBe(1);
        expect(r1.reports).toEqual([
          {
            kind: "ModelHost",
            name: "host-a",
            node: "local",
            action: "unchanged",
            error: "engine exited before ready",
          },
        ]);

        const r2 = await reconcileOnce({ workloadsDir: dir, getClient });
        expect(starts.count).toBe(1);
        expect(r2.errors).toBe(0);
        expect(r2.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "local", action: "unchanged" },
        ]);
      });
    });

    test("gives a local Never host one new attempt after its spec is edited following a failed first start", async () => {
      await inRuntimeDir("llamactl-reconciler-never-failed-edit-", async (dir) => {
        const manifest = hostOn("local", "Never");
        saveModelHost(manifest, dir);
        const starts = { count: 0 };
        const getClient = (): WorkloadClient => failingStartClient("Stopped", starts);

        await reconcileOnce({ workloadsDir: dir, getClient });
        expect(starts.count).toBe(1);

        saveModelHost({ ...manifest, spec: { ...manifest.spec, timeoutSeconds: 120 } }, dir);
        await reconcileOnce({ workloadsDir: dir, getClient });
        expect(starts.count).toBe(2);

        const r3 = await reconcileOnce({ workloadsDir: dir, getClient });
        expect(starts.count).toBe(2);
        expect(r3.errors).toBe(0);
        expect(r3.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "local", action: "unchanged" },
        ]);
      });
    });

    test("gives a re-enabled local Never host one new attempt after a failed first start", async () => {
      await inRuntimeDir("llamactl-reconciler-never-failed-reenable-", async (dir) => {
        const manifest = hostOn("local", "Never");
        saveModelHost(manifest, dir);
        const starts = { count: 0 };
        const getClient = (): WorkloadClient => failingStartClient("Stopped", starts);

        await reconcileOnce({ workloadsDir: dir, getClient });
        expect(starts.count).toBe(1);

        saveModelHost({ ...manifest, spec: { ...manifest.spec, enabled: false } }, dir);
        const sweep = await reconcileOnce({ workloadsDir: dir, getClient });
        expect(starts.count).toBe(1);
        expect(sweep.errors).toBe(0);

        saveModelHost({ ...manifest, spec: { ...manifest.spec, enabled: true } }, dir);
        await reconcileOnce({ workloadsDir: dir, getClient });
        expect(starts.count).toBe(2);

        const r4 = await reconcileOnce({ workloadsDir: dir, getClient });
        expect(starts.count).toBe(2);
        expect(r4.errors).toBe(0);
        expect(r4.reports).toEqual([
          { kind: "ModelHost", name: "host-a", node: "local", action: "unchanged" },
        ]);
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

  describe("ModelHost eviction markers", () => {
    test("an evicted-by/evicted-at marker stamped during an in-flight apply survives the save", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-evict-race-"));
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
              // A verified eviction stamps its intent on disk while this
              // apply is in flight; the post-apply save must carry it forward
              // or the next pass resurrects the victim.
              const fresh = loadModelHostByName(input.workload, dir);
              saveModelHost(
                {
                  ...fresh,
                  metadata: {
                    ...fresh.metadata,
                    annotations: {
                      ...fresh.metadata.annotations,
                      "llamactl.io/evicted-by": "incoming-run",
                      "llamactl.io/evicted-at": "2026-11-09T12:00:00.000Z",
                    },
                  },
                },
                dir,
              );
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
        const persisted = loadModelHostByName("host-a", dir);
        expect(persisted.metadata.annotations?.["llamactl.io/evicted-by"]).toBe("incoming-run");
        expect(persisted.metadata.annotations?.["llamactl.io/evicted-at"]).toBe(
          "2026-11-09T12:00:00.000Z",
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

    test("a node that timed out is skipped for the rest of the pass", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-skip-"));
      try {
        const runA: ModelRun = {
          ...makeRunManifest(),
          spec: { ...makeRunManifest().spec, node: "z13" },
        };
        const runB: ModelRun = {
          ...makeRunManifest(),
          metadata: { name: "run-b", labels: {}, annotations: {} },
          spec: {
            ...makeRunManifest().spec,
            node: "z13",
            target: { kind: "rel", value: "mlx-community/run-b.gguf" },
          },
        };
        const host: ModelHostManifest = {
          ...makeHostManifest(),
          spec: { ...makeHostManifest().spec, node: "mac-mini" },
        };
        saveWorkload(runA, dir);
        saveWorkload(runB, dir);
        saveModelHost(host, dir);

        let z13Calls = 0;
        const startedAt = Date.now();
        const result = await reconcileOnce({
          workloadsDir: dir,
          rpcTimeouts: { queryMs: 50, mutateMs: 50 },
          getClient: (node): WorkloadClient =>
            node === "z13"
              ? {
                  ...makeClient(),
                  serverStatus: {
                    query: (): Promise<never> => {
                      z13Calls++;
                      return new Promise<never>(() => undefined);
                    },
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

        expect(z13Calls).toBe(1);
        expect(result.errors).toBe(2);
        const runAReport = result.reports.find((r) => r.name === "run-a");
        const runBReport = result.reports.find((r) => r.name === "run-b");
        expect(runAReport?.node).toBe("z13");
        expect(runAReport?.action).toBe("unchanged");
        expect(runAReport?.error).toMatch(/z13/);
        expect(runBReport?.node).toBe("z13");
        expect(runBReport?.action).toBe("unchanged");
        expect(runBReport?.error).toMatch(/z13/);
        const errors = [runAReport?.error ?? "", runBReport?.error ?? ""];
        expect(errors.filter((e) => e.includes("did not respond"))).toHaveLength(1);
        expect(errors.filter((e) => e.includes("skipped"))).toHaveLength(1);
        const hostReport = result.reports.find((r) => r.name === "host-a");
        expect(hostReport?.action).toBe("unchanged");
        expect(hostReport?.error).toBeUndefined();
        expect(Date.now() - startedAt).toBeLessThan(2000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("ModelHosts on a timed-out node report NodeUnreachable, the skipped one included", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-unreachable-host-"));
      try {
        const hostA: ModelHostManifest = {
          ...makeHostManifest(),
          spec: { ...makeHostManifest().spec, node: "z13" },
        };
        const hostB: ModelHostManifest = {
          ...makeHostManifest(),
          metadata: { name: "host-b" },
          spec: {
            ...makeHostManifest().spec,
            node: "z13",
            endpoint: { host: "127.0.0.1", port: 18095 },
          },
        };
        saveModelHost(hostA, dir);
        saveModelHost(hostB, dir);

        let z13Calls = 0;
        const result = await reconcileOnce({
          workloadsDir: dir,
          rpcTimeouts: { queryMs: 20, mutateMs: 20 },
          getClient: (): WorkloadClient => ({
            ...makeClient(),
            modelHostStatus: {
              query: (): Promise<never> => {
                z13Calls++;
                return new Promise<never>(() => undefined);
              },
            },
          }),
        });

        expect(z13Calls).toBe(1);
        expect(result.errors).toBe(2);
        const a = result.reports.find((r) => r.name === "host-a");
        const b = result.reports.find((r) => r.name === "host-b");
        expect([a?.kind, b?.kind]).toEqual(["ModelHost", "ModelHost"]);
        expect([a?.action, b?.action]).toEqual(["unchanged", "unchanged"]);
        expect([a?.reason, b?.reason]).toEqual(["NodeUnreachable", "NodeUnreachable"]);
        const errors = [a?.error ?? "", b?.error ?? ""];
        expect(
          errors.filter((e) => e.includes("did not respond to modelHostStatus.query")),
        ).toHaveLength(1);
        expect(
          errors.filter((e) => e.includes("skipped modelHostStatus.query for this pass")),
        ).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("ModelRuns on a timed-out node report NodeUnreachable, the skipped one included", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-unreachable-run-"));
      try {
        const runA: ModelRun = {
          ...makeRunManifest(),
          spec: { ...makeRunManifest().spec, node: "z13" },
        };
        const runB: ModelRun = {
          ...makeRunManifest(),
          metadata: { name: "run-b", labels: {}, annotations: {} },
          spec: {
            ...makeRunManifest().spec,
            node: "z13",
            target: { kind: "rel", value: "mlx-community/run-b.gguf" },
          },
        };
        saveWorkload(runA, dir);
        saveWorkload(runB, dir);

        let z13Calls = 0;
        const result = await reconcileOnce({
          workloadsDir: dir,
          rpcTimeouts: { queryMs: 20, mutateMs: 20 },
          getClient: (): WorkloadClient => ({
            ...makeClient(),
            serverStatus: {
              query: (): Promise<never> => {
                z13Calls++;
                return new Promise<never>(() => undefined);
              },
            },
          }),
        });

        expect(z13Calls).toBe(1);
        expect(result.errors).toBe(2);
        const a = result.reports.find((r) => r.name === "run-a");
        const b = result.reports.find((r) => r.name === "run-b");
        expect([a?.kind, b?.kind]).toEqual(["ModelRun", "ModelRun"]);
        expect([a?.action, b?.action]).toEqual(["unchanged", "unchanged"]);
        expect([a?.reason, b?.reason]).toEqual(["NodeUnreachable", "NodeUnreachable"]);
        const errors = [a?.error ?? "", b?.error ?? ""];
        expect(
          errors.filter((e) => e.includes("did not respond to serverStatus.query")),
        ).toHaveLength(1);
        expect(
          errors.filter((e) => e.includes("skipped serverStatus.query for this pass")),
        ).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("an error the node answers with carries no NodeUnreachable reason", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-answered-error-"));
      try {
        saveWorkload(
          { ...makeRunManifest(), spec: { ...makeRunManifest().spec, node: "z13" } },
          dir,
        );
        saveModelHost(
          { ...makeHostManifest(), spec: { ...makeHostManifest().spec, node: "z13" } },
          dir,
        );

        const result = await reconcileOnce({
          workloadsDir: dir,
          rpcTimeouts: { queryMs: 60_000, mutateMs: 60_000 },
          getClient: (): WorkloadClient => ({
            ...makeClient(),
            serverStatus: { query: (): Promise<never> => Promise.reject(new Error("boom")) },
            modelHostStatus: { query: (): Promise<never> => Promise.reject(new Error("boom")) },
          }),
        });

        expect(result.errors).toBe(2);
        expect(result.reports).toEqual([
          { kind: "ModelRun", name: "run-a", node: "z13", action: "unchanged", error: "boom" },
          { kind: "ModelHost", name: "host-a", node: "z13", action: "unchanged", error: "boom" },
        ]);
        expect(result.reports.filter((r) => "reason" in r)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a per-node deadline bounds a silent node when the pass default is long", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-per-node-"));
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

        const outcome = await Promise.race([
          reconcileOnce({
            workloadsDir: dir,
            rpcTimeouts: { queryMs: 60_000, mutateMs: 60_000 },
            rpcTimeoutsFor: (node: string) =>
              node === "z13" ? { queryMs: 20, mutateMs: 20 } : undefined,
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
          }),
          new Promise<"stalled">((resolve) => {
            setTimeout(() => {
              resolve("stalled");
            }, 1000);
          }),
        ]);

        expect(outcome).not.toBe("stalled");
        const result = outcome as ReconcileResult;
        const runReport = result.reports.find((r) => r.name === "run-a");
        expect(runReport?.error).toMatch(/did not respond to serverStatus\.query within 20 ms/);
        expect(runReport?.reason).toBe("NodeUnreachable");
        const hostReport = result.reports.find((r) => r.name === "host-a");
        expect(hostReport?.action).toBe("unchanged");
        expect(hostReport?.error).toBeUndefined();
        expect(result.errors).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a per-node mutateMs bounds a hung serverStop.mutate when the pass default is long", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-per-node-mutate-"));
      try {
        const run: ModelRun = {
          ...makeRunManifest(),
          spec: { ...makeRunManifest().spec, node: "z13", enabled: false },
        };
        saveWorkload(run, dir);

        const outcome = await Promise.race([
          reconcileOnce({
            workloadsDir: dir,
            rpcTimeouts: { queryMs: 60_000, mutateMs: 60_000 },
            rpcTimeoutsFor: (node: string) => (node === "z13" ? { mutateMs: 20 } : undefined),
            getClient: (): WorkloadClient => ({
              ...makeClient(),
              serverStatus: {
                query: () =>
                  Promise.resolve({
                    state: "up",
                    rel: "mlx-community/run-a.gguf",
                    extraArgs: [],
                    pid: 111,
                    host: "127.0.0.1",
                    port: 18080,
                    binary: null,
                    endpoint: "http://127.0.0.1:18080",
                  }),
              },
              serverStop: { mutate: (): Promise<never> => new Promise<never>(() => undefined) },
            }),
          }),
          new Promise<"stalled">((resolve) => {
            setTimeout(() => {
              resolve("stalled");
            }, 1000);
          }),
        ]);

        if (outcome === "stalled") {
          throw new Error("reconcileOnce ignored the per-node mutateMs for serverStop.mutate");
        }
        expect(outcome.errors).toBe(1);
        const runReport = outcome.reports.find((r) => r.name === "run-a");
        expect(runReport?.error).toMatch(/did not respond to serverStop\.mutate within 20 ms/);
        expect(runReport?.reason).toBe("NodeUnreachable");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a per-node deadline does not leak to other nodes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-per-node-leak-"));
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

        const result = await reconcileOnce({
          workloadsDir: dir,
          rpcTimeouts: { queryMs: 20, mutateMs: 20 },
          rpcTimeoutsFor: (node: string) =>
            node === "mac-mini" ? { queryMs: 60_000, mutateMs: 60_000 } : undefined,
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
                      new Promise((resolve) => {
                        setTimeout(() => {
                          resolve({
                            state: "Running",
                            pid: 1234,
                            specHash: computeModelHostSpecHash(specForHash(host.spec)),
                          });
                        }, 150);
                      }),
                  },
                },
        });

        const hostReport = result.reports.find((r) => r.name === "host-a");
        expect(hostReport?.error).toBeUndefined();
        expect(hostReport?.action).toBe("unchanged");
        const runReport = result.reports.find((r) => r.name === "run-a");
        expect(runReport?.error).toMatch(/within 20 ms/);
        expect(result.errors).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("concurrent node reconcile (#221)", () => {
    test("a hanging node query does not delay a healthy node's host report", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-concurrent-"));
      try {
        const log: string[] = [];
        const host = hostManifestOn("mac-mini");
        saveWorkload(modelRunOn("z13", "run-a", "mlx-community/run-a.gguf"), dir);
        saveModelHost(host, dir);

        const opts = {
          workloadsDir: dir,
          rpcTimeouts: { queryMs: 60_000, mutateMs: 60_000 },
          rpcTimeoutsFor: (node: string): { queryMs?: number; mutateMs?: number } | undefined =>
            node === "z13"
              ? { queryMs: 300, mutateMs: 300 }
              : node === "mac-mini"
                ? { queryMs: 20, mutateMs: 20 }
                : undefined,
          resolveNodeIdentity: (node: string): string | null => node,
          getClient: (node: string): WorkloadClient =>
            node === "z13"
              ? { ...makeClient(), serverStatus: { query: hangingStatusQuery(log, "z13") } }
              : runningHostClient(host, () => log.push("mac-mini:query")),
        };
        const result = await reconcileOnce(opts);

        expectMacMiniBeforeZ13Deadline(log);
        expect(result.errors).toBe(1);
        expect(result.reports.map((r) => r.name)).toEqual(["run-a", "host-a"]);
        const runReport = result.reports.find((r) => r.name === "run-a");
        expect(runReport?.node).toBe("z13");
        expect(runReport?.action).toBe("unchanged");
        expect(runReport?.reason).toBe("NodeUnreachable");
        expect(runReport?.error).toMatch(/did not respond to serverStatus\.query within 300 ms/);
        const hostReport = result.reports.find((r) => r.name === "host-a");
        expect(hostReport?.action).toBe("unchanged");
        expect(hostReport?.error).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("reports stay in manifest order while nodes reconcile concurrently", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-concurrent-order-"));
      try {
        const log: string[] = [];
        saveWorkload(modelRunOn("z13", "a-run", "mlx-community/a-run.gguf"), dir);
        saveWorkload(modelRunOn("mac-mini", "b-run", "mlx-community/b-run.gguf"), dir);

        const opts = {
          workloadsDir: dir,
          rpcTimeouts: { queryMs: 60_000, mutateMs: 60_000 },
          rpcTimeoutsFor: (node: string): { queryMs?: number; mutateMs?: number } | undefined =>
            node === "z13"
              ? { queryMs: 300, mutateMs: 300 }
              : node === "mac-mini"
                ? { queryMs: 20, mutateMs: 20 }
                : undefined,
          resolveNodeIdentity: (node: string): string | null => node,
          getClient: (node: string): WorkloadClient =>
            node === "z13"
              ? { ...makeClient(), serverStatus: { query: hangingStatusQuery(log, "z13") } }
              : {
                  ...makeClient(),
                  serverStatus: {
                    query: (): Promise<ServerStatusResult> => {
                      log.push("mac-mini:query");
                      return Promise.resolve(downStatus());
                    },
                  },
                },
        };
        const result = await reconcileOnce(opts);

        expectMacMiniBeforeZ13Deadline(log);
        expect(result.errors).toBe(1);
        expect(result.reports.map((r) => r.name)).toEqual(["a-run", "b-run"]);
        const down = result.reports.find((r) => r.name === "a-run");
        expect(down?.node).toBe("z13");
        expect(down?.action).toBe("unchanged");
        expect(down?.reason).toBe("NodeUnreachable");
        expect(down?.error).toMatch(/did not respond to serverStatus\.query within 300 ms/);
        const up = result.reports.find((r) => r.name === "b-run");
        expect(up?.error).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("bounds in-flight node reconciles to nodeConcurrency", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-pool-"));
      try {
        const counter = { current: 0, max: 0 };
        for (const node of ["n1", "n2", "n3"]) {
          saveWorkload(modelRunOn(node, `run-${node}`, `mlx-community/run-${node}.gguf`), dir);
        }

        const opts = {
          workloadsDir: dir,
          resolveNodeIdentity: (node: string): string | null => node,
          nodeConcurrency: 2,
          getClient: (): WorkloadClient => ({
            ...makeClient(),
            serverStatus: { query: inFlightStatusQuery(counter) },
          }),
        };
        const result = await reconcileOnce(opts);

        expect(counter.max).toBe(2);
        expect(result.reports.map((r) => r.name)).toEqual(["run-n1", "run-n2", "run-n3"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("nodes that resolve to one identity stay serial under nodeConcurrency", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-alias-"));
      try {
        const counter = { current: 0, max: 0 };
        saveWorkload(modelRunOn("local", "run-local", "mlx-community/run-local.gguf"), dir);
        saveWorkload(modelRunOn("mac-mini", "run-mini", "mlx-community/run-mini.gguf"), dir);

        const opts = {
          workloadsDir: dir,
          resolveNodeIdentity: (node: string): string | null =>
            node === "local" || node === "mac-mini" ? "same-host" : node,
          nodeConcurrency: 4,
          getClient: (): WorkloadClient => ({
            ...makeClient(),
            serverStatus: { query: inFlightStatusQuery(counter) },
          }),
        };
        await reconcileOnce(opts);

        expect(counter.max).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a getClient failure stays scoped to its node", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-client-error-"));
      try {
        const host = hostManifestOn("mac-mini");
        saveWorkload(modelRunOn("z13", "run-a", "mlx-community/run-a.gguf"), dir);
        saveModelHost(host, dir);

        const opts = {
          workloadsDir: dir,
          resolveNodeIdentity: (node: string): string | null => node,
          nodeConcurrency: 2,
          getClient: (node: string): WorkloadClient => {
            if (node === "z13") throw new Error("boom");
            return runningHostClient(host);
          },
        };
        const result = await reconcileOnce(opts);

        expect(result.errors).toBe(1);
        const runReport = result.reports.find((r) => r.name === "run-a");
        expect(runReport?.error).toBe("boom");
        expect(result.reports.filter((r) => "reason" in r)).toEqual([]);
        expect(result.reports.find((r) => r.name === "host-a")?.error).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("worker nodes count toward a manifest's concurrency group", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-worker-group-"));
      try {
        const counter = { current: 0, max: 0 };
        const baseA = modelRunOn("n1", "a-run", "mlx-community/a-run.gguf");
        const runA: ModelRun = {
          ...baseA,
          spec: {
            ...baseA.spec,
            workers: [
              { node: "n2", rpcHost: "10.0.0.2", rpcPort: 50052, extraArgs: [], timeoutSeconds: 1 },
            ],
          },
        };
        saveWorkload(runA, dir);
        saveWorkload(modelRunOn("n2", "b-run", "mlx-community/b-run.gguf"), dir);

        const g3Client: WorkloadClient = {
          ...makeClient(),
          serverStatus: { query: inFlightStatusQuery(counter) },
          rpcServerStart: {
            subscribe(_input, callbacks) {
              queueMicrotask(() => {
                callbacks.onError(new Error("no rpc in test"));
              });
              return { unsubscribe: () => undefined };
            },
          },
        };
        const opts = {
          workloadsDir: dir,
          resolveNodeIdentity: (node: string): string | null => node,
          nodeConcurrency: 2,
          getClient: (): WorkloadClient => g3Client,
        };
        const result = await reconcileOnce(opts);

        expect(counter.max).toBe(1);
        expect(result.reports.map((r) => r.name)).toEqual(["a-run", "b-run"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("without resolveNodeIdentity the pass stays serial", async () => {
      const dir = mkdtempSync(join(tmpdir(), "llamactl-reconciler-no-resolver-"));
      try {
        const counter = { current: 0, max: 0 };
        for (const node of ["n1", "n2", "n3"]) {
          saveWorkload(modelRunOn(node, `run-${node}`, `mlx-community/run-${node}.gguf`), dir);
        }

        const opts = {
          workloadsDir: dir,
          nodeConcurrency: 2,
          getClient: (): WorkloadClient => ({
            ...makeClient(),
            serverStatus: { query: inFlightStatusQuery(counter) },
          }),
        };
        await reconcileOnce(opts);

        expect(counter.max).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
