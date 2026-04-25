// packages/remote/test/search-knowledge.test.ts
import { describe, expect, test } from 'bun:test';
import { searchKnowledge } from '../src/search/knowledge.js';

const entities = [
  { id: 'e1', title: 'Retrieval Pipeline', body: 'walks files and embeds chunks' },
  { id: 'e2', title: 'Embedding Model', body: 'bge-small for fast retrieval' },
  { id: 'e3', title: 'Other', body: 'unrelated content' },
];

describe('searchKnowledge', () => {
  test('returns title + body matches', () => {
    const out = searchKnowledge({ query: 'retrieval', entities, limit: 30 });
    expect(out.map((h) => h.entityId).sort()).toEqual(['e1', 'e2']);
  });

  test('title match scores higher than body match', () => {
    const out = searchKnowledge({ query: 'retrieval', entities, limit: 30 });
    expect(out[0]!.entityId).toBe('e1'); // title match wins
  });

  test('respects per-entity match cap', () => {
    const big = [{ id: 'e', title: 't', body: 'foo foo foo foo foo foo' }];
    const out = searchKnowledge({ query: 'foo', entities: big, limit: 30, perEntityCap: 2 });
    expect(out[0]!.matches.length).toBeLessThanOrEqual(2);
  });
});