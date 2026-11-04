/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects/resolves matchers are typed as void. */
import { describe, expect, test } from "bun:test";

import { withNodeLock } from "../../src/workload/node-mutex.js";

type Gate = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
};

function deferred(): Gate {
  let resolve = (): void => undefined;
  let reject: (reason?: unknown) => void = (): void => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("withNodeLock", () => {
  test("same node is serialized", async () => {
    let startedA = false;
    let startedB = false;
    const gateA = deferred();

    const a = withNodeLock("node-serial-1", async () => {
      startedA = true;
      await gateA.promise;
    });
    const b = withNodeLock("node-serial-1", () => {
      startedB = true;
      return Promise.resolve();
    });

    await flush();
    expect(startedA).toBe(true);
    expect(startedB).toBe(false);

    gateA.resolve();
    await a;
    await flush();
    expect(startedB).toBe(true);
    await b;
  });

  test("different nodes run concurrently", async () => {
    let startedB = false;
    const gateA = deferred();

    const holdA = withNodeLock("node-a", async () => {
      await gateA.promise;
    });
    const b = withNodeLock("node-b", () => {
      startedB = true;
      return Promise.resolve("b-value");
    });

    await flush();
    expect(startedB).toBe(true);
    expect(await b).toBe("b-value");

    gateA.resolve();
    await holdA;
  });

  test("waiters run in FIFO order", async () => {
    const order: number[] = [];
    const gate1 = deferred();

    const holder = withNodeLock("node-fifo", async () => {
      order.push(1);
      await gate1.promise;
    });
    const second = withNodeLock("node-fifo", () => {
      order.push(2);
      return Promise.resolve();
    });
    const third = withNodeLock("node-fifo", () => {
      order.push(3);
      return Promise.resolve();
    });

    gate1.resolve();
    await Promise.all([holder, second, third]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("the return value passes through", async () => {
    expect(await withNodeLock("n-ret", () => Promise.resolve(42))).toBe(42);

    const object = { ok: true };
    const passed = await withNodeLock("n-ret", () => Promise.resolve(object));
    expect(passed).toBe(object);
  });

  test("a rejection propagates unchanged", async () => {
    const err = new Error("boom");
    const p = withNodeLock("n-rej", () => {
      throw err;
    });
    await expect(p).rejects.toBe(err);
  });

  test("a rejecting holder still releases the lock", async () => {
    let started = false;
    const gate = deferred();
    const err = new Error("holder failed");

    const holder = withNodeLock("n-rel", async () => {
      await gate.promise;
      throw err;
    });
    const waiter = withNodeLock("n-rel", () => {
      started = true;
      return Promise.resolve("ok");
    });

    await flush();
    expect(started).toBe(false);

    gate.reject(err);
    await expect(holder).rejects.toBe(err);
    expect(await waiter).toBe("ok");
    expect(started).toBe(true);
  });

  test("the lock can be taken again once idle", async () => {
    await withNodeLock("n-idle", () => Promise.resolve("first"));

    let invoked = false;
    const result = await withNodeLock("n-idle", () => {
      invoked = true;
      return Promise.resolve("second");
    });
    expect(result).toBe("second");
    expect(invoked).toBe(true);
  });

  test("a caller arriving after a handoff still waits for the running holder", async () => {
    let startedB = false;
    let startedC = false;
    const gateA = deferred();
    const gateB = deferred();

    const a = withNodeLock("node-handoff", async () => {
      await gateA.promise;
    });
    const b = withNodeLock("node-handoff", async () => {
      startedB = true;
      await gateB.promise;
    });

    await flush();
    expect(startedB).toBe(false);

    gateA.resolve();
    await a;
    await flush();
    expect(startedB).toBe(true);

    const c = withNodeLock("node-handoff", () => {
      startedC = true;
      return Promise.resolve();
    });

    await flush();
    expect(startedC).toBe(false);

    gateB.resolve();
    await b;
    await flush();
    expect(startedC).toBe(true);
    await c;
  });
});
