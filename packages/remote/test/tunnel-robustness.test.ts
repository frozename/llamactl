import { afterEach, describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";

import { bearerHashMatches, hashToken } from "../src/server/auth.js";
import { pumpSubscriptionEvents } from "../src/server/tunnel-relay.js";
import { createTunnelClient, createTunnelServer, type TunnelReq } from "../src/tunnel/index.js";

interface RunningServer {
  stop: () => Promise<void>;
  url: string;
  server: ReturnType<typeof createTunnelServer>;
}

function startServer(bearer: string, opts: { requestTimeoutMs?: number } = {}): RunningServer {
  const srv = createTunnelServer({
    expectedBearerHash: hashToken(bearer),
    requestTimeoutMs: opts.requestTimeoutMs,
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

// FIX [7]/[12] — the SSE pump must not add one abort-event listener per
// streamed event. With N events on one stream, the abort-signal listener
// count must stay bounded (does not grow per event).
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
    const controller = {
      enqueue(chunk: Uint8Array): void {
        enqueued.push(new TextDecoder().decode(chunk));
        const count = getEventListeners(signal, "abort").length;
        if (count > maxListeners) maxListeners = count;
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>;

    await pumpSubscriptionEvents(iterator, controller, encoder, signal);

    expect(enqueued.length).toBe(N);
    // RED before the fix: maxListeners grows ~1 per event (≈N).
    // After: a single shared handler (≤1).
    expect(maxListeners).toBeLessThanOrEqual(1);
    // And the listener is cleaned up when the stream ends.
    expect(getEventListeners(signal, "abort").length).toBe(0);
  });
});
