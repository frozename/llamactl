import { initTRPC } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  encodeTunnelMessage,
  frameBytes,
  parseTunnelMessage,
  TUNNEL_MAX_FRAME_BYTES,
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

/**
 * P4.1 (#139) — the 1 MiB event cap is the worker RPC's. Other tunneled
 * subscriptions (log tails, ops-chat journals, chat streams) can carry a
 * single event past 1 MiB, so by default they keep the cap a tunnel frame
 * always had: 16 MiB, Bun's WebSocket payload limit.
 */
describe("per-subscription event caps", () => {
  const BIG = 2 * 1024 * 1024;

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- tRPC BuiltRouter internals are unnameable; the bridge accepts any router instance.
  function buildCapsRouter() {
    const big = t.procedure.subscription(async function* () {
      await Promise.resolve();
      yield { pad: "x".repeat(BIG) };
    });
    return t.router({ serverLogs: big, inferenceRpc: t.router({ stream: big }) });
  }

  function run(method: string): Promise<{ events: number; code: string | null }> {
    const makeSub = createTunnelSubscriptionHandler(buildCapsRouter(), () => ({}));
    let events = 0;
    return new Promise((resolve) => {
      makeSub(makeReq(method, undefined)).subscribe({
        onEvent: () => {
          events += 1;
        },
        onError: (e) => {
          resolve({ events, code: (e as Error & { code?: string }).code ?? e.message });
        },
        onComplete: () => {
          resolve({ events, code: null });
        },
      });
    });
  }

  test("a non-RPC subscription delivers a 2 MiB event under the default limits", async () => {
    expect(await run("serverLogs")).toEqual({ events: 1, code: null });
  });

  test("an inferenceRpc subscription ends a 2 MiB event typed stream-overflow", async () => {
    expect(await run("inferenceRpc.stream")).toEqual({ events: 0, code: TUNNEL_STREAM_OVERFLOW });
  });
});

/**
 * P4.1 (#139) X3 — the per-event cap has to bound the encoded
 * `stream-event` frame, not just the event's own JSON. An event whose
 * data bytes fit under `maxFrameBytes` can still serialize past it once
 * the frame's `type`/`id`/`index` envelope is added, and central's
 * `parseTunnelMessage` would refuse that frame and drop the link.
 */
describe("per-event caps bound the encoded stream-event frame (P4.1 X3)", () => {
  const LIMITS = { maxFrameBytes: 4096, maxQueuedBytes: 16 * 1024 };

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- tRPC BuiltRouter internals are unnameable; the bridge accepts any router instance.
  function buildFrameRouter() {
    return t.router({
      serverLogs: t.procedure
        .input(
          z.object({
            n: z.number().int().min(0),
            count: z.number().int().min(1).optional(),
          }),
        )
        .subscription(async function* ({ input }) {
          await Promise.resolve();
          for (let i = 0; i < (input.count ?? 1); i++) {
            yield { pad: "x".repeat(input.n) };
          }
        }),
    });
  }

  function padEvent(n: number): { pad: string } {
    return { pad: "x".repeat(n) };
  }

  function eventJsonBytes(event: unknown): number {
    return frameBytes(JSON.stringify(event));
  }

  function streamFrameBytes(req: TunnelReq, index: number, data: unknown): number {
    return frameBytes(encodeTunnelMessage({ type: "stream-event", id: req.id, index, data }));
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

  test("an event under the data-byte cap whose encoded frame exceeds it ends typed stream-overflow", async () => {
    const n = TUNNEL_MAX_FRAME_BYTES - 16 - eventJsonBytes(padEvent(0));
    const req = makeReq("serverLogs", { n });
    const event = padEvent(n);
    expect(eventJsonBytes(event)).toBe(TUNNEL_MAX_FRAME_BYTES - 16);
    const makeSub = createTunnelSubscriptionHandler(buildFrameRouter(), () => ({}));
    const events: unknown[] = [];
    const result = await settle(makeSub(req), events);
    expect(events).toHaveLength(0);
    expect(result.error?.code ?? null).toBe(TUNNEL_STREAM_OVERFLOW);
    expect(result.complete).toBe(false);
    const encoded = encodeTunnelMessage({
      type: "stream-event",
      id: req.id,
      index: 0,
      data: event,
    });
    expect(frameBytes(encoded)).toBeGreaterThan(TUNNEL_MAX_FRAME_BYTES);
    expect(parseTunnelMessage(encoded)).toBeNull();
  });

  test("explicit limits: an event under maxFrameBytes whose encoded frame exceeds it ends typed stream-overflow", async () => {
    const { maxFrameBytes } = LIMITS;
    const n = maxFrameBytes - 8 - eventJsonBytes(padEvent(0));
    const req = makeReq("serverLogs", { n });
    const event = padEvent(n);
    expect(eventJsonBytes(event)).toBe(maxFrameBytes - 8);
    expect(streamFrameBytes(req, 0, event)).toBeGreaterThan(maxFrameBytes);
    const makeSub = createTunnelSubscriptionHandler(buildFrameRouter(), () => ({}), LIMITS);
    const events: unknown[] = [];
    const result = await settle(makeSub(req), events);
    expect(events).toHaveLength(0);
    expect(result.error?.code ?? null).toBe(TUNNEL_STREAM_OVERFLOW);
    expect(result.complete).toBe(false);
  });

  test("every delivered event's encoded stream-event frame stays within the cap", async () => {
    const { maxFrameBytes } = LIMITS;
    const n = maxFrameBytes - 8 - eventJsonBytes(padEvent(0));
    const req = makeReq("serverLogs", { n, count: 3 });
    const makeSub = createTunnelSubscriptionHandler(buildFrameRouter(), () => ({}), LIMITS);
    const events: unknown[] = [];
    const result = await settle(makeSub(req), events);
    for (const [index, data] of events.entries()) {
      expect(streamFrameBytes(req, index, data)).toBeLessThanOrEqual(maxFrameBytes);
    }
    expect(result.error?.code ?? null).toBe(TUNNEL_STREAM_OVERFLOW);
  });

  test("an event whose encoded frame fits within the cap is delivered and completes", async () => {
    const { maxFrameBytes } = LIMITS;
    const margin = 128;
    const probe = makeReq("serverLogs", undefined);
    const n = maxFrameBytes - margin - streamFrameBytes(probe, 0, padEvent(0));
    const req: TunnelReq = {
      ...probe,
      params: { type: "subscription", input: { n } },
    };
    const event = padEvent(n);
    expect(streamFrameBytes(req, 0, event)).toBe(maxFrameBytes - margin);
    const makeSub = createTunnelSubscriptionHandler(buildFrameRouter(), () => ({}), LIMITS);
    const events: unknown[] = [];
    const result = await settle(makeSub(req), events);
    expect(result).toEqual({ error: null, complete: true });
    expect(events).toEqual([event]);
  });

  test("overhead reserved for the widest stream index: frameCap - overhead(0) events end typed stream-overflow or deliver within cap", async () => {
    const frameCap = LIMITS.maxFrameBytes;
    const probe = makeReq("serverLogs", { n: 0, count: 15 });
    const overheadAtZero =
      frameBytes(
        encodeTunnelMessage({ type: "stream-event", id: probe.id, index: 0, data: null }),
      ) - frameBytes("null");
    const dataN = frameCap - overheadAtZero - eventJsonBytes(padEvent(0));
    const req: TunnelReq = {
      ...probe,
      params: { type: "subscription", input: { n: dataN, count: 15 } },
    };
    // Each event measures exactly frameCap - overhead(0). The bridge
    // reserves overhead at Number.MAX_SAFE_INTEGER (16 index digits),
    // so the same events measure frameCap + 15 and must overflow typed;
    // an index-0 reserve would deliver all 15, and the frames at
    // two-digit indices would exceed the cap by a byte.
    expect(overheadAtZero + eventJsonBytes(padEvent(dataN))).toBe(frameCap);
    const makeSub = createTunnelSubscriptionHandler(buildFrameRouter(), () => ({}), LIMITS);
    const events: unknown[] = [];
    const result = await settle(makeSub(req), events);
    for (const [index, data] of events.entries()) {
      expect(streamFrameBytes(req, index, data)).toBeLessThanOrEqual(frameCap);
    }
    expect(result.error?.code === TUNNEL_STREAM_OVERFLOW || result.complete).toBe(true);
  });

  test("limits above the tunnel frame size still clamp: a >16 MiB event ends typed stream-overflow", async () => {
    const clampedLimits = { maxFrameBytes: 32 * 1024 * 1024, maxQueuedBytes: 64 * 1024 * 1024 };
    const event = { pad: "x".repeat(17 * 1024 * 1024) };
    const req = makeReq("big", undefined);
    // Over the 16 MiB tunnel frame limit but under the requested 32
    // MiB: only the Math.min clamp can turn this into an overflow.
    expect(streamFrameBytes(req, 0, event)).toBeGreaterThan(TUNNEL_MAX_FRAME_BYTES);
    expect(streamFrameBytes(req, 0, event)).toBeLessThan(clampedLimits.maxFrameBytes);
    const router = t.router({
      big: t.procedure.subscription(async function* () {
        await Promise.resolve();
        yield event;
      }),
    });
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}), clampedLimits);
    const events: unknown[] = [];
    const result = await settle(makeSub(req), events);
    expect(result.error?.code ?? null).toBe(TUNNEL_STREAM_OVERFLOW);
    expect(result.complete).toBe(false);
    expect(events).toHaveLength(0);
  });

  test("an event whose measured stream-event frame is exactly the cap is delivered", async () => {
    const frameCap = LIMITS.maxFrameBytes;
    const id = `exact-${Math.random().toString(36).slice(2, 10)}`;
    const frameOverhead =
      frameBytes(
        encodeTunnelMessage({
          type: "stream-event",
          id,
          index: Number.MAX_SAFE_INTEGER,
          data: null,
        }),
      ) - frameBytes("null");
    const n = frameCap - frameOverhead - eventJsonBytes(padEvent(0));
    const event = padEvent(n);
    const req: TunnelReq = {
      id,
      type: "req",
      method: "serverLogs",
      params: { type: "subscription", input: { n, count: 1 } },
    };
    // The bridge measures overhead + data bytes with the widest index
    // reserved, so the measure lands exactly on the cap: `>` delivers,
    // `>=` would overflow. The real index-0 frame sits 15 bytes under.
    expect(frameOverhead + eventJsonBytes(event)).toBe(frameCap);
    expect(streamFrameBytes(req, 0, event)).toBe(frameCap - 15);
    const makeSub = createTunnelSubscriptionHandler(buildFrameRouter(), () => ({}), LIMITS);
    const events: unknown[] = [];
    const result = await settle(makeSub(req), events);
    expect(result).toEqual({ error: null, complete: true });
    expect(events).toEqual([event]);
  });
});
