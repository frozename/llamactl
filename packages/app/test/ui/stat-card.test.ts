import { describe, test, expect } from 'bun:test';
import { sparklineHeights } from '../../src/ui/stat-card';

describe('sparklineHeights', () => {
  test('maps the max value to full height', () => {
    const out = sparklineHeights([1, 2, 4, 8], 32);
    expect(out[3]).toBe(32);
  });

  test('maps the min value to at least 2 px for visibility', () => {
    const out = sparklineHeights([0, 10], 32);
    expect(out[0]).toBeGreaterThanOrEqual(2);
  });

  test('empty input returns empty array', () => {
    expect(sparklineHeights([], 32)).toEqual([]);
  });

  test('all-equal values render at full height each', () => {
    expect(sparklineHeights([5, 5, 5], 20)).toEqual([20, 20, 20]);
  });

  test('respects the max-height argument', () => {
    const out = sparklineHeights([1, 10], 10);
    expect(out[1]).toBe(10);
    expect(out[0]).toBeLessThanOrEqual(10);
  });
});
