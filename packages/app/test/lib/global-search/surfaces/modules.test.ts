// packages/app/test/lib/global-search/surfaces/modules.test.ts
import { describe, expect, test } from 'bun:test';
import { matchModules } from '../../../../src/lib/global-search/surfaces/modules';

describe('matchModules', () => {
  test('matches by prefix with higher score', () => {
    const out = matchModules('dash');
    expect(out.length).toBe(1);
    expect(out[0]!.score).toBe(0.8);
    expect(out[0]!.parentId).toBe('module:dashboard');
  });

  test('matches by keyword with lower score', () => {
    const out = matchModules('home');
    expect(out.length).toBe(1);
    expect(out[0]!.score).toBe(0.5);
  });

  test('returns action to open module tab', () => {
    const out = matchModules('dash');
    const action = out[0]!.action;
    expect(action.kind).toBe('open-tab');
    if (action.kind === 'open-tab') {
      expect(action.tab.kind).toBe('module');
      expect(action.tab.tabKey).toBe('module:dashboard');
    }
  });
});