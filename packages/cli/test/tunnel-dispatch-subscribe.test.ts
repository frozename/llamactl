import { afterEach, describe, expect, test } from 'bun:test';
import { tunnel, auth } from '@llamactl/remote';
import { handleTunnelRelay } from '../../remote/src/server/tunnel-relay.js';
import {
  __resetInsecureTunnelWarning,
  buildTunnelSubscribe,
} from '../src/tunnel-dispatch.js';

const { createTunnelClient, createTunnelServer } = tunnel;
const { hashToken } = auth;
type TunnelReq = tunnel.TunnelReq;
type TunnelSubscription = tunnel.TunnelSubscription;

/**
 * B.5 coverage — end-to-end subscription over the reverse-tunnel
 * SSE relay. Builds a central agent + dialing client, invokes
 * `buildTunnelSubscribe(...)(method, input, handlers)`, asserts
 * each event streams through `onData` and the terminal `onComplete`
 * fires. Also covers `unsubscribe()` + fail-closed pinning.
 */

interface Harness {
  stop: () => Promise<void>;
  bunPort: number;
  bearer: string;
  receivedCancel: string[];
}

async function startHarness(script: {
  events: unknown[];
  delayMs?: number;
  throwErr?: Error;
}): Promise<Harness> {
  __resetInsecureTunnelWarning();
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
    receivedCancel,
    async stop() {
      client.stop();
      bun.stop();
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}

describe('buildTunnelSubscribe end-to-end', () => {
  let harness: Harness;
  afterEach(async () => {
    if (harness) await harness.stop();
  });

  test('streams events + onComplete', async () => {
    harness = await startHarness({
      events: [{ i: 0 }, { i: 1 }, { i: 2 }],
    });
    const sub = buildTunnelSubscribe({
      centralUrl: `http://127.0.0.1:${harness.bunPort}`,
      bearer: harness.bearer,
      nodeName: 'node1',
      insecure: true,
    });
    const events: unknown[] = [];
    let completed = false;
    let started = false;
    let error: unknown = null;
    const handle = sub('tick', null, {
      onStarted: () => { started = true; },
      onData: (e) => events.push(e),
      onComplete: () => { completed = true; },
      onError: (err) => { error = err; },
    });
    await new Promise((r) => setTimeout(r, 200));
    handle.unsubscribe();
    expect(error).toBeNull();
    expect(completed).toBe(true);
    expect(started).toBe(true);
    expect(events).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
  });

  test('agent-side error propagates to onError', async () => {
    harness = await startHarness({
      events: [{ only: 1 }],
      throwErr: Object.assign(new Error('agent-failure'), { code: 'E42' }),
    });
    const sub = buildTunnelSubscribe({
      centralUrl: `http://127.0.0.1:${harness.bunPort}`,
      bearer: harness.bearer,
      nodeName: 'node1',
      insecure: true,
    });
    let error: Error | null = null;
    let completed = false;
    const events: unknown[] = [];
    sub('boom', null, {
      onData: (e) => events.push(e),
      onError: (err) => { error = err as Error; },
      onComplete: () => { completed = true; },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toEqual([{ only: 1 }]);
    expect(completed).toBe(false);
    expect(error).not.toBeNull();
    expect((error as unknown as Error).message).toBe('agent-failure');
  });

  test('unsubscribe() aborts mid-stream + agent sees stream-cancel', async () => {
    harness = await startHarness({
      events: Array.from({ length: 40 }, (_, i) => ({ i })),
      delayMs: 15,
    });
    const sub = buildTunnelSubscribe({
      centralUrl: `http://127.0.0.1:${harness.bunPort}`,
      bearer: harness.bearer,
      nodeName: 'node1',
      insecure: true,
    });
    const events: unknown[] = [];
    const handle = sub('long', null, {
      onData: (e) => events.push(e),
      onError: () => {},
      onComplete: () => {},
    });
    // Let a couple of events land.
    await new Promise((r) => setTimeout(r, 50));
    handle.unsubscribe();
    await new Promise((r) => setTimeout(r, 150));
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(40);
    expect(harness.receivedCancel.length).toBeGreaterThan(0);
  });

  test('pinning fail-closed without fingerprint + not insecure', async () => {
    harness = await startHarness({ events: [] });
    const sub = buildTunnelSubscribe({
      centralUrl: `http://127.0.0.1:${harness.bunPort}`,
      bearer: harness.bearer,
      nodeName: 'node1',
      // insecure: false (default)
    });
    let error: Error | null = null;
    sub('tick', null, {
      onData: () => {},
      onError: (err) => { error = err as Error; },
      onComplete: () => {},
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(error).not.toBeNull();
    expect((error as unknown as Error).message).toContain(
      'tunnelCentralFingerprint',
    );
  });

  test('unsubscribe() before any events is a clean no-op', async () => {
    harness = await startHarness({
      events: Array.from({ length: 10 }, (_, i) => ({ i })),
      delayMs: 20,
    });
    const sub = buildTunnelSubscribe({
      centralUrl: `http://127.0.0.1:${harness.bunPort}`,
      bearer: harness.bearer,
      nodeName: 'node1',
      insecure: true,
    });
    const handle = sub('tick', null, {
      onData: () => {},
      onError: () => {},
      onComplete: () => {},
    });
    handle.unsubscribe();
    // Second unsubscribe is idempotent.
    handle.unsubscribe();
    await new Promise((r) => setTimeout(r, 50));
    // No assertions here; the unsubscribe must not throw.
    expect(true).toBe(true);
  });
});
