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
