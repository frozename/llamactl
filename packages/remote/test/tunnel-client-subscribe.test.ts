import { afterEach, describe, expect, test } from 'bun:test';
import {
  createTunnelClient,
  createTunnelServer,
  type TunnelReq,
  type TunnelSubscription,
} from '../src/tunnel/index.js';
import { hashToken } from '../src/server/auth.js';

/**
 * B.3 coverage — verify the tunnel CLIENT ships stream frames in
 * the right shape. Uses the real central server via in-proc ws so
 * we can inspect the on-wire sequence via `sendSubscribe`'s
 * iterator (which is the server's parsed stream view).
 */

describe('tunnel-client: handleSubscription', () => {
  let stops: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const s of stops.splice(0)) await s();
  });

  test('events arrive in agent-emit order', async () => {
    const bearer = 'b';
    const srv = createTunnelServer({ expectedBearerHash: hashToken(bearer) });
    const bun = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, server) {
        return srv.handleUpgrade(req, server) ??
          new Response('404', { status: 404 });
      },
      websocket: srv.websocket,
    });
    stops.push(() => { bun.stop(); });
    const port = bun.port ?? 0;
    const url = `ws://127.0.0.1:${port}/tunnel`;

    const handleSubscription = (_req: TunnelReq): TunnelSubscription => ({
      subscribe(handlers) {
        // synchronous fan-out then complete
        queueMicrotask(() => {
          handlers.onEvent('a');
          handlers.onEvent('b');
          handlers.onEvent('c');
          handlers.onComplete();
        });
        return { cancel() { /* no-op */ } };
      },
    });
    const client = createTunnelClient({
      url,
      bearer,
      nodeName: 'node1',
      handleRequest: async () => ({}),
      handleSubscription,
      initialAttemptTimeoutMs: 2000,
      heartbeat: { intervalMs: 0 },
    });
    await client.start();
    stops.push(() => { client.stop(); });

    const got: unknown[] = [];
    for await (const v of srv.sendSubscribe('node1', {
      id: 'x1',
      method: 'anything',
      params: { type: 'subscription', input: null },
    })) {
      got.push(v);
    }
    expect(got).toEqual(['a', 'b', 'c']);
  });

  test('server-initiated stream-cancel tears down the agent subscription', async () => {
    const bearer = 'b';
    const srv = createTunnelServer({ expectedBearerHash: hashToken(bearer) });
    const bun = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, server) {
        return srv.handleUpgrade(req, server) ??
          new Response('404', { status: 404 });
      },
      websocket: srv.websocket,
    });
    stops.push(() => { bun.stop(); });
    const port = bun.port ?? 0;
    const url = `ws://127.0.0.1:${port}/tunnel`;

    const cancelledSubs: string[] = [];
    const handleSubscription = (req: TunnelReq): TunnelSubscription => ({
      subscribe(handlers) {
        let cancelled = false;
        (async () => {
          for (let i = 0; i < 50; i++) {
            if (cancelled) break;
            await new Promise((r) => setTimeout(r, 10));
            if (cancelled) break;
            handlers.onEvent(i);
          }
          handlers.onComplete();
        })();
        return {
          cancel(): void {
            cancelled = true;
            cancelledSubs.push(req.id);
          },
        };
      },
    });
    const client = createTunnelClient({
      url,
      bearer,
      nodeName: 'node1',
      handleRequest: async () => ({}),
      handleSubscription,
      initialAttemptTimeoutMs: 2000,
      heartbeat: { intervalMs: 0 },
    });
    await client.start();
    stops.push(() => { client.stop(); });

    const got: unknown[] = [];
    const req = {
      id: 'sub-cancel-test',
      method: 'anything',
      params: { type: 'subscription' as const, input: null },
    };
    for await (const v of srv.sendSubscribe('node1', req)) {
      got.push(v);
      if (got.length === 2) break; // triggers iterator.return → stream-cancel
    }
    // Allow the cancel frame to land + the handler to tear down.
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelledSubs).toContain(req.id);
  });

  test('missing handleSubscription → stream-done with error frame', async () => {
    const bearer = 'b';
    const srv = createTunnelServer({ expectedBearerHash: hashToken(bearer) });
    const bun = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, server) {
        return srv.handleUpgrade(req, server) ??
          new Response('404', { status: 404 });
      },
      websocket: srv.websocket,
    });
    stops.push(() => { bun.stop(); });
    const port = bun.port ?? 0;
    const url = `ws://127.0.0.1:${port}/tunnel`;

    const client = createTunnelClient({
      url,
      bearer,
      nodeName: 'node1',
      handleRequest: async () => ({}),
      // handleSubscription omitted
      initialAttemptTimeoutMs: 2000,
      heartbeat: { intervalMs: 0 },
    });
    await client.start();
    stops.push(() => { client.stop(); });

    let caught: Error | null = null;
    try {
      for await (const _v of srv.sendSubscribe('node1', {
        id: 'x',
        method: 'foo',
        params: { type: 'subscription', input: null },
      })) {
        // no events
      }
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).message).toContain('subscription handler');
  });
});
