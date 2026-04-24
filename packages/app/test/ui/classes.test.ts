import { describe, test, expect } from 'bun:test';
import { cx } from '../../src/ui/classes';

describe('cx', () => {
  test('joins strings with a space', () => {
    expect(cx('a', 'b')).toBe('a b');
  });

  test('skips falsy values', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
  });

  test('handles the record form — truthy key → include', () => {
    expect(cx('a', { b: true, c: false, d: true })).toBe('a b d');
  });

  test('empty input returns empty string', () => {
    expect(cx()).toBe('');
  });

  test('no trailing or double spaces', () => {
    expect(cx('a', '', 'b', null, 'c')).toBe('a b c');
  });
});
