import { describe, test, expect } from 'bun:test';
import { dispatchTab } from '../../../src/shell/beacon/tab-dispatch';
import type { TabEntry } from '../../../src/stores/tab-store';

function tab(overrides: Partial<TabEntry> & Pick<TabEntry, 'kind'>): TabEntry {
  return {
    tabKey: 'k',
    title: 'T',
    openedAt: 0,
    ...overrides,
  };
}

describe('dispatchTab', () => {
  test('workload kind with instanceId dispatches to workload', () => {
    const out = dispatchTab(tab({ kind: 'workload', instanceId: 'wl-abc' }));
    expect(out).toEqual({ kind: 'workload', instanceId: 'wl-abc' });
  });

  test('node kind with instanceId dispatches to node', () => {
    const out = dispatchTab(tab({ kind: 'node', instanceId: 'atlas' }));
    expect(out).toEqual({ kind: 'node', instanceId: 'atlas' });
  });

  test('ops-session kind with instanceId dispatches to ops-session', () => {
    const out = dispatchTab(tab({ kind: 'ops-session', instanceId: 'sess-1' }));
    expect(out).toEqual({ kind: 'ops-session', instanceId: 'sess-1' });
  });

  test('workload kind without instanceId returns null', () => {
    expect(dispatchTab(tab({ kind: 'workload' }))).toBeNull();
  });

  test('node kind without instanceId returns null', () => {
    expect(dispatchTab(tab({ kind: 'node' }))).toBeNull();
  });

  test('ops-session kind without instanceId returns null', () => {
    expect(dispatchTab(tab({ kind: 'ops-session' }))).toBeNull();
  });

  test('module kind always returns null (router only handles non-module tabs)', () => {
    expect(dispatchTab(tab({ kind: 'module', instanceId: 'whatever' }))).toBeNull();
    expect(dispatchTab(tab({ kind: 'module' }))).toBeNull();
  });

  test('settings kind returns null', () => {
    expect(dispatchTab(tab({ kind: 'settings' }))).toBeNull();
  });
});
