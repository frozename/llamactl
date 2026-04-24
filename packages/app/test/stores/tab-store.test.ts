import { describe, test, expect, beforeEach } from 'bun:test';
import {
  addOrFocus,
  closeTab,
  pinTab,
  unpinTab,
  moveTab,
  reopenClosed,
  closeOthers,
  closeAll,
  type TabEntry,
  type TabState,
} from '../../src/stores/tab-store';

function emptyState(): TabState {
  return { tabs: [], activeKey: null, closed: [] };
}

function entry(key: string, title = key): TabEntry {
  return { tabKey: key, title, kind: 'module', openedAt: 1 };
}

describe('tab-store ops', () => {
  let s: TabState;
  beforeEach(() => { s = emptyState(); });

  test('addOrFocus adds a new tab and makes it active', () => {
    const out = addOrFocus(s, entry('a'));
    expect(out.tabs).toHaveLength(1);
    expect(out.activeKey).toBe('a');
  });

  test('addOrFocus on existing key focuses without duplicating', () => {
    s = addOrFocus(s, entry('a'));
    s = addOrFocus(s, entry('b'));
    s = addOrFocus(s, entry('a'));
    expect(s.tabs).toHaveLength(2);
    expect(s.activeKey).toBe('a');
  });

  test('closeTab removes the tab and pushes to closed LRU', () => {
    s = addOrFocus(s, entry('a'));
    s = closeTab(s, 'a');
    expect(s.tabs).toHaveLength(0);
    expect(s.activeKey).toBeNull();
    expect(s.closed).toHaveLength(1);
    expect(s.closed[0]?.tabKey).toBe('a');
  });

  test('closeTab on active focuses the neighbour (prefers right)', () => {
    s = addOrFocus(s, entry('a'));
    s = addOrFocus(s, entry('b'));
    s = addOrFocus(s, entry('c'));
    // active is c; close b (non-active) — c stays active
    s = closeTab(s, 'b');
    expect(s.activeKey).toBe('c');
    // close c — neighbour a becomes active
    s = closeTab(s, 'c');
    expect(s.activeKey).toBe('a');
  });

  test('closed LRU caps at 10', () => {
    for (let i = 0; i < 15; i += 1) {
      s = addOrFocus(s, entry(`k${i}`));
      s = closeTab(s, `k${i}`);
    }
    expect(s.closed).toHaveLength(10);
    expect(s.closed[0]?.tabKey).toBe('k14');
    expect(s.closed[9]?.tabKey).toBe('k5');
  });

  test('pinTab moves the tab leftmost among pinned', () => {
    s = addOrFocus(s, entry('a'));
    s = addOrFocus(s, entry('b'));
    s = addOrFocus(s, entry('c'));
    s = pinTab(s, 'c');
    expect(s.tabs[0]?.tabKey).toBe('c');
    expect(s.tabs[0]?.pinned).toBe(true);
    // pin b — stays left of a but right of c (pin order is insert order)
    s = pinTab(s, 'b');
    expect(s.tabs.map((t) => t.tabKey)).toEqual(['c', 'b', 'a']);
  });

  test('unpinTab drops pinned flag; pinned stays left but can be pinned again', () => {
    s = addOrFocus(s, entry('a'));
    s = pinTab(s, 'a');
    s = unpinTab(s, 'a');
    expect(s.tabs[0]?.pinned).toBeFalsy();
  });

  test('moveTab within unpinned range', () => {
    s = addOrFocus(s, entry('a'));
    s = addOrFocus(s, entry('b'));
    s = addOrFocus(s, entry('c'));
    s = moveTab(s, 'c', 0); // c → index 0
    expect(s.tabs.map((t) => t.tabKey)).toEqual(['c', 'a', 'b']);
  });

  test('moveTab cannot interleave pinned / unpinned', () => {
    s = addOrFocus(s, entry('a'));
    s = addOrFocus(s, entry('b'));
    s = pinTab(s, 'a');
    // attempt to move unpinned b to index 0 (inside pinned range)
    s = moveTab(s, 'b', 0);
    // b stays unpinned, so it lands at the first unpinned index (1), not 0
    expect(s.tabs[0]?.tabKey).toBe('a');
    expect(s.tabs[1]?.tabKey).toBe('b');
  });

  test('reopenClosed restores the most recently closed tab as active', () => {
    s = addOrFocus(s, entry('a'));
    s = addOrFocus(s, entry('b'));
    s = closeTab(s, 'b');
    const out = reopenClosed(s);
    expect(out.activeKey).toBe('b');
    expect(out.tabs.some((t) => t.tabKey === 'b')).toBe(true);
    expect(out.closed).toHaveLength(0);
  });

  test('reopenClosed on empty closed is a no-op', () => {
    const out = reopenClosed(s);
    expect(out).toEqual(s);
  });

  test('closeOthers keeps pinned tabs and the keep key; others go to closed LRU', () => {
    s = addOrFocus(s, entry('a'));
    s = addOrFocus(s, entry('b'));
    s = addOrFocus(s, entry('c'));
    s = addOrFocus(s, entry('d'));
    s = pinTab(s, 'a');
    const out = closeOthers(s, 'c');
    expect(out.tabs.map((t) => t.tabKey)).toEqual(['a', 'c']);
    expect(out.tabs[0]?.pinned).toBe(true);
    expect(out.activeKey).toBe('c');
    expect(out.closed.map((t) => t.tabKey)).toEqual(['d', 'b']);
  });

  test('closeAll with keepPinned=true keeps only pinned', () => {
    s = addOrFocus(s, entry('a'));
    s = addOrFocus(s, entry('b'));
    s = addOrFocus(s, entry('c'));
    s = pinTab(s, 'b');
    const out = closeAll(s);
    expect(out.tabs.map((t) => t.tabKey)).toEqual(['b']);
    expect(out.activeKey).toBe('b');
    expect(out.closed.map((t) => t.tabKey).sort()).toEqual(['a', 'c']);
  });

  test('closeAll with keepPinned=false clears everything', () => {
    s = addOrFocus(s, entry('a'));
    s = addOrFocus(s, entry('b'));
    s = pinTab(s, 'a');
    const out = closeAll(s, false);
    expect(out.tabs).toEqual([]);
    expect(out.activeKey).toBeNull();
    expect(out.closed.map((t) => t.tabKey).sort()).toEqual(['a', 'b']);
  });

  test('moveTab clamps toIndex beyond the end', () => {
    s = addOrFocus(s, entry('a'));
    s = addOrFocus(s, entry('b'));
    s = addOrFocus(s, entry('c'));
    const out = moveTab(s, 'a', 99);
    expect(out.tabs.map((t) => t.tabKey)).toEqual(['b', 'c', 'a']);
  });
});
