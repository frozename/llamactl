import { describe, expect, test } from "bun:test";

import type { ModelRun } from "../src/workload/schema.js";

import { applyOne, type WorkloadClient } from "../src/workload/apply.js";

function baseManifest(): ModelRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: "test-run", labels: {}, annotations: {} },
    spec: {
      node: "coordinator",
      enabled: true,
      gateway: false,
      allowExternalBind: false,
      target: { kind: "rel", value: "model.gguf" },
      extraArgs: [],
      restartPolicy: "Always",
      timeoutSeconds: 30,
      workers: [],
    },
  };
}

function manifestWithWorkers(): ModelRun {
  return {
    ...baseManifest(),
    spec: {
      ...baseManifest().spec,
      workers: [
        { node: "worker0", rpcHost: "10.0.0.1", rpcPort: 50052, extraArgs: [], timeoutSeconds: 20 },
        { node: "worker1", rpcHost: "10.0.0.2", rpcPort: 50053, extraArgs: [], timeoutSeconds: 20 },
      ],
    },
  };
}

// Methods are written as shorthand on a `const client: WorkloadClient` (not a bare
// returned literal) so the annotation contextually types them — this satisfies
// @typescript-eslint/explicit-function-return-type (allowTypedFunctionExpressions),
// matching the mock idiom in composite-apply.test.ts.
function makeBaseClient(): WorkloadClient {
  const client: WorkloadClient = {
    serverStatus: {
      async query() {
        await Promise.resolve();
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
      },
    },
    serverStop: {
      async mutate() {
        await Promise.resolve();
        return {};
      },
    },
    serverStart: {
      subscribe(_input, callbacks) {
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 42, endpoint: "http://127.0.0.1:8080" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStart: {
      subscribe(_input, callbacks) {
        queueMicrotask(() => {
          callbacks.onData({ type: "done", result: { ok: true } });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    modelHostStop: {
      async mutate() {
        await Promise.resolve();
        return {};
      },
    },
    modelHostStatus: {
      async query() {
        await Promise.resolve();
        return { state: "Stopped", pid: null };
      },
    },
    rpcServerStart: {
      subscribe(_input, callbacks) {
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 99, endpoint: "0.0.0.0:50052" },
          });
          callbacks.onComplete();
        });
        return { unsubscribe: () => undefined };
      },
    },
    rpcServerStop: {
      async mutate() {
        await Promise.resolve();
        return {};
      },
    },
    rpcServerDoctor: {
      async query() {
        await Promise.resolve();
        return { ok: true as const, path: "/bin/rpc-server", llamaCppBin: "/bin" };
      },
    },
  };
  return client;
}

describe("D1 — startWorkers subscription cleanup", () => {
  test("unsubscribe is called when rpcServerStart fires onError", async () => {
    let unsubCalled = false;

    const getClient = (node: string): WorkloadClient => {
      if (node === "coordinator") return makeBaseClient();
      const client: WorkloadClient = {
        ...makeBaseClient(),
        rpcServerStart: {
          subscribe(_input, callbacks) {
            queueMicrotask(() => {
              callbacks.onError(new Error("rpc-server subscribe failed"));
            });
            return {
              unsubscribe: (): void => {
                unsubCalled = true;
              },
            };
          },
        },
      };
      return client;
    };

    // After D1 fix (hoist sub + try/finally + .catch), applyOne returns a Failed result
    // instead of throwing, and unsubscribe is called via finally.
    let result: Awaited<ReturnType<typeof applyOne>> | undefined;
    try {
      result = await applyOne(manifestWithWorkers(), getClient);
    } catch {
      // Before fix: applyOne throws due to uncaught promise rejection in startWorkers
    }

    if (result !== undefined) {
      expect(result.statusSection.phase).toBe("Failed");
    }
    expect(unsubCalled).toBe(true);
  });
});

describe("D2 — startCoordinator subscription cleanup", () => {
  test("unsubscribe is called when serverStart fires onError", async () => {
    let unsubCalled = false;

    const getClient = (_node: string): WorkloadClient => {
      const client: WorkloadClient = {
        ...makeBaseClient(),
        serverStart: {
          subscribe(_input, callbacks) {
            queueMicrotask(() => {
              callbacks.onError(new Error("serverStart subscribe failed"));
            });
            return {
              unsubscribe: (): void => {
                unsubCalled = true;
              },
            };
          },
        },
      };
      return client;
    };

    // startCoordinator throws on rejection (no .catch added); applyOne propagates it.
    // After D2 fix (hoist sub + try/finally), the finally block runs and calls unsubscribe
    // before the exception propagates.
    try {
      await applyOne(baseManifest(), getClient);
    } catch {
      // expected — startCoordinator rejects; applyOne throws
    }

    expect(unsubCalled).toBe(true);
  });
});

describe("D3 — convergeServerUnderLock partial-worker cleanup", () => {
  test("stopWorkers is called for already-started workers when a later worker fails", async () => {
    const stopArgs: { node: string; graceSeconds: number | undefined }[] = [];

    const getClient = (node: string): WorkloadClient => {
      const client: WorkloadClient = {
        ...makeBaseClient(),
        rpcServerStop: {
          async mutate(input) {
            await Promise.resolve();
            stopArgs.push({ node, graceSeconds: input?.graceSeconds });
            return {};
          },
        },
        rpcServerStart: {
          subscribe(_input, callbacks) {
            queueMicrotask(() => {
              if (node === "worker1") {
                // Second worker fails
                callbacks.onData({
                  type: "done",
                  result: { ok: false, endpoint: "", error: "worker1 boom" },
                });
              } else {
                callbacks.onData({
                  type: "done",
                  result: { ok: true, pid: 99, endpoint: "0.0.0.0:50052" },
                });
              }
              callbacks.onComplete();
            });
            return { unsubscribe: () => undefined };
          },
        },
      };
      return client;
    };

    const result = await applyOne(manifestWithWorkers(), getClient);
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.error).toContain("worker1");

    // stopWorkers uses graceSeconds: 3; the pre-start cleanup uses graceSeconds: 2.
    // Before D3 fix: no graceSeconds: 3 calls (stopWorkers never invoked).
    // After D3 fix: graceSeconds: 3 calls appear for the cleanup.
    const cleanupStops = stopArgs.filter((c) => c.graceSeconds === 3);
    expect(cleanupStops.length).toBeGreaterThan(0);
  });
});

describe("host-bind refusal", () => {
  interface BindTrace {
    serverStopCalls: string[];
    serverStartCalls: string[];
    rpcServerStartCalls: string[];
    rpcServerStopCalls: { node: string; graceSeconds: number | undefined }[];
  }

  function newTrace(): BindTrace {
    return {
      serverStopCalls: [],
      serverStartCalls: [],
      rpcServerStartCalls: [],
      rpcServerStopCalls: [],
    };
  }

  // Every workload reports up on 127.0.0.1 with no extraArgs, so the manifests below are mismatched
  // (apply would stop the coordinator) and their eviction target is live (apply would stop it).
  function tracedClient(node: string, trace: BindTrace, startError?: string): WorkloadClient {
    const client: WorkloadClient = {
      ...makeBaseClient(),
      serverStatus: {
        async query() {
          await Promise.resolve();
          return {
            state: "up",
            rel: "model.gguf",
            extraArgs: [],
            pid: 123,
            host: "127.0.0.1",
            port: 65533,
            binary: null,
            endpoint: "http://127.0.0.1:65533",
          };
        },
      },
      serverStop: {
        async mutate(input) {
          await Promise.resolve();
          trace.serverStopCalls.push(input.workload);
          return {};
        },
      },
      serverStart: {
        subscribe(input, callbacks) {
          trace.serverStartCalls.push(input.workload);
          queueMicrotask(() => {
            callbacks.onData({
              type: "done",
              result:
                startError === undefined
                  ? { ok: true, pid: 42, endpoint: "http://127.0.0.1:65533" }
                  : { ok: false, pid: null, endpoint: "http://0.0.0.0:65533", error: startError },
            });
            callbacks.onComplete();
          });
          return { unsubscribe: () => undefined };
        },
      },
      rpcServerStart: {
        subscribe(_input, callbacks) {
          trace.rpcServerStartCalls.push(node);
          queueMicrotask(() => {
            callbacks.onData({
              type: "done",
              result: { ok: true, pid: 99, endpoint: "0.0.0.0:50052" },
            });
            callbacks.onComplete();
          });
          return { unsubscribe: () => undefined };
        },
      },
      rpcServerStop: {
        async mutate(input) {
          await Promise.resolve();
          trace.rpcServerStopCalls.push({ node, graceSeconds: input?.graceSeconds });
          return {};
        },
      },
    };
    return client;
  }

  function evictingManifest(spec: Partial<ModelRun["spec"]>): ModelRun {
    const base = manifestWithWorkers();
    return {
      ...base,
      metadata: { ...base.metadata, annotations: { "llamactl.io/evict": "victim" } },
      spec: { ...base.spec, ...spec },
    };
  }

  test.each([
    {
      label: "a non-loopback --host",
      manifest: evictingManifest({ extraArgs: ["--host", "127.0.0.1", "--host", "0.0.0.0"] }),
    },
    {
      label: "a non-loopback endpoint host",
      manifest: evictingManifest({ endpoint: { host: "0.0.0.0" } }),
    },
  ])("refuses $label before evicting, stopping or starting anything", async ({ manifest }) => {
    const trace = newTrace();
    const result = await applyOne(
      manifest,
      (node) => tracedClient(node, trace),
      undefined,
      undefined,
      { listManifests: () => [] },
    );
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.error).toContain("refusing to bind llama-server to 0.0.0.0");
    expect(trace.serverStopCalls).toEqual([]);
    expect(trace.rpcServerStartCalls).toEqual([]);
    expect(trace.rpcServerStopCalls).toEqual([]);
    expect(trace.serverStartCalls).toEqual([]);
  });

  test("leaves a matching running workload Running even when its bind would be refused", async () => {
    const trace = newTrace();
    const live: WorkloadClient = {
      ...tracedClient("coordinator", trace),
      serverStatus: {
        async query() {
          await Promise.resolve();
          return {
            state: "up",
            rel: "model.gguf",
            extraArgs: [],
            pid: 123,
            host: "0.0.0.0",
            port: 65533,
            binary: null,
            endpoint: "http://0.0.0.0:65533",
          };
        },
      },
    };
    const manifest: ModelRun = {
      ...baseManifest(),
      spec: { ...baseManifest().spec, endpoint: { host: "0.0.0.0", port: 65533 } },
    };
    const result = await applyOne(manifest, () => live, undefined, undefined, {
      listManifests: () => [],
    });
    expect(result.error).toBeUndefined();
    expect(result.action).toBe("unchanged");
    expect(result.statusSection.phase).toBe("Running");
    expect(result.statusSection.serverPid).toBe(123);
    expect(trace.serverStopCalls).toEqual([]);
    expect(trace.serverStartCalls).toEqual([]);
  });

  test("lets a non-loopback endpoint host through with allowExternalBind", async () => {
    const trace = newTrace();
    const result = await applyOne(
      evictingManifest({ allowExternalBind: true, endpoint: { host: "0.0.0.0" } }),
      (node) => tracedClient(node, trace),
      undefined,
      undefined,
      { listManifests: () => [] },
    );
    expect(result.error).toBeUndefined();
    expect(result.statusSection.phase).toBe("Running");
    expect(trace.serverStartCalls).toEqual(["test-run"]);
  });

  test("a node-side refusal stops the started workers and returns Failed", async () => {
    const trace = newTrace();
    const refusal =
      "refusing to bind llama-server to 0.0.0.0 without `allowExternalBind: true` in the workload spec";
    const result = await applyOne(
      manifestWithWorkers(),
      (node) => tracedClient(node, trace, refusal),
      undefined,
      undefined,
      { listManifests: () => [] },
    );
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.error).toBe(refusal);
    expect(trace.serverStartCalls).toEqual(["test-run"]);
    expect(trace.rpcServerStartCalls).toEqual(["worker0", "worker1"]);
    expect(trace.rpcServerStopCalls.filter((c) => c.graceSeconds === 3)).toEqual([
      { node: "worker1", graceSeconds: 3 },
      { node: "worker0", graceSeconds: 3 },
    ]);
  });
});
