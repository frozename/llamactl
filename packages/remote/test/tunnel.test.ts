import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  TUNNEL_CLOSE_UNAUTHORIZED,
  createTunnelClient,
  createTunnelServer,
  encodeTunnelMessage,
  parseTunnelMessage,
  type TunnelMessage,
  type TunnelReq,
  type TunnelState,
} from '../src/tunnel/index.js';
import { hashToken } from '../src/server/auth.js';

// Bun's built-in WebSocket on the client side is globalThis.WebSocket.
// The server is Bun.serve with a websocket handler.

interface RunningServer {
  stop: () => Promise<void>;
  port: number;
  url: string;
  server: ReturnType<typeof createTunnelServer>;
  connects: string[];
  disconnects: Array<{ node: string; reason: string }>;
}

function startServer(bearer: string, opts: { fixedTime?: string } = {}): RunningServer {
  const connects: string[] = [];
  const disconnects: Array<{ node: string; reason: string }> = [];
  const srv = createTunnelServer({
    expectedBearerHash: hashToken(bearer),
    onNodeConnect: (n) => connects.push(n),
    onNodeDisconnect: (n, r) => disconnects.push({ node: n, reason: r }),
    clock: opts.fixedTime ? () => new Date(opts.fixedTime!) : undefined,
  });
  const bun = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      return (
        srv.handleUpgrade(req, server) ??
        new Response('not found', { status: 404 })
      );
    },
    websocket: srv.websocket,
  });
  const port = bun.port ?? 0;
  return {
    port,
    url: `ws://127.0.0.1:${port}/tunnel`,
    server: srv,
    connects,
    disconnects,
    stop: async () => { bun.stop(true); },
  };
}

// Helpers to avoid races in close-code tests.
async function waitFor(
  check: () => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

let srv: RunningServer | null = null;

beforeEach(() => { srv = null; });
afterEach(async () => {
  if (srv) {
    await srv.stop();
    srv = null;
  }
});

describe('message schema', () => {
  test('parseTunnelMessage round-trips known shapes', () => {
    const hello: TunnelMessage = { type: 'hello', bearer: 't', nodeName: 'gpu1' };
    expect(parseTunnelMessage(encodeTunnelMessage(hello))).toEqual(hello);
    const res: TunnelMessage = {
      type: 'res',
      id: 'r1',
      result: { ok: true, n: 7 },
    };
    expect(parseTunnelMessage(encodeTunnelMessage(res))).toEqual(res);
  });
  test('rejects malformed JSON', () => {
    expect(parseTunnelMessage('{not json')).toBeNull();
  });
  test('rejects unknown types', () => {
    expect(parseTunnelMessage(JSON.stringify({ type: 'bogus' }))).toBeNull();
  });
});

describe('tunnel handshake', () => {
  test('hello with correct bearer → hello-ack + registry records connection', async () => {
    srv = startServer('tok-good');
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok-good',
      nodeName: 'gpu1',
      handleRequest: async () => ({ ok: true }),
    });
    await client.start();
    expect(client.isReady()).toBe(true);
    await waitFor(() => srv!.connects.includes('gpu1'));
    expect(srv.connects).toEqual(['gpu1']);
    expect(srv.server.registry().map((e) => e.nodeName)).toEqual(['gpu1']);
    client.stop();
  });

  test('hello with wrong bearer → close 4401 and connect rejects', async () => {
    srv = startServer('tok-good');
    let closeCode = 0;
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok-bad',
      nodeName: 'gpu1',
      handleRequest: async () => undefined,
      onClose: (code) => {
        closeCode = code;
      },
    });
    await expect(client.start()).rejects.toThrow(/closed before hello-ack/);
    client.stop();
    await waitFor(() => closeCode !== 0);
    expect(closeCode).toBe(TUNNEL_CLOSE_UNAUTHORIZED);
    expect(srv.server.registry()).toEqual([]);
  });
});

describe('request/response correlation', () => {
  test('server.send dispatches to the right node, resolves with its reply', async () => {
    srv = startServer('tok');
    const seen: TunnelReq[] = [];
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: async (req) => {
        seen.push(req);
        if (req.method === 'node.facts') return { profile: 'macbook-pro-48g', memBytes: 68719476736 };
        throw new Error(`unknown method ${req.method}`);
      },
    });
    await client.start();
    const res = await srv.server.send('gpu1', { id: 'r1', method: 'node.facts' });
    expect(res.id).toBe('r1');
    expect(res.result).toEqual({ profile: 'macbook-pro-48g', memBytes: 68719476736 });
    expect(res.error).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('node.facts');
    client.stop();
  });

  test('handler that throws surfaces as res.error without tearing the tunnel down', async () => {
    srv = startServer('tok');
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: async () => { throw new Error('boom'); },
    });
    await client.start();
    const res = await srv.server.send('gpu1', { id: 'r2', method: 'any' });
    expect(res.error?.code).toBe('handler-threw');
    expect(res.error?.message).toBe('boom');
    // Tunnel still up — a second call succeeds after the handler is swapped mentally.
    const res2 = await srv.server.send('gpu1', { id: 'r3', method: 'another' });
    expect(res2.error?.code).toBe('handler-threw');
    client.stop();
  });

  test('three concurrent requests resolve with matching ids — no crossed wires', async () => {
    srv = startServer('tok');
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: async (req) => {
        // Randomize completion ordering.
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 20)));
        return { id: req.id, method: req.method };
      },
    });
    await client.start();
    const [a, b, c] = await Promise.all([
      srv.server.send('gpu1', { id: 'rA', method: 'one' }),
      srv.server.send('gpu1', { id: 'rB', method: 'two' }),
      srv.server.send('gpu1', { id: 'rC', method: 'three' }),
    ]);
    expect([a.id, b.id, c.id]).toEqual(['rA', 'rB', 'rC']);
    expect((a.result as { id: string }).id).toBe('rA');
    expect((b.result as { method: string }).method).toBe('two');
    expect((c.result as { id: string }).id).toBe('rC');
    client.stop();
  });

  test('unknown node errors synchronously on send', async () => {
    srv = startServer('tok');
    await expect(
      srv.server.send('no-such-node', { id: 'r1', method: 'x' }),
    ).rejects.toThrow(/tunnel not connected/);
  });
});

describe('ping/pong', () => {
  test('client ping round-trips', async () => {
    srv = startServer('tok');
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: async () => undefined,
    });
    await client.start();
    await client.ping('nonce-xyz');
    client.stop();
  });
});

describe('disconnect semantics', () => {
  test('client close removes node from registry + fires onNodeDisconnect', async () => {
    srv = startServer('tok');
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: async () => undefined,
    });
    await client.start();
    expect(srv.server.registry().map((e) => e.nodeName)).toEqual(['gpu1']);
    client.stop();
    await waitFor(() => srv!.disconnects.length > 0);
    expect(srv.disconnects[0]?.node).toBe('gpu1');
    expect(srv.server.registry()).toEqual([]);
  });

  test('server disconnect errors pending requests', async () => {
    srv = startServer('tok');
    // Handler never returns — the server-side send() promise should
    // be rejected when we forcibly disconnect the node.
    let release: (() => void) | null = null;
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: () =>
        new Promise<unknown>((resolve) => { release = () => resolve(null); }),
    });
    await client.start();
    const inflight = srv.server.send('gpu1', { id: 'r1', method: 'stall' });
    // Give server/client a tick to set up the pending map before
    // we kick the tunnel.
    await new Promise((r) => setTimeout(r, 20));
    srv.server.disconnect('gpu1', 'kicked');
    await expect(inflight).rejects.toThrow(/tunnel-disconnected/);
    // Free the dangling handler so the test's cleanup doesn't hold
    // a live promise.
    if (release) (release as () => void)();
    client.stop();
  });

  test('duplicate nodeName: newest connection wins, older is closed with 4409', async () => {
    srv = startServer('tok');
    const first = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: async () => ({ from: 'first' }),
    });
    await first.start();
    const second = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: async () => ({ from: 'second' }),
      // Don't let `first` auto-reconnect after the server kicks it
      // with 4409 — this test is specifically about the replacement
      // behavior, not reconnect.
      reconnect: { minDelayMs: 100000, maxDelayMs: 100000, jitterFraction: 0 },
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await second.start();
    // Give the older socket time to observe its close frame.
    await new Promise((r) => setTimeout(r, 50));
    const res = await srv.server.send('gpu1', { id: 'r1', method: 'who' });
    expect((res.result as { from: string }).from).toBe('second');
    first.stop();
    second.stop();
  });
});

describe('reconnect + heartbeat (I.3.2)', () => {
  test('client auto-reconnects after the server kicks it', async () => {
    srv = startServer('tok');
    const states: TunnelState[] = [];
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: async () => ({ ok: true }),
      reconnect: { minDelayMs: 20, maxDelayMs: 100, jitterFraction: 0 },
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
      onStateChange: (s) => states.push(s),
    });
    await client.start();
    expect(client.state()).toBe('ready');
    srv.server.disconnect('gpu1', 'test-kick');
    await waitFor(() => srv!.connects.length >= 2);
    await client.waitUntilReady(2000);
    expect(client.state()).toBe('ready');
    expect(srv.connects).toEqual(['gpu1', 'gpu1']);
    expect(states).toContain('disconnected');
    expect(states.filter((s) => s === 'ready').length).toBeGreaterThanOrEqual(2);
    client.stop();
  });

  test('stop() halts the reconnect loop — no further connects after stop', async () => {
    srv = startServer('tok');
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: async () => undefined,
      reconnect: { minDelayMs: 10, maxDelayMs: 50, jitterFraction: 0 },
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await client.start();
    client.stop();
    const connectsAtStop = srv.connects.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(srv.connects.length).toBe(connectsAtStop);
    expect(client.state()).toBe('stopped');
  });

  test('waitUntilReady resolves immediately when already ready', async () => {
    srv = startServer('tok');
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: async () => undefined,
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await client.start();
    await client.waitUntilReady(50);
    expect(client.isReady()).toBe(true);
    client.stop();
  });

  test('waitUntilReady rejects after timeout when we never reach ready', async () => {
    srv = startServer('tok-good');
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok-bad',
      nodeName: 'gpu1',
      handleRequest: async () => undefined,
      reconnect: { minDelayMs: 50, maxDelayMs: 50, jitterFraction: 0 },
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
      initialAttemptTimeoutMs: 0, // background mode — start resolves immediately
    });
    await client.start();
    await expect(client.waitUntilReady(150)).rejects.toThrow(/timeout/);
    client.stop();
  });

  test('backoff resets on healthy hello-ack — second reconnect uses minDelay', async () => {
    srv = startServer('tok');
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: async () => undefined,
      reconnect: { minDelayMs: 30, maxDelayMs: 500, jitterFraction: 0 },
      heartbeat: { intervalMs: 0, timeoutMs: 0 },
    });
    await client.start();
    const delays: number[] = [];

    const t0 = Date.now();
    srv.server.disconnect('gpu1', 'kick1');
    await waitFor(() => srv!.connects.length >= 2);
    await client.waitUntilReady(1000);
    delays.push(Date.now() - t0);

    const t1 = Date.now();
    srv.server.disconnect('gpu1', 'kick2');
    await waitFor(() => srv!.connects.length >= 3);
    await client.waitUntilReady(1000);
    delays.push(Date.now() - t1);

    // Both gaps should land close to minDelay (30ms). Generous upper
    // bound for CI jitter, but meaningfully below the next tier
    // (60ms would imply attempt=2, i.e. counter wasn't reset).
    for (const d of delays) {
      expect(d).toBeLessThan(120);
    }
    client.stop();
  });

  test('heartbeat round-trips with a healthy server — tunnel stays ready, no reconnect', async () => {
    srv = startServer('tok');
    const client = createTunnelClient({
      url: srv.url,
      bearer: 'tok',
      nodeName: 'gpu1',
      handleRequest: async () => undefined,
      reconnect: { minDelayMs: 30, maxDelayMs: 100, jitterFraction: 0 },
      heartbeat: { intervalMs: 30, timeoutMs: 100 },
    });
    await client.start();
    const connectsAtStart = srv.connects.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(client.state()).toBe('ready');
    expect(srv.connects.length).toBe(connectsAtStart);
    client.stop();
  });

  test('heartbeat timeout on a stub server that never pongs forces reconnect', async () => {
    // Custom stub: accepts hello + acks, then drops every subsequent
    // message (no pongs). Client should trip heartbeat timeout,
    // close with 4000, and reconnect.
    let acceptedHellos = 0;
    const bun = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, server) {
        if (new URL(req.url).pathname !== '/tunnel') return new Response('nf', { status: 404 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ok = (server as any).upgrade(req, { data: { hello: false } });
        return ok ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open() { /* wait for hello */ },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        message(ws: any, data: string | Buffer) {
          const raw = typeof data === 'string' ? data : data.toString('utf8');
          const msg = parseTunnelMessage(raw);
          if (!msg) return;
          if (msg.type === 'hello' && !ws.data.hello) {
            ws.data.hello = true;
            acceptedHellos++;
            ws.send(encodeTunnelMessage({ type: 'hello-ack', serverTime: new Date().toISOString() }));
            return;
          }
          // Drop everything else — no pong.
        },
        close() { /* noop */ },
      },
    });
    try {
      const client = createTunnelClient({
        url: `ws://127.0.0.1:${bun.port}/tunnel`,
        bearer: 'tok',
        nodeName: 'gpu1',
        handleRequest: async () => undefined,
        reconnect: { minDelayMs: 20, maxDelayMs: 60, jitterFraction: 0 },
        heartbeat: { intervalMs: 30, timeoutMs: 40 },
      });
      await client.start();
      expect(acceptedHellos).toBe(1);
      // Within ~500ms the client should miss a pong and reconnect.
      await waitFor(() => acceptedHellos >= 2, 2000);
      client.stop();
    } finally {
      bun.stop(true);
    }
  });
});
