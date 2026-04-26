import { describe, expect, test } from 'bun:test';
import {
  CompositeSpecSchema,
  type CompositeSpec,
} from '../src/composite/schema.js';
import {
  allEdges,
  impliedEdges,
  topologicalOrder,
} from '../src/composite/dag.js';

// Accept raw input shape (pre-defaults) and lean on Zod to fill in
// `.default()` fields. Tests stay terse without re-declaring
// required `extraArgs: []` / `providerConfig: {}` / etc. everywhere.
function spec(overrides: unknown): CompositeSpec {
  return CompositeSpecSchema.parse(overrides);
}

const baseInput = {
  ragNodes: [
    {
      name: 'kb-chroma',
      node: 'local',
      binding: {
        provider: 'chroma' as const,
        endpoint: 'http://localhost:8000',
        collection: 'docs',
      },
    },
  ],
  pipelines: [
    {
      name: 'docs-ingest',
      spec: {
        destination: { ragNode: 'kb-chroma', collection: 'docs' },
        sources: [{ kind: 'filesystem' as const, root: '/tmp/docs' }],
      },
    },
  ],
};

describe('composite DAG — pipeline edges', () => {
  test('infers edge from pipeline.destination.ragNode to inline ragNodes[]', () => {
    const edges = impliedEdges(spec(baseInput));
    const found = edges.some(
      (e) =>
        e.from.kind === 'pipeline' &&
        e.from.name === 'docs-ingest' &&
        e.to.kind === 'rag' &&
        e.to.name === 'kb-chroma',
    );
    expect(found).toBe(true);
  });

  test('topo order places pipeline after its rag node', () => {
    const order = topologicalOrder(spec(baseInput));
    const ragIdx = order.findIndex(
      (c) => c.kind === 'rag' && c.name === 'kb-chroma',
    );
    const pipeIdx = order.findIndex(
      (c) => c.kind === 'pipeline' && c.name === 'docs-ingest',
    );
    expect(ragIdx).toBeGreaterThanOrEqual(0);
    expect(pipeIdx).toBeGreaterThanOrEqual(0);
    expect(ragIdx).toBeLessThan(pipeIdx);
  });

  test('no edge when pipeline.destination.ragNode does not match any inline ragNode', () => {
    const s = spec({
      ragNodes: [
        {
          name: 'kb-chroma',
          node: 'local',
          binding: {
            provider: 'chroma' as const,
            endpoint: 'http://localhost:8000',
            collection: 'docs',
          },
        },
      ],
      pipelines: [
        {
          name: 'p',
          spec: {
            destination: { ragNode: 'external-kb', collection: 'd' },
            sources: [{ kind: 'filesystem' as const, root: '/x' }],
          },
        },
      ],
    });
    const edges = impliedEdges(s);
    const fromPipeline = edges.filter((e) => e.from.kind === 'pipeline');
    expect(fromPipeline.length).toBe(0);
  });

  test('explicit dependencies edges with pipeline kind merge with inferred ones', () => {
    const s = spec({
      services: [{ kind: 'chroma', name: 'preflight', node: 'local' }],
      ragNodes: baseInput.ragNodes,
      pipelines: baseInput.pipelines,
      dependencies: [
        {
          from: { kind: 'pipeline', name: 'docs-ingest' },
          to: { kind: 'service', name: 'preflight' },
        },
      ],
    });
    const edges = allEdges(s);
    const explicitFound = edges.some(
      (e) =>
        e.from.kind === 'pipeline' &&
        e.to.kind === 'service' &&
        e.to.name === 'preflight',
    );
    const implicitFound = edges.some(
      (e) =>
        e.from.kind === 'pipeline' &&
        e.to.kind === 'rag' &&
        e.to.name === 'kb-chroma',
    );
    expect(explicitFound).toBe(true);
    expect(implicitFound).toBe(true);
  });

  test('cycle detection picks up pipeline → service → pipeline cycle', () => {
    const s = spec({
      services: [{ kind: 'chroma', name: 'preflight', node: 'local' }],
      ragNodes: baseInput.ragNodes,
      pipelines: baseInput.pipelines,
      dependencies: [
        {
          from: { kind: 'pipeline', name: 'docs-ingest' },
          to: { kind: 'service', name: 'preflight' },
        },
        {
          from: { kind: 'service', name: 'preflight' },
          to: { kind: 'pipeline', name: 'docs-ingest' },
        },
      ],
    });
    expect(() => topologicalOrder(s)).toThrow(/cycle/i);
  });
});
