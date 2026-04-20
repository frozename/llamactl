import { describe, expect, test } from 'bun:test';
import { createNodeClient, type TunnelSendFn } from '../src/client/node-client.js';
import type { Config } from '../src/config/schema.js';

/**
 * I.3.3 — createNodeClient routes through a tunnel when the target
 * node carries `tunnelPreferred: true` AND the caller supplies a
 * `tunnelSend` callable. This file exercises the client-side
 * proxy with a mock send fn; the tunnel-router-bridge tests cover
 * the agent-side handler.
 */

function baseConfig(overrides: Partial<Config['clusters'][number]['nodes'][number]> = {}): Config {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'Config',
    currentContext: 'default',
    contexts: [
      { name: 'default', cluster: 'home', user: 'me', defaultNode: 'gpu1' },
    ],
    clusters: [
      {
        name: 'home',
        nodes: [
          {
            name: 'gpu1',
            endpoint: 'https://gpu1.lan:7843',
            kind: 'agent',
            certificateFingerprint: 'sha256:aaaaaaaa',
            tunnelPreferred: true,
            ...overrides,
          },
        ],
      },
    ],
    users: [{ name: 'me', token: 'test-token' }],
  };
}

describe('proxyFromTunnel — via createNodeClient', () => {
  test('query routes through the tunnel and resolves with result', async () => {
    const sent: Array<{ id: string; method: string; params: unknown }> = [];
    const send: TunnelSendFn = async (req) => {
      sent.push(req);
      if (req.method === 'catalog.list') {
        return { id: req.id, result: [{ rel: 'a' }, { rel: 'b' }] };
      }
      return { id: req.id, error: { code: 'unknown', message: 'not wired' } };
    };
    const client = createNodeClient(baseConfig(), {
      nodeName: 'gpu1',
      tunnelSend: send,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catalog = (client as any).catalog;
    const result = await catalog.list.query({ classFilter: 'all' });
    expect(result).toEqual([{ rel: 'a' }, { rel: 'b' }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('catalog.list');
    expect(sent[0]!.params).toEqual({
      type: 'query',
      input: { classFilter: 'all' },
    });
  });

  test('mutation uses type:mutation on the tunnel frame', async () => {
    const sent: Array<{ method: string; params: unknown }> = [];
    const send: TunnelSendFn = async (req) => {
      sent.push({ method: req.method, params: req.params });
      return { id: req.id, result: { ok: true } };
    };
    const client = createNodeClient(baseConfig(), {
      nodeName: 'gpu1',
      tunnelSend: send,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (client as any).catalog.promote.mutate({ rel: 'foo.gguf' });
    expect(result).toEqual({ ok: true });
    expect(sent[0]!.params).toEqual({
      type: 'mutation',
      input: { rel: 'foo.gguf' },
    });
  });

  test('error frame surfaces as a thrown Error with .code', async () => {
    const send: TunnelSendFn = async (req) => ({
      id: req.id,
      error: { code: 'handler-threw', message: 'simulated failure' },
    });
    const client = createNodeClient(baseConfig(), {
      nodeName: 'gpu1',
      tunnelSend: send,
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).anything.query(null);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).toBe('simulated failure');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((err as any).code).toBe('handler-threw');
    }
  });

  test('deep dotted paths are respected (nested.namespace.method)', async () => {
    const sent: string[] = [];
    const send: TunnelSendFn = async (req) => {
      sent.push(req.method);
      return { id: req.id, result: null };
    };
    const client = createNodeClient(baseConfig(), {
      nodeName: 'gpu1',
      tunnelSend: send,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).deeply.nested.procedure.query({ x: 1 });
    expect(sent).toEqual(['deeply.nested.procedure']);
  });

  test('subscribe throws when tunnelSubscribe dispatcher is absent', async () => {
    const send: TunnelSendFn = async () => ({ id: 'x' });
    const client = createNodeClient(baseConfig(), {
      nodeName: 'gpu1',
      tunnelSend: send,
    });
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).pullFile.subscribe(
        { repo: 'r', file: 'f' },
        { onData: () => {}, onError: () => {}, onComplete: () => {} },
      );
    }).toThrow(/requires a tunnelSubscribe dispatcher/);
  });

  test('subscribe forwards to tunnelSubscribe when wired (Slice B)', async () => {
    const send: TunnelSendFn = async () => ({ id: 'x' });
    const calls: Array<{ method: string; input: unknown }> = [];
    const tunnelSubscribe = (
      method: string,
      input: unknown,
      _handlers: {
        onData: (e: unknown) => void;
        onError: (err: unknown) => void;
        onComplete: () => void;
      },
    ): { unsubscribe: () => void } => {
      calls.push({ method, input });
      return { unsubscribe() { /* no-op */ } };
    };
    const client = createNodeClient(baseConfig(), {
      nodeName: 'gpu1',
      tunnelSend: send,
      tunnelSubscribe,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = (client as any).pullFile.subscribe(
      { repo: 'a', file: 'b' },
      { onData: () => {}, onError: () => {}, onComplete: () => {} },
    );
    expect(calls).toEqual([{ method: 'pullFile', input: { repo: 'a', file: 'b' } }]);
    expect(typeof handle.unsubscribe).toBe('function');
  });

  test('tunnelPreferred=false → tunnel bypassed even if send is provided', async () => {
    let calls = 0;
    const send: TunnelSendFn = async (req) => {
      calls++;
      return { id: req.id, result: null };
    };
    const cfg = baseConfig({ tunnelPreferred: false });
    // Build the client — since the node has a real https endpoint,
    // createNodeClient picks the proxyFromHttp path. We don't actually
    // fire a request (no upstream to hit), just confirm send never
    // got invoked during creation.
    const client = createNodeClient(cfg, { nodeName: 'gpu1', tunnelSend: send });
    expect(client).toBeDefined();
    expect(calls).toBe(0);
  });

  test('tunnelPreferred=true but tunnelSend omitted → falls through to HTTP proxy', async () => {
    const cfg = baseConfig({ tunnelPreferred: true });
    const client = createNodeClient(cfg, { nodeName: 'gpu1' });
    expect(client).toBeDefined();
    // HTTP proxy shape — no error on construction; actual call would
    // try to hit gpu1.lan:7843 which we don't assert here.
  });
});
