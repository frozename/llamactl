import { initTRPC } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  TUNNEL_STREAM_CANCELLED,
  TUNNEL_STREAM_OVERFLOW,
  type TunnelReq,
} from "../src/tunnel/messages.js";
import {
  createTunnelSubscriptionHandler,
  type TunnelSubscription,
} from "../src/tunnel/router-bridge.js";

/**
 * B.2 coverage — `createTunnelSubscriptionHandler` must resolve
 * tRPC v11 subscription procedures directly against the router,
 * pump their AsyncIterable output into `{onEvent, onError,
 * onComplete}` handlers, and support early cancellation via
 * `cancel()`.
 */

const t = initTRPC.context<{ userId?: string }>().create();

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- tRPC BuiltRouter internals are unnameable; the bridge accepts any router instance.
function buildFixtureRouter() {
  return t.router({
    counter: t.procedure
      .input(z.object({ n: z.number().int().min(1) }))
      .subscription(async function* ({ input, signal }) {
        await Promise.resolve();
        for (let i = 0; i < input.n; i++) {
          if (signal?.aborted) break;
          yield { idx: i };
        }
      }),
    slow: t.procedure.subscription(async function* ({ signal }) {
      for (let i = 0; i < 100; i++) {
        if (signal?.aborted) break;
        yield { i };
        // Yield control so cancel has a chance to land.
        await new Promise((r) => setTimeout(r, 5));
      }
    }),
    crashes: t.procedure.subscription(async function* () {
      await Promise.resolve();
      yield { first: true };
      throw new Error("boom");
    }),
    notFound: t.procedure.query(() => ({ ok: true })),
    contextEcho: t.procedure.subscription(async function* ({ ctx }) {
      await Promise.resolve();
      yield { user: (ctx as { userId?: string }).userId ?? null };
    }),
  });
}

function makeReq(method: string, input: unknown): TunnelReq {
  return {
    type: "req",
    id: `test-${Math.random().toString(36).slice(2)}`,
    method,
    params: { type: "subscription", input },
  };
}

describe("createTunnelSubscriptionHandler", () => {
  test("emits three events then completes", async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}));
    const events: unknown[] = [];
    let complete = false;
    let error: Error | null = null;
    const sub = makeSub(makeReq("counter", { n: 3 })).subscribe({
      onEvent: (d) => events.push(d),
      onError: (e) => {
        error = e;
      },
      onComplete: () => {
        complete = true;
      },
    });
    // Wait for the async pump to finish.
    await new Promise((r) => setTimeout(r, 30));
    expect(error).toBeNull();
    expect(complete).toBe(true);
    expect(events).toEqual([{ idx: 0 }, { idx: 1 }, { idx: 2 }]);
    sub.cancel(); // idempotent; no throw
  });

  test("propagates ctx from createContext factory", async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({
      userId: "alice",
    }));
    const events: unknown[] = [];
    makeSub(makeReq("contextEcho", undefined)).subscribe({
      onEvent: (d) => events.push(d),
      onError: () => undefined,
      onComplete: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([{ user: "alice" }]);
  });

  test("cancel() aborts the source iterable", async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}));
    const events: unknown[] = [];
    let done = false;
    const sub = makeSub(makeReq("slow", undefined)).subscribe({
      onEvent: (d) => events.push(d),
      onError: () => {
        done = true;
      },
      onComplete: () => {
        done = true;
      },
    });
    // Let a few events land.
    await new Promise((r) => setTimeout(r, 20));
    sub.cancel();
    // Wait long enough for the generator loop to observe the abort.
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(true);
    // Received at least one event before cancel; not all 100.
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(100);
  });

  test("cancel() immediately after subscribe still tears down", async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}));
    const events: unknown[] = [];
    let done = false;
    const sub = makeSub(makeReq("slow", undefined)).subscribe({
      onEvent: (d) => events.push(d),
      onError: () => {
        done = true;
      },
      onComplete: () => {
        done = true;
      },
    });
    sub.cancel();
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(true);
  });

  test("iterator-level throw surfaces as onError", async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}));
    const events: unknown[] = [];
    let error: Error | null = null;
    let complete = false;
    makeSub(makeReq("crashes", undefined)).subscribe({
      onEvent: (d) => events.push(d),
      onError: (e) => {
        error = e;
      },
      onComplete: () => {
        complete = true;
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(error).not.toBeNull();
    expect((error as unknown as Error).message).toContain("boom");
    expect(complete).toBe(false);
    expect(events).toEqual([{ first: true }]);
  });

  test("missing procedure → onError", async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}));
    let error: Error | null = null;
    makeSub(makeReq("missing.thing", undefined)).subscribe({
      onEvent: () => undefined,
      onError: (e) => {
        error = e;
      },
      onComplete: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(error).not.toBeNull();
  });

  test("type-mismatch (query routed as subscription) → onError", async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}));
    let error: Error | null = null;
    makeSub(makeReq("notFound", undefined)).subscribe({
      onEvent: () => undefined,
      onError: (e) => {
        error = e;
      },
      onComplete: () => undefined,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(error).not.toBeNull();
  });
});

/**
 * P4.1 (#139) X3 — the bridge's subscription buffer is bounded in bytes.
 * A producer that outruns its consumer ends with a typed
 * `stream-overflow`, what was already queued is still delivered (nothing
 * is dropped silently), and the producer is torn down.
 */
describe("bounded subscription buffer (P4.1 X3)", () => {
  const PAD = 1000;
  const limits = { maxFrameBytes: 4096, maxQueuedBytes: 16 * 1024 };
  const producer = { teardowns: 0, finishedNaturally: false, generatorClosed: 0 };

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- tRPC BuiltRouter internals are unnameable; the bridge accepts any router instance.
  function buildBoundsRouter() {
    return t.router({
      // Emits a synchronous burst, faster than any consumer can drain,
      // and would only finish on its own a little later. The bridge still
      // accepts Observable subscriptions, and they are what its buffer holds.
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- drives the bridge's Observable buffer.
      burst: t.procedure.input(z.object({ n: z.number().int().min(1) })).subscription(({ input }) =>
        observable<{ i: number; pad: string }>((emit) => {
          for (let i = 0; i < input.n; i++) emit.next({ i, pad: "x".repeat(PAD) });
          const timer = setTimeout(() => {
            producer.finishedNaturally = true;
            emit.complete();
          }, 30);
          return (): void => {
            clearTimeout(timer);
            producer.teardowns += 1;
          };
        }),
      ),
      oversized: t.procedure.subscription(async function* () {
        try {
          await Promise.resolve();
          yield { small: true };
          yield { pad: "x".repeat(8 * 1024) };
          yield { never: true };
        } finally {
          producer.generatorClosed += 1;
        }
      }),
      slow: t.procedure.subscription(async function* ({ signal }) {
        for (let i = 0; i < 100; i++) {
          if (signal?.aborted) break;
          yield { i };
          await new Promise((r) => setTimeout(r, 5));
        }
      }),
    });
  }

  interface Settled {
    error: (Error & { code?: string }) | null;
    complete: boolean;
  }

  function settle(
    sub: TunnelSubscription,
    events: unknown[],
  ): Promise<Settled> & {
    cancel: () => void;
  } {
    let cancel = (): void => undefined;
    const done = new Promise<Settled>((resolve) => {
      cancel = sub.subscribe({
        onEvent: (d) => events.push(d),
        onError: (e) => {
          resolve({ error: e, complete: false });
        },
        onComplete: () => {
          resolve({ error: null, complete: true });
        },
      }).cancel;
    });
    return Object.assign(done, {
      cancel: (): void => {
        cancel();
      },
    });
  }

  test("a burst past the queued-byte cap ends typed, delivers what was queued and tears the producer down", async () => {
    Object.assign(producer, { teardowns: 0, finishedNaturally: false });
    const makeSub = createTunnelSubscriptionHandler(buildBoundsRouter(), () => ({}), limits);
    const events: { i: number; pad: string }[] = [];
    const result = await settle(makeSub(makeReq("burst", { n: 200 })), events);
    const queuedBytes = events.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e)), 0);
    expect(result.error?.code ?? null).toBe(TUNNEL_STREAM_OVERFLOW);
    expect(result.complete).toBe(false);
    expect(events.length).toBeGreaterThan(0);
    expect(queuedBytes).toBeLessThanOrEqual(limits.maxQueuedBytes);
    // A gap-free prefix: the overflow ended the stream, it dropped nothing.
    expect(events.map((e) => e.i)).toEqual(events.map((_, i) => i));
    expect(producer.teardowns).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(producer.finishedNaturally).toBe(false);
  });

  test("an event above the frame cap ends the stream typed and closes the generator", async () => {
    producer.generatorClosed = 0;
    const makeSub = createTunnelSubscriptionHandler(buildBoundsRouter(), () => ({}), limits);
    const events: unknown[] = [];
    const result = await settle(makeSub(makeReq("oversized", undefined)), events);
    expect(result.error?.code ?? null).toBe(TUNNEL_STREAM_OVERFLOW);
    expect(events).toEqual([{ small: true }]);
    expect(producer.generatorClosed).toBe(1);
  });

  test("traffic inside the default limits flows untouched", async () => {
    Object.assign(producer, { teardowns: 0, finishedNaturally: false });
    const makeSub = createTunnelSubscriptionHandler(buildBoundsRouter(), () => ({}));
    const events: unknown[] = [];
    const result = await settle(makeSub(makeReq("burst", { n: 20 })), events);
    expect(result).toEqual({ error: null, complete: true });
    expect(events).toHaveLength(20);
  });

  test("a cancel is acknowledged with the typed stream-cancelled error, never a success-shaped end", async () => {
    const makeSub = createTunnelSubscriptionHandler(buildBoundsRouter(), () => ({}), limits);
    const events: unknown[] = [];
    const running = settle(makeSub(makeReq("slow", undefined)), events);
    await new Promise((r) => setTimeout(r, 20));
    running.cancel();
    const result = await running;
    expect(result.error?.code ?? null).toBe(TUNNEL_STREAM_CANCELLED);
    expect(result.complete).toBe(false);
    expect(events.length).toBeGreaterThan(0);
  });
});
