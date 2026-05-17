import { describe, expect, test } from 'bun:test';
import { aggregateMetrics, percentile } from '../src/index.js';

describe('aggregateMetrics', () => {
  test('binary 3-row toy', () => {
    const result = aggregateMetrics([
      { pred: 'true', gold: 'true' },
      { pred: 'true', gold: 'true' },
      { pred: 'false', gold: 'true' },
    ]);
    expect(result.macro_f1).toBeCloseTo(0.4, 5);
  });
});

describe('percentile', () => {
  test('linear interpolation', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 5);
  });

  test('empty input', () => {
    expect(percentile([], 95)).toBe(0);
  });
});
