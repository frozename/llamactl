import { describe, expect, test } from "bun:test";

import {
  type NodeRpcPassState,
  NodeRpcSkippedError,
  NodeRpcTimeoutError,
  withNodeRpcDeadline,
} from "../../src/workload/node-rpc-deadline.js";

const timeouts = { queryMs: 30, mutateMs: 60 };

describe("withNodeRpcDeadline", () => {
  test("a never-settling query rejects with NodeRpcTimeoutError", async () => {
    const client = {
      modelHostStatus: {
        query: (_input: { workload: string }): Promise<never> =>
          new Promise<never>(() => undefined),
      },
    };
    const wrapped = withNodeRpcDeadline(client, "z13", timeouts);
    const err = await wrapped.modelHostStatus.query({ workload: "host-a" }).then(
      (): null => null,
      (e: unknown): unknown => e,
    );
    expect(err).toBeInstanceOf(NodeRpcTimeoutError);
    const timeout = err as NodeRpcTimeoutError;
    expect(timeout.node).toBe("z13");
    expect(timeout.procedure).toBe("modelHostStatus.query");
    expect(timeout.timeoutMs).toBe(30);
    expect(timeout.message).toMatch(/did not respond/);
  });

  test("a never-settling mutate rejects with the mutate timeout", async () => {
    const client = {
      serverStop: {
        mutate: (_input: { workload: string }): Promise<never> =>
          new Promise<never>(() => undefined),
      },
    };
    const wrapped = withNodeRpcDeadline(client, "gpu1", timeouts);
    const err = await wrapped.serverStop.mutate({ workload: "run-a" }).then(
      (): null => null,
      (e: unknown): unknown => e,
    );
    expect(err).toBeInstanceOf(NodeRpcTimeoutError);
    expect((err as NodeRpcTimeoutError).timeoutMs).toBe(60);
    expect((err as NodeRpcTimeoutError).procedure).toBe("serverStop.mutate");
  });

  test("a resolved value passes through unchanged", async () => {
    const status = { state: "Running", pid: 1234 };
    const client = {
      modelHostStatus: {
        query: (_input: { workload: string }): Promise<typeof status> => Promise.resolve(status),
      },
    };
    const wrapped = withNodeRpcDeadline(client, "z13", timeouts);
    expect(await wrapped.modelHostStatus.query({ workload: "host-a" })).toEqual(status);
  });

  test("an underlying rejection rejects with the same Error instance", async () => {
    const failure = new Error("boom");
    const client = {
      serverStatus: {
        query: (_input: { workload: string }): Promise<never> => Promise.reject(failure),
      },
    };
    const wrapped = withNodeRpcDeadline(client, "z13", timeouts);
    const err = await wrapped.serverStatus.query({ workload: "run-a" }).then(
      (): null => null,
      (e: unknown): unknown => e,
    );
    expect(err).toBe(failure);
  });

  test("a query that throws synchronously rejects with the original Error", async () => {
    const rejections: unknown[] = [];
    const listener = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const failure = new Error("sync query boom");
      const client = {
        serverStatus: {
          query: (_input: { workload: string }): Promise<never> => {
            throw failure;
          },
        },
      };
      const wrapped = withNodeRpcDeadline(client, "z13", timeouts);
      const err = await wrapped.serverStatus.query({ workload: "run-a" }).then(
        (): null => null,
        (e: unknown): unknown => e,
      );
      expect(err).toBe(failure);
      await new Promise((resolve): void => {
        setTimeout(resolve, timeouts.queryMs + 50);
      });
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("a mutate that throws synchronously rejects with the original Error", async () => {
    const rejections: unknown[] = [];
    const listener = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const failure = new Error("sync mutate boom");
      const client = {
        serverStop: {
          mutate: (_input: { workload: string }): Promise<never> => {
            throw failure;
          },
        },
      };
      const wrapped = withNodeRpcDeadline(client, "gpu1", timeouts);
      const err = await wrapped.serverStop.mutate({ workload: "run-a" }).then(
        (): null => null,
        (e: unknown): unknown => e,
      );
      expect(err).toBe(failure);
      await new Promise((resolve): void => {
        setTimeout(resolve, timeouts.mutateMs + 50);
      });
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  test("subscribe is passed through unchanged", () => {
    const unsubscribable = { unsubscribe: (): undefined => undefined };
    let seenInput: unknown = null;
    let seenCallbacks: unknown = null;
    const client = {
      serverStart: {
        subscribe: (input: unknown, callbacks: unknown): typeof unsubscribable => {
          seenInput = input;
          seenCallbacks = callbacks;
          return unsubscribable;
        },
      },
    };
    const wrapped = withNodeRpcDeadline(client, "z13", timeouts);
    const callbacks = {
      onData: (): undefined => undefined,
      onComplete: (): undefined => undefined,
    };
    const input = { workload: "run-a", target: "m.gguf" };
    expect(wrapped.serverStart.subscribe(input, callbacks)).toBe(unsubscribable);
    expect(seenInput).toBe(input);
    expect(seenCallbacks).toBe(callbacks);
  });

  test("an absent optional procedure stays undefined", () => {
    const client = {
      serverStatus: {
        query: (_input: { workload: string }): Promise<{ state: string }> =>
          Promise.resolve({ state: "down" }),
      },
    };
    const wrapped = withNodeRpcDeadline<
      typeof client & { resolveTarget?: { query: (value: string) => Promise<string | null> } }
    >(client, "z13", timeouts);
    expect(wrapped.resolveTarget).toBeUndefined();
  });

  test("mutateMs null hands back the procedure's own mutate and still bounds queries", async () => {
    const rawMutate = (_input: { pkg: string }): Promise<{ ok: boolean }> =>
      Promise.resolve({ ok: true });
    const client = {
      infraInstall: { mutate: rawMutate },
      infraList: {
        query: (): Promise<never> => new Promise<never>(() => undefined),
      },
    };
    const wrapped = withNodeRpcDeadline(client, "z13", { queryMs: 5, mutateMs: null });
    expect(wrapped.infraInstall.mutate).toBe(rawMutate);
    const err = await wrapped.infraList.query().then(
      (): null => null,
      (e: unknown): unknown => e,
    );
    expect(err).toBeInstanceOf(NodeRpcTimeoutError);
    expect((err as NodeRpcTimeoutError).procedure).toBe("infraList.query");
    expect((err as NodeRpcTimeoutError).timeoutMs).toBe(5);
  });
});

describe("withNodeRpcDeadline per-pass skip", () => {
  test("after a timeout, later calls to the same node in the pass fail fast without reaching the node", async () => {
    const pass: NodeRpcPassState = { timedOut: new Map() };
    const client1 = {
      serverStatus: {
        query: (_input: { workload: string }): Promise<never> =>
          new Promise<never>(() => undefined),
      },
    };
    const wrapped1 = withNodeRpcDeadline(client1, "z13", timeouts, pass);
    const first = await wrapped1.serverStatus.query({ workload: "run-a" }).then(
      (): null => null,
      (e: unknown): unknown => e,
    );
    expect(first).toBeInstanceOf(NodeRpcTimeoutError);
    expect(pass.timedOut.get("z13")).toBe(first as NodeRpcTimeoutError);

    let calls = 0;
    const client2 = {
      serverStatus: {
        query: (_input: { workload: string }): Promise<{ state: string }> => {
          calls++;
          return Promise.resolve({ state: "down" });
        },
      },
      serverStop: {
        mutate: (_input: { workload: string }): Promise<{ ok: boolean }> => {
          calls++;
          return Promise.resolve({ ok: true });
        },
      },
    };
    const wrapped2 = withNodeRpcDeadline(client2, "z13", timeouts, pass);
    const skippedQuery = await wrapped2.serverStatus.query({ workload: "run-a" }).then(
      (): null => null,
      (e: unknown): unknown => e,
    );
    expect(skippedQuery).toBeInstanceOf(NodeRpcSkippedError);
    const skip = skippedQuery as NodeRpcSkippedError;
    expect(skip.node).toBe("z13");
    expect(skip.procedure).toBe("serverStatus.query");
    expect(skip.earlier).toBe(first as NodeRpcTimeoutError);
    expect(skip.message).toMatch(/skipped/);
    expect(skip.message).toMatch(/timed out after 30 ms/);

    const skippedMutate = await wrapped2.serverStop.mutate({ workload: "run-a" }).then(
      (): null => null,
      (e: unknown): unknown => e,
    );
    expect(skippedMutate).toBeInstanceOf(NodeRpcSkippedError);
    expect((skippedMutate as NodeRpcSkippedError).procedure).toBe("serverStop.mutate");
    expect(calls).toBe(0);
  });

  test("a timeout on one node does not skip another node", async () => {
    const pass: NodeRpcPassState = { timedOut: new Map() };
    const silent = {
      serverStatus: {
        query: (_input: { workload: string }): Promise<never> =>
          new Promise<never>(() => undefined),
      },
    };
    const wrappedSilent = withNodeRpcDeadline(silent, "z13", timeouts, pass);
    await wrappedSilent.serverStatus.query({ workload: "run-a" }).catch((): undefined => undefined);
    expect(pass.timedOut.has("z13")).toBe(true);

    let calls = 0;
    const status = { state: "down" };
    const client = {
      serverStatus: {
        query: (_input: { workload: string }): Promise<{ state: string }> => {
          calls++;
          return Promise.resolve(status);
        },
      },
    };
    const wrapped = withNodeRpcDeadline(client, "mac-mini", timeouts, pass);
    expect(await wrapped.serverStatus.query({ workload: "run-a" })).toEqual(status);
    expect(calls).toBe(1);
  });

  test("an underlying rejection does not mark the node", async () => {
    const pass: NodeRpcPassState = { timedOut: new Map() };
    let calls = 0;
    const client = {
      serverStatus: {
        query: (_input: { workload: string }): Promise<never> => {
          calls++;
          return Promise.reject(new Error("boom"));
        },
      },
    };
    const wrapped = withNodeRpcDeadline(client, "z13", timeouts, pass);
    await wrapped.serverStatus.query({ workload: "run-a" }).catch((): undefined => undefined);
    expect(pass.timedOut.size).toBe(0);
    await wrapped.serverStatus.query({ workload: "run-a" }).catch((): undefined => undefined);
    expect(calls).toBe(2);
  });

  test("without a pass state a timeout does not skip later calls", async () => {
    const silent = {
      serverStatus: {
        query: (_input: { workload: string }): Promise<never> =>
          new Promise<never>(() => undefined),
      },
    };
    const wrappedSilent = withNodeRpcDeadline(silent, "z13", timeouts);
    await wrappedSilent.serverStatus.query({ workload: "run-a" }).catch((): undefined => undefined);

    let calls = 0;
    const status = { state: "down" };
    const client = {
      serverStatus: {
        query: (_input: { workload: string }): Promise<{ state: string }> => {
          calls++;
          return Promise.resolve(status);
        },
      },
    };
    const wrapped = withNodeRpcDeadline(client, "z13", timeouts);
    expect(await wrapped.serverStatus.query({ workload: "run-a" })).toEqual(status);
    expect(calls).toBe(1);
  });
});
