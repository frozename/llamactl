import { describe, expect, test } from 'bun:test';
import {
  fanOutSurface,
  listAgentNodes,
  type NodeFailure,
} from '../../../electron/trpc/cross-node-fan-out';
import type { Config, ClusterNode } from '@llamactl/remote';

const cfg: Config = {
  apiVersion: 'llamactl/v1' as const,
  kind: 'Config' as const,
  currentContext: 'default',
  contexts: [{ name: 'default', cluster: 'home', user: 'me', defaultNode: 'local' }],
  clusters: [
    {
      name: 'home',
      nodes: [
        { name: 'local', endpoint: 'https://127.0.0.1:7843' },
        { name: 'mac-mini', endpoint: 'https://192.168.68.76:7843' },
        { name: 'sirius-gw', endpoint: '', kind: 'gateway' as const },
        { name: 'kb-chroma', endpoint: '', kind: 'rag' as const },
      ] as ClusterNode[],
    },
  ],
  users: [{ name: 'me', token: 'abc' }],
};

describe('listAgentNodes', () => {
  test('excludes the active node and non-agent kinds', () => {
    const out = listAgentNodes(cfg, 'local');
    expect(out.map((n) => n.name)).toEqual(['mac-mini']);
  });

  test('treats nodes with no kind as agents (backwards compat)', () => {
    const out = listAgentNodes(cfg, 'mac-mini');
    expect(out.map((n) => n.name)).toEqual(['local']);
  });

  test('empty array when only the active node is an agent', () => {
    const oneAgent: Config = {
      ...cfg,
      clusters: [{
        name: 'home',
        nodes: [
          { name: 'local', endpoint: 'https://127.0.0.1:7843' },
          { name: 'sirius-gw', endpoint: '', kind: 'gateway' as const },
        ] as ClusterNode[],
      }],
    };
    expect(listAgentNodes(oneAgent, 'local')).toEqual([]);
  });
});

describe('fanOutSurface', () => {
  const nodes: ClusterNode[] = [
    { name: 'a', endpoint: 'https://a:7843' },
    { name: 'b', endpoint: 'https://b:7843' },
    { name: 'c', endpoint: 'https://c:7843' },
  ];

  test('all-succeed merges hits, no failures', async () => {
    const out = await fanOutSurface<{ id: string; node: string }>({
      nodes,
      perNodeFetch: async (node) => [{ id: node.name, node: node.name }],
      perNodeTimeoutMs: 100,
    });
    expect(out.failures).toEqual([]);
    expect(out.hits.map((h) => h.id).sort()).toEqual(['a', 'b', 'c']);
  });

  test('per-node timeout produces failure with reason=timeout', async () => {
    const out = await fanOutSurface<{ id: string }>({
      nodes,
      perNodeFetch: async (node, signal) => {
        if (node.name === 'b') {
          await new Promise((r) => setTimeout(r, 200));
          if (signal.aborted) throw new Error('aborted');
          return [];
        }
        return [{ id: node.name }];
      },
      perNodeTimeoutMs: 50,
    });
    expect(out.hits.map((h) => h.id).sort()).toEqual(['a', 'c']);
    expect(out.failures.length).toBe(1);
    expect(out.failures[0]!.nodeName).toBe('b');
    expect(out.failures[0]!.reason).toBe('timeout');
  });

  test('per-node rejection produces failure with reason=rejected', async () => {
    const out = await fanOutSurface<{ id: string }>({
      nodes,
      perNodeFetch: async (node) => {
        if (node.name === 'a') throw new Error('TLS handshake failed');
        return [{ id: node.name }];
      },
      perNodeTimeoutMs: 100,
    });
    expect(out.hits.map((h) => h.id).sort()).toEqual(['b', 'c']);
    const fail = out.failures.find((f) => f.nodeName === 'a')!;
    expect(fail.reason).toBe('rejected');
    expect(fail.detail).toContain('TLS handshake failed');
  });

  test('outer abort short-circuits in-flight fetches', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const out = await fanOutSurface<{ id: string }>({
      nodes,
      perNodeFetch: async (node, signal) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 1000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
        return [{ id: node.name }];
      },
      perNodeTimeoutMs: 5000,
      signal: ctrl.signal,
    });
    expect(out.hits).toEqual([]);
    expect(out.failures.length).toBe(3);
    for (const f of out.failures) {
      expect(['aborted', 'rejected']).toContain(f.reason);
    }
  });

  test('empty nodes array returns instant empty result', async () => {
    const out = await fanOutSurface<{ id: string }>({
      nodes: [],
      perNodeFetch: async () => {
        throw new Error('should not be called');
      },
      perNodeTimeoutMs: 100,
    });
    expect(out).toEqual({ hits: [], failures: [] });
  });

  test('failures shape carries detail strings', async () => {
    const out = await fanOutSurface<{ id: string }>({
      nodes: [{ name: 'x', endpoint: '' }],
      perNodeFetch: async () => {
        throw new Error('boom');
      },
      perNodeTimeoutMs: 100,
    });
    const f: NodeFailure | undefined = out.failures[0];
    expect(f).toBeDefined();
    expect(f!.detail).toBe('boom');
  });
});
