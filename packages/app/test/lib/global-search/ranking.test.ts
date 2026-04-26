// packages/app/test/lib/global-search/ranking.test.ts
import { describe, expect, test } from 'bun:test';
import { applySurfaceBias, sortGroups } from '../../../src/lib/global-search/ranking';

describe('ranking', () => {
  test('applySurfaceBias adds 0.1 to tier 1 surfaces', () => {
    expect(applySurfaceBias({ surface: 'module', score: 0.8 } as any)).toBeCloseTo(0.9);
    expect(applySurfaceBias({ surface: 'session', score: 0.8 } as any)).toBeCloseTo(0.8);
  });

  test('sortGroups orders by topScore descending', () => {
    const g = sortGroups([
      { surface: 'logs', topScore: 0.4, hits: [] },
      { surface: 'session', topScore: 0.9, hits: [] },
    ]);
    expect(g[0]!.surface).toBe('session');
  });

  test('sortGroups breaks ties using TIE_BREAK_ORDER', () => {
    const g = sortGroups([
      { surface: 'logs', topScore: 0.8, hits: [] },
      { surface: 'module', topScore: 0.8, hits: [] },
    ]);
    expect(g[0]!.surface).toBe('module');
  });
});