import { describe, expect, test } from 'bun:test';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { createTunnelSubscriptionHandler } from '../src/tunnel/router-bridge.js';
import type { TunnelReq } from '../src/tunnel/messages.js';

/**
 * B.2 coverage — `createTunnelSubscriptionHandler` must resolve
 * tRPC v11 subscription procedures directly against the router,
 * pump their AsyncIterable output into `{onEvent, onError,
 * onComplete}` handlers, and support early cancellation via
 * `cancel()`.
 */

const t = initTRPC.context<{ userId?: string }>().create();

function buildFixtureRouter() {
  return t.router({
    counter: t.procedure
      .input(z.object({ n: z.number().int().min(1) }))
      .subscription(async function* ({ input, signal }) {
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
      yield { first: true };
      throw new Error('boom');
    }),
    notFound: t.procedure.query(() => ({ ok: true })),
    contextEcho: t.procedure.subscription(async function* ({ ctx }) {
      yield { user: (ctx as { userId?: string }).userId ?? null };
    }),
  });
}

function makeReq(method: string, input: unknown): TunnelReq {
  return {
    type: 'req',
    id: `test-${Math.random().toString(36).slice(2)}`,
    method,
    params: { type: 'subscription', input },
  };
}

describe('createTunnelSubscriptionHandler', () => {
  test('emits three events then completes', async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}));
    const events: unknown[] = [];
    let complete = false;
    let error: Error | null = null;
    const sub = makeSub(makeReq('counter', { n: 3 })).subscribe({
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

  test('propagates ctx from createContext factory', async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({
      userId: 'alice',
    }));
    const events: unknown[] = [];
    makeSub(makeReq('contextEcho', undefined)).subscribe({
      onEvent: (d) => events.push(d),
      onError: () => {},
      onComplete: () => {},
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([{ user: 'alice' }]);
  });

  test('cancel() aborts the source iterable', async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}));
    const events: unknown[] = [];
    let done = false;
    const sub = makeSub(makeReq('slow', undefined)).subscribe({
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

  test('cancel() immediately after subscribe still tears down', async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}));
    const events: unknown[] = [];
    let done = false;
    const sub = makeSub(makeReq('slow', undefined)).subscribe({
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

  test('iterator-level throw surfaces as onError', async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}));
    const events: unknown[] = [];
    let error: Error | null = null;
    let complete = false;
    makeSub(makeReq('crashes', undefined)).subscribe({
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
    expect((error as unknown as Error).message).toContain('boom');
    expect(complete).toBe(false);
    expect(events).toEqual([{ first: true }]);
  });

  test('missing procedure → onError', async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}));
    let error: Error | null = null;
    makeSub(makeReq('missing.thing', undefined)).subscribe({
      onEvent: () => {},
      onError: (e) => {
        error = e;
      },
      onComplete: () => {},
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(error).not.toBeNull();
  });

  test('type-mismatch (query routed as subscription) → onError', async () => {
    const router = buildFixtureRouter();
    const makeSub = createTunnelSubscriptionHandler(router, () => ({}));
    let error: Error | null = null;
    makeSub(makeReq('notFound', undefined)).subscribe({
      onEvent: () => {},
      onError: (e) => {
        error = e;
      },
      onComplete: () => {},
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(error).not.toBeNull();
  });
});
