import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { initTRPC, TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from '@trpc/client';
import { z } from 'zod';

/**
 * Phase A.2 spike (Risk #1 mitigation). Validates that the Phase A
 * transport — Bun.serve + fetchRequestHandler + httpBatchLink — survives
 * a realistic round-trip including auth, error propagation, and client
 * abort. Subscriptions (WebSocket in v10, SSE in v11) are Phase B's own
 * spike; this file deliberately does not exercise them.
 */

interface SpikeContext {
  token: string | null;
  aborted: { flag: boolean };
}

function createSpikeRouter() {
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
    slow: authedProcedure
      .input(z.object({ ms: z.number() }))
      .query(async ({ input, ctx }) => {
        // Simulates a long-running server-side op. Resolves 'ok' unless
        // the incoming request aborts first, in which case we want to
        // observe that (the fetch adapter wires request.signal into
        // createContext's signal).
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(null), input.ms);
          const abortCb = () => {
            ctx.aborted.flag = true;
            clearTimeout(timer);
            reject(new Error('aborted'));
          };
          // createContext hands us a live AbortSignal via ctx.aborted;
          // the caller sets ctx.aborted.flag when signal fires.
          if (ctx.aborted.flag) abortCb();
        });
        return 'ok';
      }),
  });
}

type SpikeRouter = ReturnType<typeof createSpikeRouter>;

interface SpikeServer {
  url: string;
  lastAbort: { flag: boolean };
  stop: () => Promise<void>;
}

function startSpikeServer(router: SpikeRouter): SpikeServer {
  const lastAbort = { flag: false };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith('/trpc')) {
        return new Response('not found', { status: 404 });
      }
      const authHeader = req.headers.get('authorization');
      const token = authHeader?.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length)
        : null;

      // Reset per-request abort tracker and hand it to the router so
      // tests can observe that the server-side work saw the signal.
      lastAbort.flag = false;
      req.signal.addEventListener('abort', () => {
        lastAbort.flag = true;
      });

      return fetchRequestHandler({
        req,
        endpoint: '/trpc',
        router,
        createContext: (): SpikeContext => ({ token, aborted: lastAbort }),
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/trpc`,
    lastAbort,
    stop: async () => {
      server.stop(true);
    },
  };
}

describe('tRPC + Bun.serve + fetchRequestHandler (Phase A.2 spike)', () => {
  const router = createSpikeRouter();
  let svr: SpikeServer;

  beforeAll(() => {
    svr = startSpikeServer(router);
  });
  afterAll(async () => {
    await svr.stop();
  });

  test('query round-trips', async () => {
    const client = createTRPCProxyClient<SpikeRouter>({
      links: [httpBatchLink({ url: svr.url })],
    });
    expect(await client.ping.query()).toBe('pong');
  });

  test('mutation round-trips with input validation', async () => {
    const client = createTRPCProxyClient<SpikeRouter>({
      links: [httpBatchLink({ url: svr.url })],
    });
    const result = await client.echo.mutate('hello');
    expect(result).toEqual({ echoed: 'HELLO' });
  });

  test('bearer auth: valid token → authed procedure returns ctx', async () => {
    const client = createTRPCProxyClient<SpikeRouter>({
      links: [
        httpBatchLink({
          url: svr.url,
          headers: { authorization: 'Bearer good-token' },
        }),
      ],
    });
    expect(await client.whoami.query()).toEqual({ token: 'good-token' });
  });

  test('bearer auth: missing token → UNAUTHORIZED', async () => {
    const client = createTRPCProxyClient<SpikeRouter>({
      links: [httpBatchLink({ url: svr.url })],
    });
    await expect(client.whoami.query()).rejects.toBeInstanceOf(TRPCClientError);
    try {
      await client.whoami.query();
    } catch (err) {
      expect((err as TRPCClientError<SpikeRouter>).data?.code).toBe('UNAUTHORIZED');
    }
  });

  test('client abort propagates to server', async () => {
    const client = createTRPCProxyClient<SpikeRouter>({
      links: [
        httpBatchLink({
          url: svr.url,
          headers: { authorization: 'Bearer good-token' },
        }),
      ],
    });
    const ac = new AbortController();
    svr.lastAbort.flag = false;
    const pending = client.slow.query({ ms: 5000 }, { signal: ac.signal });
    // Give the server a tick to register then abort.
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(pending).rejects.toThrow();
    // Give the server's abort listener a tick to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(svr.lastAbort.flag).toBe(true);
  });
});
