// packages/app/test/lib/global-search/query.test.ts
import { describe, expect, test } from 'bun:test';
import { parseQuery } from '../../../src/lib/global-search/query';

describe('parseQuery', () => {
  test('returns empty needle for empty string', () => {
    expect(parseQuery('   ')).toEqual({ needle: '' });
  });

  test('parses raw needle', () => {
    expect(parseQuery('foo bar')).toEqual({ needle: 'foo bar' });
  });

  test('extracts surface filter', () => {
    expect(parseQuery('session: audit')).toEqual({ needle: 'audit', surfaceFilter: 'session' });
    expect(parseQuery('kb: rust docs')).toEqual({ needle: 'rust docs', surfaceFilter: 'knowledge' });
  });

  test('ignores unknown prefixes', () => {
    expect(parseQuery('unknown: foo')).toEqual({ needle: 'unknown: foo' });
  });

  test('handles trailing colons as part of needle', () => {
    expect(parseQuery('foo:')).toEqual({ needle: 'foo:' });
  });
});