import { initTRPC } from "@trpc/server";
import { afterEach, describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { z } from "zod";

import type { StreamLimits, TunnelCancelOutcome } from "../src/tunnel/messages.js";

import { bearerHashMatches, hashToken } from "../src/server/auth.js";
import { nextRelayEvent } from "../src/server/tunnel-relay.js";
import {
  createTunnelClient,
  createTunnelServer,
  createTunnelSubscriptionHandler,
  type TunnelClient,
  type TunnelReq,
  type TunnelSubscription,
} from "../src/tunnel/index.js";

interface RunningServer {
  stop: () => Promise<void>;
  url: string;
  server: ReturnType<typeof createTunnelServer>;
}

interface ServerOptions {
  requestTimeoutMs?: number;
  streamLimits?: StreamLimits;
  onStreamCancelAck?: (nodeName: string, id: string, outcome: TunnelCancelOutcome) => void;
}

function startServer(bearer: string, opts: ServerOptions = {}): RunningServer {
  const srv = createTunnelServer({
    expectedBearerHash: hashToken(bearer),
    ...opts,
  });
  const bun = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      return srv.handleUpgrade(req, server) ?? new Response("not found", { status: 404 });
    },
    websocket: srv.websocket,
  });
  const port = bun.port ?? 0;
  return {
    url: `ws://127.0.0.1:${String(port)}/tunnel`,
    server: srv,
    stop: (): Promise<void> => {
      void bun.stop(true);
      return Promise.resolve();
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

let srv: RunningServer | null = null;
afterEach(async () => {
  if (srv) {
    await srv.stop();
    srv = null;
  }
});

// FIX [11] — a silent/dead peer that never sends a `res` frame must not
// hang the relay request forever and must not leak the pending entry.
describe("FIX [11]: send() request timeout", () => {
  test("send() rejects with tunnel-request-timeout when the node never replies", async () => {
    srv = startServer("tok", { requestTimeoutMs: 120 });
    let release: (() => void) | null = null;
    const client = createTunnelClient({
      url: srv.url,
      bearer: "tok",
      nodeName: "gpu1",
      // Handler that never resolves — the node is "alive but silent".
      handleRequest: () =>
        new Promise<unknown>((resolve) => {
          release = (): void => {
            resolve(null);
          };
        }),
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await client.start();
    await waitFor(() => srv!.server.registry().some((e) => e.nodeName === "gpu1"));

    const t0 = Date.now();
    try {
      await srv.server.send("gpu1", { id: "r-timeout", method: "stall" });
      throw new Error("expected send to reject on timeout");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/tunnel-request-timeout/);
      const code = (err as Error & { code?: string }).code;
      expect(code).toBe("tunnel-request-timeout");
    }
    const elapsed = Date.now() - t0;
    // Rejects within ~the timeout (not hanging forever).
    expect(elapsed).toBeLessThan(2000);

    // No leak: the pending entry was deleted on timeout.
    expect(srv.server.pendingCount("gpu1")).toBe(0);

    const releaseHandler = release as unknown as (() => void) | null;
    releaseHandler?.();
    client.stop();
  });

  test("a node that replies before the timeout resolves normally and clears the timer", async () => {
    srv = startServer("tok", { requestTimeoutMs: 5000 });
    const client = createTunnelClient({
      url: srv.url,
      bearer: "tok",
      nodeName: "gpu1",
      handleRequest: async (req: TunnelReq) => {
        await Promise.resolve();
        return { echoed: req.method };
      },
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await client.start();
    const res = await srv.server.send("gpu1", { id: "r-ok", method: "ping" });
    expect(res.result).toEqual({ echoed: "ping" });
    expect(srv.server.pendingCount("gpu1")).toBe(0);
    client.stop();
  });
});

// FIX [17] — the hello-frame bearer check must use a constant-time
// compare (mirroring verifyBearer), not a non-constant-time ===.
describe("FIX [17]: constant-time hello bearer check", () => {
  test("bearerHashMatches: correct token matches, wrong token + wrong-length reject", () => {
    const expected = hashToken("the-real-bearer");
    // Correct token hashes to the expected digest.
    expect(bearerHashMatches("the-real-bearer", expected)).toBe(true);
    // A wrong token of identical hash-length is rejected (the
    // timingSafeEqual path, not a length short-circuit).
    expect(bearerHashMatches("a-wrong-bearer-x", expected)).toBe(false);
    // A malformed/short expected digest is a clean reject, not a throw
    // (the length guard keeps timingSafeEqual from throwing).
    expect(bearerHashMatches("the-real-bearer", "deadbeef")).toBe(false);
  });

  test("correct bearer authenticates", async () => {
    srv = startServer("tok-good");
    const client = createTunnelClient({
      url: srv.url,
      bearer: "tok-good",
      nodeName: "gpu1",
      handleRequest: () => Promise.resolve(undefined),
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await client.start();
    expect(client.isReady()).toBe(true);
    await waitFor(() => srv!.server.registry().some((e) => e.nodeName === "gpu1"));
    client.stop();
  });

  test("wrong bearer is rejected (connection never registers)", async () => {
    srv = startServer("tok-good");
    const client = createTunnelClient({
      url: srv.url,
      bearer: "tok-bad",
      nodeName: "gpu1",
      handleRequest: () => Promise.resolve(undefined),
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    try {
      await client.start();
      throw new Error("expected start to fail");
    } catch (err) {
      expect((err as Error).message).toMatch(/closed before hello-ack/);
    }
    client.stop();
    // Wrong bearer must never register the node.
    expect(srv.server.registry()).toEqual([]);
  });
});

// FIX [7]/[12] — the SSE relay must not add one abort-event listener per
// streamed event. With N events on one stream, the abort-signal listener
// count must stay bounded (does not grow per event). P4.1 made the relay
// pull-driven, one step per read; each step holds one listener at most.
describe("FIX [7]/[12]: SSE pump abort-listener leak", () => {
  test("listener count on the abort signal stays bounded across N events", async () => {
    const N = 50;
    // Stub iterator that yields N values then completes.
    let i = 0;
    const iterator: AsyncIterator<unknown> = {
      next(): Promise<IteratorResult<unknown>> {
        if (i < N) {
          const value = { i: i++ };
          return Promise.resolve({ value, done: false });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
      return(): Promise<IteratorResult<unknown>> {
        return Promise.resolve({ value: undefined, done: true });
      },
    };

    const ac = new AbortController();
    const signal = ac.signal;
    const encoder = new TextEncoder();

    let maxListeners = 0;
    const enqueued: string[] = [];
    for (;;) {
      const pending = nextRelayEvent(iterator, signal);
      maxListeners = Math.max(maxListeners, getEventListeners(signal, "abort").length);
      const step = await pending;
      if (step === "aborted" || step.done === true) break;
      enqueued.push(new TextDecoder().decode(encoder.encode(JSON.stringify(step.value))));
    }

    expect(enqueued.length).toBe(N);
    // RED before the fix: maxListeners grows ~1 per event (≈N).
    // After: a single shared handler (≤1).
    expect(maxListeners).toBeLessThanOrEqual(1);
    // And the listener is cleaned up when the stream ends.
    expect(getEventListeners(signal, "abort").length).toBe(0);
  });
});

/**
 * P4.1 (#139) X3/X4 — central's per-stream queue is bounded in bytes and
 * every cancel it sends is acknowledged by the node. The node side runs
 * the real router bridge over a small router, so the acknowledgement is
 * the typed `stream-done` a production agent ships.
 */
describe("P4.1: bounded tunnel streams and acknowledged cancels", () => {
  const t = initTRPC.create();
  const node = { aborted: 0 };
  const nodeRouter = t.router({
    flood: t.procedure
      .input(z.object({ n: z.number().int(), pad: z.number().int(), delayMs: z.number().int() }))
      .subscription(async function* ({ input, signal }) {
        try {
          for (let i = 0; i < input.n; i++) {
            yield { i, pad: "x".repeat(input.pad) };
            await new Promise((r) => setTimeout(r, input.delayMs));
          }
        } finally {
          if (signal?.aborted === true) node.aborted += 1;
        }
      }),
  });
  const limits: StreamLimits = { maxFrameBytes: 4096, maxQueuedBytes: 16 * 1024 };
  let tunnel: TunnelClient | null = null;
  let acks: [string, string, TunnelCancelOutcome][] = [];
  const recordAck = (nodeName: string, id: string, outcome: TunnelCancelOutcome): void => {
    acks.push([nodeName, id, outcome]);
  };

  async function dialNode(
    url: string,
    handleSubscription: (req: TunnelReq) => TunnelSubscription = createTunnelSubscriptionHandler(
      nodeRouter,
      () => ({}),
    ),
  ): Promise<void> {
    tunnel = createTunnelClient({
      url,
      bearer: "tok",
      nodeName: "gpu1",
      handleRequest: () => Promise.resolve(null),
      handleSubscription,
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await tunnel.start();
    await waitFor(() => srv!.server.registry().some((e) => e.nodeName === "gpu1"));
  }

  function flood(id: string, input: { n: number; pad: number; delayMs: number }): TunnelReq {
    return { type: "req", id, method: "flood", params: { type: "subscription", input } };
  }

  async function drain(iterator: AsyncIterator<unknown>): Promise<{
    values: unknown[];
    error: (Error & { code?: string }) | null;
  }> {
    const values: unknown[] = [];
    try {
      for (let r = await iterator.next(); r.done !== true; r = await iterator.next()) {
        values.push(r.value);
      }
      return { values, error: null };
    } catch (err) {
      return { values, error: err as Error & { code?: string } };
    }
  }

  afterEach(() => {
    tunnel?.stop();
    tunnel = null;
    node.aborted = 0;
    acks = [];
  });

  test("a slow consumer holds at most the queued-byte cap; overflow ends it typed and cancels the node", async () => {
    srv = startServer("tok", { streamLimits: limits, onStreamCancelAck: recordAck });
    await dialNode(srv.url);
    const req = flood("flood-slow", { n: 2000, pad: 1000, delayMs: 0 });
    const iterator = srv.server.sendSubscribe("gpu1", req)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    // The consumer stops reading; sample the queue until the node is cancelled.
    let maxQueued = 0;
    await waitFor(
      () => {
        maxQueued = Math.max(maxQueued, srv!.server.queuedBytes("gpu1"));
        return node.aborted === 1;
      },
      5000,
      1,
    );
    expect(maxQueued).toBeGreaterThan(0);
    expect(maxQueued).toBeLessThanOrEqual(limits.maxQueuedBytes);
    await waitFor(() => acks.length === 1);
    expect(acks).toEqual([["gpu1", "flood-slow", "cancelled"]]);
    // What was queued is still delivered, then the typed terminal.
    const { values, error } = await drain(iterator);
    const drainedBytes = values.reduce<number>(
      (sum, v) => sum + Buffer.byteLength(JSON.stringify(v)),
      0,
    );
    expect(values.length).toBeGreaterThan(0);
    expect(drainedBytes).toBeLessThanOrEqual(limits.maxQueuedBytes);
    expect(error?.code).toBe("stream-overflow");
    expect(srv.server.queuedBytes("gpu1")).toBe(0);
  });

  test("an event above the stream frame cap ends that stream typed and cancels the node", async () => {
    srv = startServer("tok", { streamLimits: limits, onStreamCancelAck: recordAck });
    await dialNode(srv.url);
    const req = flood("flood-big", { n: 3, pad: 8 * 1024, delayMs: 20 });
    const { values, error } = await drain(
      srv.server.sendSubscribe("gpu1", req)[Symbol.asyncIterator](),
    );
    expect(values).toEqual([]);
    expect(error?.code).toBe("stream-overflow");
    await waitFor(() => node.aborted === 1 && acks.length === 1);
    expect(acks).toEqual([["gpu1", "flood-big", "cancelled"]]);
  });

  test("a consumer that leaves mid-stream cancels the node's stream and is acknowledged", async () => {
    srv = startServer("tok", { onStreamCancelAck: recordAck });
    await dialNode(srv.url);
    const req = flood("flood-leave", { n: 1000, pad: 10, delayMs: 5 });
    let seen = 0;
    for await (const _ of srv.server.sendSubscribe("gpu1", req)) {
      if (++seen === 2) break;
    }
    await waitFor(() => node.aborted === 1, 2000);
    await waitFor(() => acks.length === 1);
    expect(acks).toEqual([["gpu1", "flood-leave", "cancelled"]]);
    expect(srv.server.queuedBytes("gpu1")).toBe(0);
  });

  test("a cancel the node never acknowledges resolves as unknown, by timeout or by disconnect", async () => {
    // A node whose stream ignores cancels and never ends.
    const mute = (): TunnelSubscription => ({
      subscribe(handlers): { cancel(): void } {
        queueMicrotask(() => {
          handlers.onEvent({ i: 0 });
        });
        return { cancel: (): void => undefined };
      },
    });
    srv = startServer("tok", { requestTimeoutMs: 100, onStreamCancelAck: recordAck });
    await dialNode(srv.url, mute);
    for await (const _ of srv.server.sendSubscribe(
      "gpu1",
      flood("mute-1", { n: 1, pad: 0, delayMs: 0 }),
    )) {
      break;
    }
    await waitFor(() => acks.length === 1, 2000);
    expect(acks).toEqual([["gpu1", "mute-1", "unknown"]]);

    await srv.stop();
    tunnel?.stop();
    srv = startServer("tok", { onStreamCancelAck: recordAck });
    await dialNode(srv.url, mute);
    for await (const _ of srv.server.sendSubscribe(
      "gpu1",
      flood("mute-2", { n: 1, pad: 0, delayMs: 0 }),
    )) {
      break;
    }
    expect(srv.server.disconnect("gpu1")).toBe(true);
    await waitFor(() => acks.length === 2, 2000);
    expect(acks[1]).toEqual(["gpu1", "mute-2", "unknown"]);
  });

  test("a websocket drop ends the consumer's stream typed tunnel-disconnected and cancels the node via cleanupSocket", async () => {
    srv = startServer("tok", { onStreamCancelAck: recordAck });
    await dialNode(srv.url);
    let error: (Error & { code?: string }) | null = null;
    let disconnected: boolean | undefined;
    try {
      for await (const _ of srv.server.sendSubscribe(
        "gpu1",
        flood("ws-drop", { n: 1000, pad: 10, delayMs: 5 }),
      )) {
        disconnected ??= srv.server.disconnect("gpu1");
      }
    } catch (err) {
      error = err as Error & { code?: string };
    }
    expect(disconnected).toBe(true);
    expect(error?.code).toBe("tunnel-disconnected");
    await waitFor(() => node.aborted === 1, 2000);
  });

  test("a 4409 replacement mid-stream ends central's stream typed tunnel-disconnected, and central routes new requests to the replacement socket", async () => {
    srv = startServer("tok", { onStreamCancelAck: recordAck });
    await dialNode(srv.url);
    const iterator = srv.server
      .sendSubscribe("gpu1", flood("replaced", { n: 1000, pad: 10, delayMs: 5 }))
      [Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    const replacement = createTunnelClient({
      url: srv.url,
      bearer: "tok",
      nodeName: "gpu1",
      handleRequest: (req: TunnelReq) =>
        Promise.resolve({ answered: req.method, via: "new-socket" }),
      handleSubscription: createTunnelSubscriptionHandler(nodeRouter, () => ({})),
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await replacement.start();
    try {
      let error: (Error & { code?: string }) | null = null;
      try {
        for (let r = await iterator.next(); r.done !== true; r = await iterator.next()) {
          // drain until the displaced connection errors the stream
        }
      } catch (err) {
        error = err as Error & { code?: string };
      }
      expect(error?.code).toBe("tunnel-disconnected");
      await waitFor(() => node.aborted === 1, 2000);
      // stop the displaced client, so it cannot reconnect and displace the replacement
      tunnel?.stop();
      tunnel = null;
      // The displaced node cancelled its stream, and central's registry now
      // points at the replacement: a fresh request is answered by the new
      // socket, proving it took over rather than only that the old one died.
      let answered: unknown = null;
      for (let tries = 0; tries < 100; tries++) {
        try {
          const res = await srv.server.send("gpu1", {
            id: `st-${String(tries)}`,
            method: "status",
          });
          answered = res.result;
        } catch {
          // central may not yet have swapped the registry pointer
        }
        if (answered === null) await new Promise((r) => setTimeout(r, 25));
      }
      expect(answered).toEqual({ answered: "status", via: "new-socket" });
    } finally {
      replacement.stop();
    }
  });
});
