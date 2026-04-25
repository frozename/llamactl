// packages/remote/test/search-text-match.test.ts
import { describe, expect, test } from 'bun:test';
import { findTextMatches } from '../src/search/text-match';

describe('findTextMatches', () => {
  test('returns empty array on no match', () => {
    expect(findTextMatches({ needle: 'zzz', text: 'foo bar baz' })).toEqual([]);
  });

  test('case-insensitive by default', () => {
    const out = findTextMatches({ needle: 'foo', text: 'FOO bar' });
    expect(out.length).toBe(1);
    expect(out[0]!.snippet).toContain('FOO');
  });

  test('multiple matches in same text', () => {
    const out = findTextMatches({ needle: 'foo', text: 'foo bar foo baz foo' });
    expect(out.length).toBe(3);
  });

  test('snippet length bounded by snippetChars', () => {
    const big = 'x'.repeat(200) + 'needle' + 'y'.repeat(200);
    const out = findTextMatches({ needle: 'needle', text: big, snippetChars: 60 });
    expect(out.length).toBe(1);
    expect(out[0]!.snippet.length).toBeLessThanOrEqual(70);
  });

  test('spans index into snippet, not original text', () => {
    const out = findTextMatches({ needle: 'cat', text: 'a cat sat on the mat' });
    const m = out[0]!;
    expect(m.snippet.slice(m.spans[0]!.start, m.spans[0]!.end).toLowerCase()).toBe('cat');
  });

  test('word-boundary mode rejects mid-word match', () => {
    const out = findTextMatches({ needle: 'cat', text: 'concatenate', wordBoundary: true });
    expect(out).toEqual([]);
  });

  test('case-sensitive mode rejects different case', () => {
    const out = findTextMatches({ needle: 'Foo', text: 'foo bar', caseSensitive: true });
    expect(out).toEqual([]);
  });

  test('word-boundary score > substring score', () => {
    const wb = findTextMatches({ needle: 'cat', text: 'a cat sat', wordBoundary: false });
    const sub = findTextMatches({ needle: 'cat', text: 'concatenate', wordBoundary: false });
    expect(wb[0]!.score).toBeGreaterThan(sub[0]!.score);
  });
});
