import { expect, test } from 'bun:test';
import { canonicalRequestSha, boundaryNaiveBytePrefixSha } from '../../src/cache-identity/canonical.js';

test('canonicalRequestSha is stable across JSON key reorder', () => {
  const left = '{"b":2,"a":1,"nested":{"y":2,"x":1}}';
  const right = '{"a":1,"nested":{"x":1,"y":2},"b":2}';
  expect(canonicalRequestSha(left)).toBe(canonicalRequestSha(right));
});

test('boundaryNaiveBytePrefixSha changes when bytes change', () => {
  expect(boundaryNaiveBytePrefixSha('{"a":1}')).not.toBe(boundaryNaiveBytePrefixSha('{"a": 1}'));
});

test('canonicalRequestSha and boundaryNaiveBytePrefixSha are stable across runs', () => {
  const payload = '{"z":3,"a":[2,1]}';
  const canonical = canonicalRequestSha(payload);
  const boundary = boundaryNaiveBytePrefixSha(payload);
  expect(canonicalRequestSha(payload)).toBe(canonical);
  expect(canonicalRequestSha(payload)).toBe(canonical);
  expect(boundaryNaiveBytePrefixSha(payload)).toBe(boundary);
  expect(boundaryNaiveBytePrefixSha(payload)).toBe(boundary);
});
