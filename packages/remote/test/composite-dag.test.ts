import { describe, expect, test } from 'bun:test';
import {
  CompositeSpecSchema,
  type CompositeSpec,
  type ComponentRef,
} from '../src/composite/schema.js';
import {
  allEdges,
  impliedEdges,
  listComponents,
  reverseOrder,
  topologicalOrder,
} from '../src/composite/dag.js';

// Accept raw input shape (pre-defaults) and lean on Zod to fill in
// `.default()` fields. Tests stay terse without re-declaring
// required `extraArgs: []` / `providerConfig: {}` / etc. everywhere.
function spec(overrides: unknown): CompositeSpec {
  return CompositeSpecSchema.parse(overrides);
}

function refs(list: ComponentRef[]): string[] {
  return list.map((r) => `${r.kind}/${r.name}`);
}

describe('listComponents', () => {
  test('empty composite returns empty', () => {
    expect(listComponents(spec({}))).toEqual([]);
  });

  test('enumerates every kind in declaration order', () => {
    const s = spec({
      services: [
        { kind: 'chroma', name: 'kb', node: 'local' },
        { kind: 'pgvector', name: 'pg', node: 'local' },
      ],
      workloads: [
        { node: 'alpha', target: { kind: 'rel', value: 'm.gguf' } },
      ],
      ragNodes: [
        {
          name: 'kb-node',
          node: 'local',
          binding: { provider: 'chroma', endpoint: 'http://a' },
        },
      ],
      gateways: [{ name: 'gw', node: 'local', provider: 'sirius' }],
    });
    expect(refs(listComponents(s))).toEqual([
      'service/kb',
      'service/pg',
      'workload/alpha',
      'rag/kb-node',
      'gateway/gw',
    ]);
  });
});

describe('impliedEdges', () => {
  test('rag → service when backingService set', () => {
    const s = spec({
      services: [{ kind: 'chroma', name: 'kb', node: 'local' }],
      ragNodes: [
        {
          name: 'kb-node',
          node: 'local',
          binding: { provider: 'chroma', endpoint: 'http://a' },
          backingService: 'kb',
        },
      ],
    });
    const edges = impliedEdges(s);
    expect(edges).toEqual([
      {
        from: { kind: 'rag', name: 'kb-node' },
        to: { kind: 'service', name: 'kb' },
      },
    ]);
  });

  test('gateway → workload for each upstream workload', () => {
    const s = spec({
      workloads: [
        { node: 'a', target: { kind: 'rel', value: 'm.gguf' } },
        { node: 'b', target: { kind: 'rel', value: 'm.gguf' } },
      ],
      gateways: [
        {
          name: 'gw',
          node: 'local',
          provider: 'sirius',
          upstreamWorkloads: ['a', 'b'],
        },
      ],
    });
    const edges = impliedEdges(s);
    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual({
      from: { kind: 'gateway', name: 'gw' },
      to: { kind: 'workload', name: 'a' },
    });
    expect(edges[1]).toEqual({
      from: { kind: 'gateway', name: 'gw' },
      to: { kind: 'workload', name: 'b' },
    });
  });

  test('no implied edges when no backing hints', () => {
    const s = spec({
      services: [{ kind: 'chroma', name: 'kb', node: 'local' }],
      ragNodes: [
        {
          name: 'kb-node',
          node: 'local',
          binding: { provider: 'chroma', endpoint: 'http://external' },
        },
      ],
    });
    expect(impliedEdges(s)).toEqual([]);
  });
});

describe('allEdges', () => {
  test('dedupes explicit + implied edges', () => {
    const s = spec({
      services: [{ kind: 'chroma', name: 'kb', node: 'local' }],
      ragNodes: [
        {
          name: 'kb-node',
          node: 'local',
          binding: { provider: 'chroma', endpoint: 'http://a' },
          backingService: 'kb',
        },
      ],
      dependencies: [
        {
          from: { kind: 'rag', name: 'kb-node' },
          to: { kind: 'service', name: 'kb' },
        },
      ],
    });
    const edges = allEdges(s);
    expect(edges).toHaveLength(1);
  });
});

describe('topologicalOrder', () => {
  test('empty composite → empty order', () => {
    expect(topologicalOrder(spec({}))).toEqual([]);
  });

  test('service → rag → workload → gateway pipeline', () => {
    const s = spec({
      services: [{ kind: 'chroma', name: 'kb', node: 'local' }],
      workloads: [
        { node: 'alpha', target: { kind: 'rel', value: 'm.gguf' } },
      ],
      ragNodes: [
        {
          name: 'kb-node',
          node: 'local',
          binding: { provider: 'chroma', endpoint: 'http://a' },
          backingService: 'kb',
        },
      ],
      gateways: [
        {
          name: 'gw',
          node: 'local',
          provider: 'sirius',
          upstreamWorkloads: ['alpha'],
        },
      ],
    });
    const order = refs(topologicalOrder(s));
    const idx = (k: string) => order.indexOf(k);
    expect(idx('service/kb')).toBeLessThan(idx('rag/kb-node'));
    expect(idx('workload/alpha')).toBeLessThan(idx('gateway/gw'));
    expect(order.length).toBe(4);
  });

  test('stable ordering within ties preserves declaration order', () => {
    // Two independent services — no deps. Expect declaration order.
    const s = spec({
      services: [
        { kind: 'chroma', name: 'kb', node: 'local' },
        { kind: 'pgvector', name: 'pg', node: 'local' },
      ],
    });
    const order = refs(topologicalOrder(s));
    expect(order).toEqual(['service/kb', 'service/pg']);
  });

  test('cycle detection throws with named nodes', () => {
    const s = spec({
      services: [
        { kind: 'chroma', name: 'kb', node: 'local' },
        { kind: 'pgvector', name: 'pg', node: 'local' },
      ],
      dependencies: [
        {
          from: { kind: 'service', name: 'kb' },
          to: { kind: 'service', name: 'pg' },
        },
        {
          from: { kind: 'service', name: 'pg' },
          to: { kind: 'service', name: 'kb' },
        },
      ],
    });
    expect(() => topologicalOrder(s)).toThrow(/cycle detected among/);
    expect(() => topologicalOrder(s)).toThrow(/service\/kb/);
    expect(() => topologicalOrder(s)).toThrow(/service\/pg/);
  });

  test('self-loop detected as cycle', () => {
    const s = spec({
      services: [{ kind: 'chroma', name: 'kb', node: 'local' }],
      dependencies: [
        {
          from: { kind: 'service', name: 'kb' },
          to: { kind: 'service', name: 'kb' },
        },
      ],
    });
    expect(() => topologicalOrder(s)).toThrow(/cycle detected/);
  });

  test('explicit dependency overrides declaration order', () => {
    // gateway declared before workload, but depends on it → workload emits first.
    const s = spec({
      workloads: [
        { node: 'alpha', target: { kind: 'rel', value: 'm.gguf' } },
      ],
      gateways: [
        {
          name: 'gw',
          node: 'local',
          provider: 'sirius',
        },
      ],
      dependencies: [
        {
          from: { kind: 'gateway', name: 'gw' },
          to: { kind: 'workload', name: 'alpha' },
        },
      ],
    });
    const order = refs(topologicalOrder(s));
    const idx = (k: string) => order.indexOf(k);
    expect(idx('workload/alpha')).toBeLessThan(idx('gateway/gw'));
  });
});

describe('reverseOrder', () => {
  test('reverses a sorted array without mutating input', () => {
    const input: ComponentRef[] = [
      { kind: 'service', name: 'kb' },
      { kind: 'rag', name: 'kb-node' },
      { kind: 'gateway', name: 'gw' },
    ];
    const out = reverseOrder(input);
    expect(refs(out)).toEqual([
      'gateway/gw',
      'rag/kb-node',
      'service/kb',
    ]);
    // input should remain unchanged.
    expect(refs(input)).toEqual([
      'service/kb',
      'rag/kb-node',
      'gateway/gw',
    ]);
  });

  test('empty array → empty', () => {
    expect(reverseOrder([])).toEqual([]);
  });
});
