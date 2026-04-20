import { afterEach, describe, expect, test } from 'bun:test';
import {
  createTunnelClient,
  createTunnelServer,
  type TunnelReq,
  type TunnelSubscription,
} from '../src/tunnel/index.js';
import { hashToken } from '../src/server/auth.js';

/**
 * B.3 coverage — `sendSubscribe` on the central tunnel server.
 * Goal: in-proc round-trip with a fake dialing client whose
 * `handleSubscription` emits a scripted event sequence.
 */

interface ScriptedSub {
  events: unknown[];
  /** Optional terminal throw — fires after the events drain. */
  throwErr?: Error;
  /** Delay (ms) between events, default 2. Keeps the cancel tests
   *  deterministic. */
  delayMs?: number;
}

interface RunningPair {
  bearer: string;
  nodeName: string;
  url: string;
  stop: () => Promise<void>;
  server: ReturnType<typeof createTunnelServer>;
  client: ReturnType<typeof createTunnelClient>;
  receivedCancel: string[];
}

async function startPair(script: Map<string, ScriptedSub>): Promise<RunningPair> {
  const bearer = 'secret-bearer';
  const nodeName = 'n1';
  const receivedCancel: string[] = [];
  const srv = createTunnelServer({
    expectedBearerHash: hashToken(bearer),
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
  const url = `ws://127.0.0.1:${port}/tunnel`;

  // Build a subscription handler honouring the `script` map.
  const handleSubscription = (req: TunnelReq): TunnelSubscription => ({
    subscribe(handlers) {
      const entry = script.get(req.method);
      if (!entry) {
        setImmediate(() =>
          handlers.onError(new Error(`unknown method ${req.method}`)),
        );
        return { cancel() { /* no-op */ } };
      }
      let cancelled = false;
      const run = async (): Promise<void> => {
        for (const ev of entry.events) {
          if (cancelled) break;
          await new Promise((r) => setTimeout(r, entry.delayMs ?? 2));
          if (cancelled) break;
          handlers.onEvent(ev);
        }
        if (cancelled) {
          receivedCancel.push(req.id);
          handlers.onComplete();
          return;
        }
        if (entry.throwErr) {
          handlers.onError(entry.throwErr);
          return;
        }
        handlers.onComplete();
      };
      void run();
      return {
        cancel(): void {
          cancelled = true;
          receivedCancel.push(req.id);
        },
      };
    },
  });
  const client = createTunnelClient({
    url,
    bearer,
    nodeName,
    handleRequest: async () => ({ ok: true }), // not used here
    handleSubscription,
    initialAttemptTimeoutMs: 2000,
    heartbeat: { intervalMs: 0 },
  });
  await client.start();
  return {
    bearer,
    nodeName,
    url,
    server: srv,
    client,
    receivedCancel,
    async stop() {
      client.stop();
      bun.stop();
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}

function makeReq(method: string, input: unknown = {}): Omit<TunnelReq, 'type'> {
  return {
    id: `sub-${Math.random().toString(36).slice(2)}`,
    method,
    params: { type: 'subscription', input },
  };
}

describe('tunnel-server: sendSubscribe', () => {
  let pair: RunningPair;
  afterEach(async () => {
    if (pair) await pair.stop();
  });

  test('streams three events to completion', async () => {
    pair = await startPair(
      new Map([
        ['tick', { events: [{ i: 0 }, { i: 1 }, { i: 2 }] }],
      ]),
    );
    const collected: unknown[] = [];
    for await (const v of pair.server.sendSubscribe(
      pair.nodeName,
      makeReq('tick'),
    )) {
      collected.push(v);
    }
    expect(collected).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  test('error frame throws from the iterator', async () => {
    pair = await startPair(
      new Map([
        [
          'boom',
          {
            events: [{ only: true }],
            throwErr: Object.assign(new Error('sim failure'), { code: 'X123' }),
          },
        ],
      ]),
    );
    let events: unknown[] = [];
    let caught: Error | null = null;
    try {
      for await (const v of pair.server.sendSubscribe(
        pair.nodeName,
        makeReq('boom'),
      )) {
        events.push(v);
      }
    } catch (err) {
      caught = err as Error;
    }
    expect(events).toEqual([{ only: true }]);
    expect(caught).not.toBeNull();
    expect((caught as Error).message).toBe('sim failure');
  });

  test('break mid-stream fires a stream-cancel on the agent', async () => {
    pair = await startPair(
      new Map([
        [
          'long',
          {
            events: Array.from({ length: 20 }, (_, i) => ({ i })),
            delayMs: 10,
          },
        ],
      ]),
    );
    const collected: unknown[] = [];
    const req = makeReq('long');
    for await (const v of pair.server.sendSubscribe(pair.nodeName, req)) {
      collected.push(v);
      if (collected.length === 2) break;
    }
    // Give the cancel frame time to arrive at the agent.
    await new Promise((r) => setTimeout(r, 50));
    expect(collected.length).toBe(2);
    expect(pair.receivedCancel).toContain(req.id);
  });

  test('disconnect mid-stream throws a tunnel-disconnected error', async () => {
    pair = await startPair(
      new Map([
        [
          'forever',
          {
            events: Array.from({ length: 100 }, (_, i) => ({ i })),
            delayMs: 10,
          },
        ],
      ]),
    );
    const collected: unknown[] = [];
    let caught: Error | null = null;
    try {
      for await (const v of pair.server.sendSubscribe(
        pair.nodeName,
        makeReq('forever'),
      )) {
        collected.push(v);
        if (collected.length === 2) {
          pair.server.disconnect(pair.nodeName, 'test kick');
        }
      }
    } catch (err) {
      caught = err as Error;
    }
    expect(collected.length).toBeGreaterThanOrEqual(2);
    expect(caught).not.toBeNull();
  });

  test('sendSubscribe against an unknown node throws on first next()', async () => {
    pair = await startPair(new Map());
    let caught: Error | null = null;
    try {
      for await (const _v of pair.server.sendSubscribe(
        'unknown-node',
        makeReq('tick'),
      )) {
        // unreachable
      }
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).message).toContain("tunnel not connected");
  });
});
