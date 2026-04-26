// packages/app/test/lib/global-search/surfaces/tab-history.test.ts
import { describe, expect, test } from 'bun:test';
import { matchTabHistory } from '../../../../src/lib/global-search/surfaces/tab-history';

describe('matchTabHistory', () => {
  const state = {
    tabs: [
      { tabKey: 'ops-session:1', title: 'Audit fleet', kind: 'ops-session', openedAt: 100 },
    ],
    closed: [
      { tabKey: 'node:local', title: 'Local Agent', kind: 'node', closedAt: 200 },
      { tabKey: 'ops-session:1', title: 'Audit fleet', kind: 'ops-session', closedAt: 300 }, // dup
    ],
  };

  test('matches open tabs', () => {
    const out = matchTabHistory('audit', state);
    expect(out.length).toBe(1);
    expect(out[0]!.parentId).toBe('ops-session:1');
  });

  test('matches closed tabs and strips closedAt', () => {
    const out = matchTabHistory('local', state);
    expect(out.length).toBe(1);
    expect(out[0]!.parentId).toBe('node:local');
    if (out[0]!.action.kind === 'open-tab') {
      expect(out[0]!.action.tab.closedAt).toBeUndefined();
    }
  });

  test('deduplicates closed tabs that are currently open', () => {
    const out = matchTabHistory('audit', state);
    expect(out.length).toBe(1); // doesn't surface the closed instance
  });
});