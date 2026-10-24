import { describe, expect, test } from "bun:test";

import { NodeRpcTimeoutError, withNodeRpcDeadline } from "../../src/workload/node-rpc-deadline.js";

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
});
