import { afterEach, describe, expect, test } from 'bun:test';
import {
  createTunnelClient,
  createTunnelServer,
  type TunnelReq,
  type TunnelSubscription,
} from '../src/tunnel/index.js';
import { hashToken } from '../src/server/auth.js';
import { handleTunnelRelay } from '../src/server/tunnel-relay.js';

/**
 * B.4 coverage — end-to-end SSE relay. Boots a central agent with
 * a tunnel-server, dials a client whose handleSubscription emits a
 * scripted event sequence, then hits `/tunnel-relay/<node>?stream=true`
 * via `fetch` and parses the SSE body.
 */

interface SSEFrame {
  event?: string;
  data: string;
}

async function readSSE(res: Response, maxFrames = 50): Promise<SSEFrame[]> {
  const out: SSEFrame[] = [];
  if (!res.body) return out;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (out.length < maxFrames) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!chunk) continue;
      const frame: SSEFrame = { data: '' };
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) frame.event = line.slice(6).trim();
        else if (line.startsWith('data:')) frame.data = line.slice(5).trim();
      }
      out.push(frame);
      if (frame.event === 'done') return out;
    }
  }
  return out;
}

interface RunningHarness {
  stop: () => Promise<void>;
  bunPort: number;
  bearer: string;
  bun: ReturnType<typeof Bun.serve>;
  receivedCancel: string[];
}

async function startHarness(script: {
  events: unknown[];
  delayMs?: number;
  throwErr?: Error;
}): Promise<RunningHarness> {
  const bearer = 'relay-bearer';
  const tunnelBearer = 'tunnel-bearer';
  const bearerHash = hashToken(bearer);
  const nodeName = 'node1';
  const receivedCancel: string[] = [];
  const tunnelSrv = createTunnelServer({
    expectedBearerHash: hashToken(tunnelBearer),
  });
  const bun = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/tunnel') {
        return (
          tunnelSrv.handleUpgrade(req, server) ??
          new Response('no', { status: 400 })
        );
      }
      if (url.pathname.startsWith('/tunnel-relay/')) {
        return handleTunnelRelay(req, url, tunnelSrv, bearerHash);
      }
      return new Response('404', { status: 404 });
    },
    websocket: tunnelSrv.websocket,
  });
  const bunPort = bun.port ?? 0;
  const handleSubscription = (req: TunnelReq): TunnelSubscription => ({
    subscribe(handlers) {
      let cancelled = false;
      (async () => {
        for (const ev of script.events) {
          if (cancelled) break;
          await new Promise((r) => setTimeout(r, script.delayMs ?? 2));
          if (cancelled) break;
          handlers.onEvent(ev);
        }
        if (cancelled) {
          handlers.onComplete();
          return;
        }
        if (script.throwErr) {
          handlers.onError(script.throwErr);
          return;
        }
        handlers.onComplete();
      })();
      return {
        cancel(): void {
          cancelled = true;
          receivedCancel.push(req.id);
        },
      };
    },
  });
  const client = createTunnelClient({
    url: `ws://127.0.0.1:${bunPort}/tunnel`,
    bearer: tunnelBearer,
    nodeName,
    handleRequest: async () => ({}),
    handleSubscription,
    initialAttemptTimeoutMs: 2000,
    heartbeat: { intervalMs: 0 },
  });
  await client.start();
  return {
    bunPort,
    bearer,
    bun,
    receivedCancel,
    async stop() {
      client.stop();
      bun.stop();
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}

describe('tunnel-relay SSE', () => {
  let harness: RunningHarness;
  afterEach(async () => {
    if (harness) await harness.stop();
  });

  test('relays three events + done frame over SSE', async () => {
    harness = await startHarness({
      events: [{ i: 0 }, { i: 1 }, { i: 2 }],
    });
    const res = await fetch(
      `http://127.0.0.1:${harness.bunPort}/tunnel-relay/node1?stream=true`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'tick', type: 'subscription', input: null }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readSSE(res);
    const dataFrames = frames.filter((f) => !f.event);
    const doneFrames = frames.filter((f) => f.event === 'done');
    expect(dataFrames.map((f) => JSON.parse(f.data))).toEqual([
      { i: 0 },
      { i: 1 },
      { i: 2 },
    ]);
    expect(doneFrames.length).toBe(1);
    expect(JSON.parse(doneFrames[0]!.data)).toEqual({ ok: true });
  });

  test('agent-side error surfaces as done with ok:false', async () => {
    harness = await startHarness({
      events: [{ seen: 1 }],
      throwErr: Object.assign(new Error('kaboom'), { code: 'E42' }),
    });
    const res = await fetch(
      `http://127.0.0.1:${harness.bunPort}/tunnel-relay/node1?stream=true`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'boom', type: 'subscription', input: null }),
      },
    );
    const frames = await readSSE(res);
    const done = frames.find((f) => f.event === 'done');
    expect(done).toBeDefined();
    const parsed = JSON.parse(done!.data);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toBe('kaboom');
  });

  test('client AbortController mid-stream triggers agent stream-cancel', async () => {
    harness = await startHarness({
      events: Array.from({ length: 20 }, (_, i) => ({ i })),
      delayMs: 15,
    });
    const ac = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${harness.bunPort}/tunnel-relay/node1?stream=true`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'long', type: 'subscription', input: null }),
        signal: ac.signal,
      },
    );
    expect(res.status).toBe(200);
    // Read one frame then abort.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    ac.abort();
    try {
      await reader.cancel();
    } catch {
      // cancel on aborted reader may reject; ignore.
    }
    // Give the cancel propagation time to round-trip.
    await new Promise((r) => setTimeout(r, 150));
    expect(harness.receivedCancel.length).toBeGreaterThan(0);
  });

  test('SSE rejects without bearer', async () => {
    harness = await startHarness({ events: [] });
    const res = await fetch(
      `http://127.0.0.1:${harness.bunPort}/tunnel-relay/node1?stream=true`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'x', type: 'subscription', input: null }),
      },
    );
    expect(res.status).toBe(401);
  });

  test('SSE against disconnected node ships an error done frame', async () => {
    harness = await startHarness({ events: [] });
    const res = await fetch(
      `http://127.0.0.1:${harness.bunPort}/tunnel-relay/ghost?stream=true`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${harness.bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'x', type: 'subscription', input: null }),
      },
    );
    expect(res.status).toBe(200);
    const frames = await readSSE(res);
    const done = frames.find((f) => f.event === 'done');
    expect(done).toBeDefined();
    const parsed = JSON.parse(done!.data);
    expect(parsed.ok).toBe(false);
  });
});
