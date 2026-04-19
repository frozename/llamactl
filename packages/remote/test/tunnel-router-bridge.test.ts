import { describe, expect, test } from 'bun:test';
import { createTunnelRouterHandler } from '../src/tunnel/index.js';

/**
 * Unit tests for the agent-side bridge that maps tunnel `req`
 * frames onto a tRPC createCaller() proxy. The fake caller mimics
 * the dotted-path shape tRPC exposes (`caller.catalog.list(input)`)
 * so the bridge's traversal is exercised without booting the real
 * router.
 */

interface FakeCaller {
  catalog: {
    list: (input?: { classFilter?: string }) => Promise<Array<{ rel: string }>>;
    promote: (input: { rel: string }) => Promise<{ ok: true }>;
  };
  node: {
    facts: () => Promise<{ profile: string }>;
  };
  throws: () => Promise<never>;
}

function fakeCaller(): FakeCaller {
  return {
    catalog: {
      async list(input) {
        if (input?.classFilter === 'vision') return [{ rel: 'v1' }];
        return [{ rel: 'a' }, { rel: 'b' }];
      },
      async promote(input) {
        if (!input?.rel) throw new Error('rel required');
        return { ok: true };
      },
    },
    node: {
      async facts() {
        return { profile: 'macbook-pro-48g' };
      },
    },
    async throws() {
      throw new Error('intentional');
    },
  };
}

describe('createTunnelRouterHandler', () => {
  test('routes a dotted method path to the leaf caller + passes input', async () => {
    const handle = createTunnelRouterHandler(fakeCaller());
    const result = await handle({
      type: 'req',
      id: 'r1',
      method: 'catalog.list',
      params: { type: 'query', input: { classFilter: 'vision' } },
    });
    expect(result).toEqual([{ rel: 'v1' }]);
  });

  test('works with empty input when the procedure takes none', async () => {
    const handle = createTunnelRouterHandler(fakeCaller());
    const result = await handle({
      type: 'req',
      id: 'r2',
      method: 'node.facts',
      params: { type: 'query' },
    });
    expect(result).toEqual({ profile: 'macbook-pro-48g' });
  });

  test('forwards mutations the same way', async () => {
    const handle = createTunnelRouterHandler(fakeCaller());
    const result = await handle({
      type: 'req',
      id: 'r3',
      method: 'catalog.promote',
      params: { type: 'mutation', input: { rel: 'foo.gguf' } },
    });
    expect(result).toEqual({ ok: true });
  });

  test('unknown method → throws with a clear message (tunnel-client surfaces as error)', async () => {
    const handle = createTunnelRouterHandler(fakeCaller());
    await expect(
      handle({
        type: 'req',
        id: 'r4',
        method: 'catalog.nope',
        params: { type: 'query' },
      }),
    ).rejects.toThrow(/unknown procedure: catalog\.nope/);
  });

  test('unknown top-level namespace → throws', async () => {
    const handle = createTunnelRouterHandler(fakeCaller());
    await expect(
      handle({
        type: 'req',
        id: 'r5',
        method: 'bogus.foo',
        params: {},
      }),
    ).rejects.toThrow(/unknown procedure/);
  });

  test('procedure that throws bubbles up to the tunnel client unchanged', async () => {
    const handle = createTunnelRouterHandler(fakeCaller());
    await expect(
      handle({ type: 'req', id: 'r6', method: 'throws', params: {} }),
    ).rejects.toThrow('intentional');
  });
});
