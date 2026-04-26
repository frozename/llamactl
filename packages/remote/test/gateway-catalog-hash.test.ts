// packages/remote/test/gateway-catalog-hash.test.ts
import { describe, expect, test } from 'bun:test';
import { entrySpecHash } from '../src/workload/gateway-catalog/hash';

describe('entrySpecHash — sirius shape', () => {
  test('deterministic for same shape', () => {
    const a = { name: 'x', kind: 'openai-compatible', baseUrl: 'http://h:1/v1' };
    expect(entrySpecHash(a)).toBe(entrySpecHash(a));
  });

  test('differs when baseUrl changes', () => {
    const a = { name: 'x', kind: 'openai-compatible', baseUrl: 'http://h:1/v1' };
    const b = { name: 'x', kind: 'openai-compatible', baseUrl: 'http://h:2/v1' };
    expect(entrySpecHash(a)).not.toBe(entrySpecHash(b));
  });

  test('ignores compositeNames inside ownership block', () => {
    const a = {
      name: 'x',
      kind: 'openai-compatible',
      baseUrl: 'http://h:1/v1',
      ownership: { source: 'composite', compositeNames: ['a'], specHash: '' },
    };
    const b = {
      name: 'x',
      kind: 'openai-compatible',
      baseUrl: 'http://h:1/v1',
      ownership: { source: 'composite', compositeNames: ['a', 'b'], specHash: '' },
    };
    expect(entrySpecHash(a)).toBe(entrySpecHash(b));
  });
});

describe('entrySpecHash — embersynth shape', () => {
  test('differs when tags change', () => {
    const a = { id: 'x', endpoint: 'http://h:1/v1', tags: ['vision'], priority: 5 };
    const b = { id: 'x', endpoint: 'http://h:1/v1', tags: ['code'], priority: 5 };
    expect(entrySpecHash(a)).not.toBe(entrySpecHash(b));
  });

  test('differs when priority changes', () => {
    const a = { id: 'x', endpoint: 'http://h:1/v1', tags: ['vision'], priority: 5 };
    const b = { id: 'x', endpoint: 'http://h:1/v1', tags: ['vision'], priority: 7 };
    expect(entrySpecHash(a)).not.toBe(entrySpecHash(b));
  });
});
