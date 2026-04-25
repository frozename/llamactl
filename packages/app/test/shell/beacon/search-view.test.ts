import { describe, test, expect } from 'bun:test';
import { searchModules } from '../../../src/shell/beacon/search-modules';
import { APP_MODULES, type AppModule } from '../../../src/modules/registry';

describe('searchModules', () => {
  test('empty / whitespace query returns no results', () => {
    expect(searchModules(APP_MODULES, '')).toEqual([]);
    expect(searchModules(APP_MODULES, '   ')).toEqual([]);
  });

  test('hidden modules are excluded', () => {
    // settings, cost, ui-primitives all carry beaconGroup: "hidden".
    expect(searchModules(APP_MODULES, 'settings').find((r) => r.m.id === 'settings')).toBeUndefined();
    expect(searchModules(APP_MODULES, 'cost').find((r) => r.m.id === 'cost')).toBeUndefined();
    expect(searchModules(APP_MODULES, 'sandbox').find((r) => r.m.id === 'ui-primitives')).toBeUndefined();
  });

  test('startsWith ranks higher than contains', () => {
    // "chat" → Chat (labelKey "Chat" startsWith "chat" → score 2) ranks
    // before Ops Chat (labelKey contains "chat" but does not start with
    // it → score 1).
    const r = searchModules(APP_MODULES, 'chat');
    const ids = r.map((x) => x.m.id);
    expect(ids[0]).toBe('chat');
    expect(ids).toContain('ops-chat');
    expect(ids.indexOf('chat')).toBeLessThan(ids.indexOf('ops-chat'));
    expect(r.find((x) => x.m.id === 'chat')?.score).toBe(2);
    expect(r.find((x) => x.m.id === 'ops-chat')?.score).toBe(1);
  });

  test('alias-only match still surfaces the module', () => {
    // knowledge.retrieval has alias "rag"; labelKey "Retrieval" does
    // not contain "rag", so the only path to a match is via the alias.
    const r = searchModules(APP_MODULES, 'rag');
    const hit = r.find((x) => x.m.id === 'knowledge.retrieval');
    expect(hit).toBeDefined();
    expect(hit?.score).toBe(1);
  });

  test('beaconGroup-only match still surfaces the module', () => {
    // Planner's labelKey/aliases/id contain no "ops" — only its
    // beaconGroup does. An operator typing "ops" still expects the
    // ops-grouped Planner to surface alongside Ops Chat.
    const r = searchModules(APP_MODULES, 'ops');
    const ids = r.map((x) => x.m.id);
    expect(ids).toContain('ops-chat');
    expect(ids).toContain('plan');
  });

  test('compound query spans the labelKey/alias join boundary', () => {
    // "models cat" only matches because the haystack joins
    // labelKey + aliases + id with spaces, so "models catalog" yields
    // "models cat" as a substring.
    const r = searchModules(APP_MODULES, 'models cat');
    expect(r.map((x) => x.m.id)).toContain('models.catalog');
  });

  test('caps results at 30', () => {
    // Build a synthetic registry with 50 entries that all match a
    // common substring; confirm slice happens.
    const fake: AppModule[] = Array.from({ length: 50 }, (_, i) => ({
      id: `mod-${i}`,
      labelKey: `Mod ${i}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      icon: (() => null) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Component: (() => null) as any,
      activityBar: false,
      beaconGroup: 'workspace',
      beaconKind: 'static',
      smokeAffordance: 'fake-root',
    }));
    const r = searchModules(fake, 'mod');
    expect(r).toHaveLength(30);
  });

  test('non-matching query returns an empty array', () => {
    expect(searchModules(APP_MODULES, 'qzqzqzqz')).toEqual([]);
  });
});
