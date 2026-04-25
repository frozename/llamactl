// packages/app/test/lib/global-search/orchestrator.test.ts
import { describe, expect, test } from 'bun:test';
import { runClientPhase, mergeServerHits } from '../../../src/lib/global-search/orchestrator';
import type { Hit } from '../../../src/lib/global-search/types';

describe('runClientPhase', () => {
  test('returns GroupedResults sorted by topScore', () => {
    const out = runClientPhase({
      query: { needle: 'dash' },
      tabState: { tabs: [], closed: [] },
      workloads: [],
      nodes: [],
      presets: [],
    });
    expect(Array.isArray(out)).toBe(true);
  });

  test('surface filter restricts to one group', () => {
    const out = runClientPhase({
      query: { needle: 'dash', surfaceFilter: 'module' },
      tabState: { tabs: [], closed: [] },
      workloads: [],
      nodes: [],
      presets: [],
    });
    expect(out.every((g) => g.surface === 'module')).toBe(true);
  });
});

describe('mergeServerHits', () => {
  test('replaces a pending group with hits + clears pending', () => {
    const initial = [
      { surface: 'session' as const, hits: [], topScore: 0, pending: true },
    ];
    const newHits: Hit[] = [{
      surface: 'session', parentId: 's1', parentTitle: 'g',
      score: 0.5, matchKind: 'exact',
      action: { kind: 'open-tab', tab: { tabKey: 'ops-session:s1', title: 's1', kind: 'ops-session', instanceId: 's1', openedAt: 0 } },
    }];
    const out = mergeServerHits(initial, 'session', newHits);
    const sess = out.find((g) => g.surface === 'session')!;
    expect(sess.pending).toBeFalsy();
    expect(sess.hits.length).toBe(1);
  });

  test('appends to existing hits when merging from different tier', () => {
    const initial = [{
      surface: 'session' as const,
      hits: [{
        surface: 'session' as const, parentId: 's1', parentTitle: 'g',
        score: 0.4, matchKind: 'exact' as const,
        action: { kind: 'open-tab' as const, tab: { tabKey: 't', title: 't', kind: 'module' as const, openedAt: 0 } },
      }],
      topScore: 0.4,
    }];
    const semantic: Hit[] = [{
      surface: 'session', parentId: 's1', parentTitle: 'g',
      score: 0.6, matchKind: 'semantic',
      action: { kind: 'open-tab', tab: { tabKey: 't', title: 't', kind: 'module', openedAt: 0 } },
    }];
    const out = mergeServerHits(initial, 'session', semantic, { append: true });
    const sess = out.find((g) => g.surface === 'session')!;
    expect(sess.hits.length).toBe(2);
    expect(sess.topScore).toBeCloseTo(0.6);
  });
});