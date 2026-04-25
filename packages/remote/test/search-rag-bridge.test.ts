// packages/remote/test/search-rag-bridge.test.ts
import { describe, expect, test, mock } from 'bun:test';
import { ragBridgeSearch } from '../src/search/rag-bridge.js';
import * as resolve from '../src/rag/resolve.js';
import * as adapter from '../src/rag/index.js';

// Mock the dependencies
mock.module('../src/rag/resolve.js', () => ({
  resolveRagNode: () => ({ node: { name: 'n1', rag: { provider: 'chroma' } }, cfg: {} })
}));

mock.module('../src/rag/index.js', () => ({
  createRagAdapter: async () => ({
    search: async (opts: any) => {
      if (opts.collection === 'sessions') {
        return { hits: [{ id: 's1', score: 0.9, content: 'session snippet', metadata: { sessionId: 's1', goal: 'goal', status: 'done', startedAt: 'ts' } }] };
      }
      if (opts.collection === 'knowledge') {
        return { hits: [{ id: 'k1', score: 0.8, content: 'knowledge snippet', metadata: { entityId: 'k1', title: 'title' } }] };
      }
      if (opts.collection === 'logs') {
        return { hits: [{ id: 'l1', score: 0.7, content: 'log snippet', metadata: { fileLabel: 'app', filePath: '/app.log', lineNumber: 42 } }] };
      }
      return { hits: [] };
    },
    close: async () => {}
  })
}));

describe('ragBridgeSearch', () => {
  test('normalizes sessions hits', async () => {
    const hits = await ragBridgeSearch({ node: 'n1', collection: 'sessions', query: 'foo' });
    expect(hits.length).toBe(1);
    expect((hits[0] as any).sessionId).toBe('s1');
    expect(hits[0]!.matches[0]!.snippet).toBe('session snippet');
  });

  test('normalizes knowledge hits', async () => {
    const hits = await ragBridgeSearch({ node: 'n1', collection: 'knowledge', query: 'foo' });
    expect(hits.length).toBe(1);
    expect((hits[0] as any).entityId).toBe('k1');
  });

  test('normalizes logs hits', async () => {
    const hits = await ragBridgeSearch({ node: 'n1', collection: 'logs', query: 'foo' });
    expect(hits.length).toBe(1);
    expect((hits[0] as any).fileLabel).toBe('app');
    expect((hits[0] as any).matches[0]!.lineNumber).toBe(42);
  });
});