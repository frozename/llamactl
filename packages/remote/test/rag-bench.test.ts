import { describe, expect, test } from 'bun:test';

import {
  RagBenchManifestSchema,
  runRagBench,
  type RagBenchManifest,
  type RagSearchCaller,
} from '../src/rag/bench.js';

function manifest(queries: RagBenchManifest['spec']['queries']): RagBenchManifest {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'RagBench',
    metadata: { name: 'test' },
    spec: {
      node: 'kb-pg',
      collection: 'docs',
      topK: 10,
      queries,
    },
  };
}

function stubSearch(
  byQuery: Record<
    string,
    Array<{ id: string; content: string; score?: number }>
  >,
): RagSearchCaller {
  return async (req) => {
    const rows = byQuery[req.query] ?? [];
    return {
      collection: req.collection ?? 'docs',
      results: rows.slice(0, req.topK).map((d, i) => ({
        document: { id: d.id, content: d.content },
        score: d.score ?? 1 - i * 0.1,
      })),
    };
  };
}

describe('RagBenchManifestSchema', () => {
  test('accepts a minimal valid manifest', () => {
    const m = RagBenchManifestSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'RagBench',
      metadata: { name: 'docs-quality' },
      spec: {
        node: 'kb-pg',
        queries: [{ query: 'hi', expected_doc_id: 'x' }],
      },
    });
    expect(m.spec.topK).toBe(10);
  });
  test('rejects a query with neither expected_doc_id nor expected_substring', () => {
    expect(() =>
      RagBenchManifestSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'RagBench',
        metadata: { name: 'x' },
        spec: {
          node: 'kb-pg',
          queries: [{ query: 'hi' }],
        },
      }),
    ).toThrow();
  });
  test('rejects empty queries array', () => {
    expect(() =>
      RagBenchManifestSchema.parse({
        apiVersion: 'llamactl/v1',
        kind: 'RagBench',
        metadata: { name: 'x' },
        spec: { node: 'kb-pg', queries: [] },
      }),
    ).toThrow();
  });
});

describe('runRagBench', () => {
  test('scores hit by expected_doc_id at rank 1 → MRR 1.0', async () => {
    const report = await runRagBench({
      manifest: manifest([{ query: 'q1', expected_doc_id: 'docs/a.md' }]),
      search: stubSearch({
        q1: [
          { id: 'docs/a.md', content: 'hit' },
          { id: 'docs/b.md', content: 'no' },
        ],
      }),
      now: () => 0,
    });
    expect(report.hits).toBe(1);
    expect(report.hitRate).toBe(1);
    expect(report.mrr).toBe(1);
    expect(report.perQuery[0]!.hitRank).toBe(1);
    expect(report.perQuery[0]!.hitKind).toBe('doc_id');
  });

  test('scores substring hit at rank 3 → MRR 1/3', async () => {
    const report = await runRagBench({
      manifest: manifest([
        { query: 'q1', expected_substring: 'GOLDEN_PHRASE' },
      ]),
      search: stubSearch({
        q1: [
          { id: 'a', content: 'nope' },
          { id: 'b', content: 'nope again' },
          { id: 'c', content: 'finally GOLDEN_PHRASE here' },
        ],
      }),
      now: () => 0,
    });
    expect(report.mrr).toBeCloseTo(1 / 3, 6);
    expect(report.perQuery[0]!.hitRank).toBe(3);
    expect(report.perQuery[0]!.hitKind).toBe('substring');
    expect(report.perQuery[0]!.matchedDocId).toBe('c');
  });

  test('expected_doc_id beats expected_substring at the same rank', async () => {
    const report = await runRagBench({
      manifest: manifest([
        {
          query: 'q1',
          expected_doc_id: 'docs/a.md',
          expected_substring: 'matches too',
        },
      ]),
      search: stubSearch({
        q1: [
          { id: 'docs/a.md', content: 'matches too — both signals' },
        ],
      }),
      now: () => 0,
    });
    expect(report.perQuery[0]!.hitKind).toBe('doc_id');
  });

  test('no hit across all top-k → MRR contribution 0', async () => {
    const report = await runRagBench({
      manifest: manifest([
        { query: 'q1', expected_doc_id: 'missing.md' },
      ]),
      search: stubSearch({
        q1: [
          { id: 'a.md', content: '...' },
          { id: 'b.md', content: '...' },
        ],
      }),
      now: () => 0,
    });
    expect(report.hits).toBe(0);
    expect(report.hitRate).toBe(0);
    expect(report.mrr).toBe(0);
    expect(report.perQuery[0]!.hitRank).toBeNull();
  });

  test('mixed hit/miss — MRR averages reciprocals', async () => {
    const report = await runRagBench({
      manifest: manifest([
        { query: 'q1', expected_doc_id: 'a' }, // hit rank 1 → 1.0
        { query: 'q2', expected_doc_id: 'b' }, // hit rank 2 → 0.5
        { query: 'q3', expected_doc_id: 'missing' }, // miss → 0
      ]),
      search: stubSearch({
        q1: [{ id: 'a', content: '.' }],
        q2: [
          { id: 'x', content: '.' },
          { id: 'b', content: '.' },
        ],
        q3: [{ id: 'x', content: '.' }],
      }),
      now: () => 0,
    });
    expect(report.hits).toBe(2);
    expect(report.hitRate).toBeCloseTo(2 / 3, 6);
    expect(report.mrr).toBeCloseTo((1 + 0.5 + 0) / 3, 6);
  });

  test('search errors are counted, scored queries still aggregate', async () => {
    const report = await runRagBench({
      manifest: manifest([
        { query: 'good', expected_doc_id: 'x' },
        { query: 'bad', expected_doc_id: 'x' },
      ]),
      search: async (req) => {
        if (req.query === 'bad') throw new Error('ECONNREFUSED');
        return {
          collection: 'docs',
          results: [{ document: { id: 'x', content: '.' }, score: 1 }],
        };
      },
      now: () => 0,
    });
    expect(report.errors).toBe(1);
    expect(report.hits).toBe(1);
    expect(report.perQuery[1]!.error).toContain('ECONNREFUSED');
    // hitRate averages only over scored queries (1 good / 1 scored = 1).
    expect(report.hitRate).toBe(1);
  });

  test('per-query topK override wins over spec.topK', async () => {
    let sawTopK = 0;
    const report = await runRagBench({
      manifest: {
        ...manifest([
          { query: 'q', expected_doc_id: 'x', topK: 3 },
        ]),
        spec: {
          node: 'kb-pg',
          collection: 'docs',
          topK: 50,
          queries: [{ query: 'q', expected_doc_id: 'x', topK: 3 }],
        },
      },
      search: async (req) => {
        sawTopK = req.topK;
        return { collection: 'docs', results: [] };
      },
      now: () => 0,
    });
    expect(sawTopK).toBe(3);
    expect(report.perQuery[0]!.topK).toBe(3);
  });

  test('elapsed_ms is now() delta', async () => {
    let t = 0;
    const report = await runRagBench({
      manifest: manifest([{ query: 'q', expected_doc_id: 'x' }]),
      search: async () => ({ collection: 'docs', results: [] }),
      now: () => (t += 250),
    });
    // Two now() calls: startedAt (250), end (500). Delta = 250.
    expect(report.elapsed_ms).toBe(250);
  });
});
