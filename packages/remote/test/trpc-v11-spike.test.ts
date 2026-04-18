import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { initTRPC, tracked, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
} from '@trpc/client';
import { EventSource } from 'eventsource';
import { z } from 'zod';

/**
 * Phase B.1 day-1 spike. Validates that the tRPC v11 migration target
 * works on Bun for all three operation types before we rewrite
 * production procedures.
 *
 * - Query + mutation over httpBatchLink
 * - Async-generator subscription over httpSubscriptionLink (SSE)
 * - Client abort → server-side opts.signal.aborted === true
 * - createCaller still works for in-process invocation
 */

interface SpikeContext {
  token: string | null;
}

function createSpikeRouter(probe: { seen: { signal: AbortSignal | null } }) {
  const t = initTRPC.context<SpikeContext>().create();

  const authedProcedure = t.procedure.use(({ ctx, next }) => {
    if (ctx.token !== 'good-token') {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'bad token' });
    }
    return next();
  });

  return t.router({
    ping: t.procedure.query(() => 'pong'),
    echo: t.procedure
      .input(z.string().min(1))
      .mutation(({ input }) => ({ echoed: input.toUpperCase() })),
    whoami: authedProcedure.query(({ ctx }) => ({ token: ctx.token })),
    counter: t.procedure
      .input(z.object({ count: z.number().int().positive() }))
      .subscription(async function* (opts) {
        probe.seen.signal = opts.signal ?? null;
        for (let i = 0; i < opts.input.count; i++) {
          if (opts.signal?.aborted) return;
          yield tracked(String(i), { i, at: Date.now() });
          await new Promise((r) => setTimeout(r, 5));
        }
      }),
    slow: t.procedure
      .subscription(async function* (opts) {
        probe.seen.signal = opts.signal ?? null;
        // Yield one quick event so client subscription resolves, then
        // idle forever (until client aborts).
        yield tracked('start', { t: 'ready' });
        for (let i = 0; ; i++) {
          if (opts.signal?.aborted) return;
          await new Promise((r) => setTimeout(r, 20));
        }
      }),
    // v10 legacy shape — deprecated in v11 but still compiles. The
    // production router currently uses this form for pullFile + 5
    // others; if this subscription delivers events over SSE to a v11
    // client, we can defer the async-generator rewrite.
    legacyObservable: t.procedure
      .input(z.object({ count: z.number().int().positive() }))
      .subscription(({ input }) => {
        return observable<{ i: number }>((emit) => {
          let cancelled = false;
          void (async () => {
            for (let i = 0; i < input.count; i++) {
              if (cancelled) return;
              emit.next({ i });
              await new Promise((r) => setTimeout(r, 5));
            }
            emit.complete();
          })();
          return () => { cancelled = true; };
        });
      }),
  });
}

type SpikeRouter = ReturnType<typeof createSpikeRouter>;

function startServer(router: SpikeRouter): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith('/trpc')) {
        return new Response('not found', { status: 404 });
      }
      const authHeader = req.headers.get('authorization');
      const token = authHeader?.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length)
        : null;
      return fetchRequestHandler({
        req,
        endpoint: '/trpc',
        router,
        createContext: (): SpikeContext => ({ token }),
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/trpc`,
    stop: () => server.stop(true),
  };
}

describe('tRPC v11 + Bun.serve + fetchRequestHandler', () => {
  const probe = { seen: { signal: null as AbortSignal | null } };
  const router = createSpikeRouter(probe);
  let svr: ReturnType<typeof startServer>;

  beforeAll(() => { svr = startServer(router); });
  afterAll(() => { svr.stop(); });

  test('query round-trips with createTRPCClient (v11 rename)', async () => {
    const client = createTRPCClient<SpikeRouter>({
      links: [httpBatchLink({ url: svr.url })],
    });
    expect(await client.ping.query()).toBe('pong');
  });

  test('mutation + input validation round-trip', async () => {
    const client = createTRPCClient<SpikeRouter>({
      links: [httpBatchLink({ url: svr.url })],
    });
    expect(await client.echo.mutate('hello')).toEqual({ echoed: 'HELLO' });
  });

  test('authed procedure propagates bearer via createContext', async () => {
    const client = createTRPCClient<SpikeRouter>({
      links: [
        httpBatchLink({
          url: svr.url,
          headers: { authorization: 'Bearer good-token' },
        }),
      ],
    });
    expect(await client.whoami.query()).toEqual({ token: 'good-token' });
  });

  test('async-generator subscription over SSE delivers N events', async () => {
    const client = createTRPCClient<SpikeRouter>({
      links: [
        splitLink({
          condition: (op) => op.type === 'subscription',
          true: httpSubscriptionLink({ url: svr.url, EventSource }),
          false: httpBatchLink({ url: svr.url }),
        }),
      ],
    });
    const received: Array<{ i: number }> = [];
    await new Promise<void>((resolve, reject) => {
      const sub = client.counter.subscribe(
        { count: 5 },
        {
          onData: (evt: { data: { i: number; at: number } }) => {
            received.push({ i: evt.data.i });
            if (received.length >= 5) {
              sub.unsubscribe();
              resolve();
            }
          },
          onError: reject,
        },
      );
      setTimeout(() => reject(new Error('subscription timeout')), 2000);
    });
    expect(received.map((r) => r.i)).toEqual([0, 1, 2, 3, 4]);
  });

  test('client unsubscribe aborts server-side opts.signal', async () => {
    const client = createTRPCClient<SpikeRouter>({
      links: [
        splitLink({
          condition: (op) => op.type === 'subscription',
          true: httpSubscriptionLink({ url: svr.url, EventSource }),
          false: httpBatchLink({ url: svr.url }),
        }),
      ],
    });
    probe.seen.signal = null;
    const sub = client.slow.subscribe(undefined, {
      onData: () => {},
      onError: () => {},
    });
    // Wait long enough for the server to attach its signal.
    await new Promise((r) => setTimeout(r, 100));
    expect(probe.seen.signal).not.toBeNull();
    expect(probe.seen.signal!.aborted).toBe(false);
    sub.unsubscribe();
    // Give the SSE close + server-side signal a few event-loop ticks to fire.
    const capturedSignal = probe.seen.signal as AbortSignal | null;
    if (capturedSignal === null) throw new Error('server never attached signal');
    for (let i = 0; i < 50; i++) {
      if (capturedSignal.aborted) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(capturedSignal.aborted).toBe(true);
  });

  test('createCaller runs procedures in-process without HTTP', async () => {
    const caller = router.createCaller({ token: 'good-token' });
    expect(await caller.ping()).toBe('pong');
    expect(await caller.whoami()).toEqual({ token: 'good-token' });
    expect(await caller.echo('in-proc')).toEqual({ echoed: 'IN-PROC' });
  });

  test('v10 observable subscription is consumable over v11 SSE link', async () => {
    const client = createTRPCClient<SpikeRouter>({
      links: [
        splitLink({
          condition: (op) => op.type === 'subscription',
          true: httpSubscriptionLink({ url: svr.url, EventSource }),
          false: httpBatchLink({ url: svr.url }),
        }),
      ],
    });
    const received: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const sub = client.legacyObservable.subscribe(
        { count: 4 },
        {
          onData: (evt: { i: number } | { data: { i: number } }) => {
            const i = 'i' in evt ? evt.i : evt.data.i;
            received.push(i);
            if (received.length >= 4) {
              sub.unsubscribe();
              resolve();
            }
          },
          onError: reject,
        },
      );
      setTimeout(() => reject(new Error('legacy subscription timeout')), 2000);
    });
    expect(received).toEqual([0, 1, 2, 3]);
  });
});
