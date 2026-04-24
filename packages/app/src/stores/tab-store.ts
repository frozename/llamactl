import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type TabKind = 'module' | 'workload' | 'node' | 'ops-session' | 'settings';

export interface TabEntry {
  /** Stable identity: `module:chat`, `workload:wl-abc`, `node:atlas`, etc. */
  tabKey: string;
  /** Label shown in the tab. */
  title: string;
  kind: TabKind;
  pinned?: boolean;
  openedAt: number;
  /** Optional instance id for dynamic kinds. */
  instanceId?: string;
}

export interface TabState {
  tabs: TabEntry[];
  activeKey: string | null;
  /** Recently-closed LRU, capped at 10. */
  closed: TabEntry[];
}

const CLOSED_MAX = 10;

/**
 * Returns the index of the last pinned tab (or -1 if none). Unpinned
 * tabs always live strictly right of this index; `moveTab` respects
 * the boundary.
 */
function lastPinnedIndex(tabs: readonly TabEntry[]): number {
  let idx = -1;
  for (let i = 0; i < tabs.length; i += 1) {
    if (tabs[i]?.pinned) idx = i;
    else break;
  }
  return idx;
}

export function addOrFocus(s: TabState, entry: TabEntry): TabState {
  const existing = s.tabs.findIndex((t) => t.tabKey === entry.tabKey);
  if (existing >= 0) {
    return { ...s, activeKey: entry.tabKey };
  }
  return {
    tabs: [...s.tabs, entry],
    activeKey: entry.tabKey,
    closed: s.closed.filter((t) => t.tabKey !== entry.tabKey),
  };
}

export function closeTab(s: TabState, key: string): TabState {
  const idx = s.tabs.findIndex((t) => t.tabKey === key);
  if (idx < 0) return s;
  const removed = s.tabs[idx]!;
  const nextTabs = s.tabs.filter((_, i) => i !== idx);

  let activeKey = s.activeKey;
  if (s.activeKey === key) {
    // Prefer the right neighbour; fall back to left; null if gone.
    activeKey = nextTabs[idx]?.tabKey ?? nextTabs[idx - 1]?.tabKey ?? null;
  }

  return {
    tabs: nextTabs,
    activeKey,
    closed: [removed, ...s.closed].slice(0, CLOSED_MAX),
  };
}

export function pinTab(s: TabState, key: string): TabState {
  const idx = s.tabs.findIndex((t) => t.tabKey === key);
  if (idx < 0 || s.tabs[idx]?.pinned) return s;
  const marked = { ...s.tabs[idx]!, pinned: true };
  // Move to the end of the pinned range (after other pinned tabs,
  // before the first unpinned tab).
  const withoutIt = s.tabs.filter((_, i) => i !== idx);
  const insertAt = lastPinnedIndex(withoutIt) + 1;
  const nextTabs = [...withoutIt.slice(0, insertAt), marked, ...withoutIt.slice(insertAt)];
  return { ...s, tabs: nextTabs };
}

export function unpinTab(s: TabState, key: string): TabState {
  const idx = s.tabs.findIndex((t) => t.tabKey === key);
  if (idx < 0 || !s.tabs[idx]?.pinned) return s;
  const marked = { ...s.tabs[idx]!, pinned: false };
  // Leave it where it is; pin boundary shifts left by one.
  const nextTabs = [...s.tabs];
  nextTabs[idx] = marked;
  return { ...s, tabs: nextTabs };
}

export function moveTab(s: TabState, key: string, toIndex: number): TabState {
  const fromIdx = s.tabs.findIndex((t) => t.tabKey === key);
  if (fromIdx < 0) return s;
  const entry = s.tabs[fromIdx]!;
  const withoutIt = s.tabs.filter((_, i) => i !== fromIdx);

  // Clamp to the entry's pinned-ness boundary: pinned tabs only
  // reorder among pinned; unpinned only among unpinned.
  const lastPinned = lastPinnedIndex(withoutIt);
  let target = Math.max(0, Math.min(toIndex, withoutIt.length));
  if (entry.pinned) {
    target = Math.min(target, lastPinned + 1);
  } else {
    target = Math.max(target, lastPinned + 1);
  }

  const nextTabs = [...withoutIt.slice(0, target), entry, ...withoutIt.slice(target)];
  return { ...s, tabs: nextTabs };
}

export function closeOthers(s: TabState, keepKey: string): TabState {
  const kept = s.tabs.filter((t) => t.tabKey === keepKey || t.pinned);
  const dropped = s.tabs.filter((t) => t.tabKey !== keepKey && !t.pinned);
  return {
    tabs: kept,
    activeKey: keepKey,
    closed: [...dropped.reverse(), ...s.closed].slice(0, CLOSED_MAX),
  };
}

export function closeAll(s: TabState, keepPinned = true): TabState {
  const kept = keepPinned ? s.tabs.filter((t) => t.pinned) : [];
  const dropped = s.tabs.filter((t) => !t.pinned || !keepPinned);
  return {
    tabs: kept,
    activeKey: kept[0]?.tabKey ?? null,
    closed: [...dropped.reverse(), ...s.closed].slice(0, CLOSED_MAX),
  };
}

export function reopenClosed(s: TabState): TabState {
  if (s.closed.length === 0) return s;
  const [mostRecent, ...rest] = s.closed;
  if (!mostRecent) return s;
  return {
    tabs: [...s.tabs, { ...mostRecent, pinned: false }],
    activeKey: mostRecent.tabKey,
    closed: rest,
  };
}

interface Store extends TabState {
  open: (entry: TabEntry) => void;
  close: (key: string) => void;
  setActive: (key: string) => void;
  pin: (key: string) => void;
  unpin: (key: string) => void;
  move: (key: string, to: number) => void;
  reopen: () => void;
  closeOthers: (keepKey: string) => void;
  closeAll: (keepPinned?: boolean) => void;
}

export const useTabStore = create<Store>()(
  persist(
    (set, _get) => ({
      tabs: [],
      activeKey: null,
      closed: [],
      open: (entry) => set((s) => addOrFocus(s, entry)),
      close: (key) => set((s) => closeTab(s, key)),
      setActive: (key) => set({ activeKey: key }),
      pin: (key) => set((s) => pinTab(s, key)),
      unpin: (key) => set((s) => unpinTab(s, key)),
      move: (key, to) => set((s) => moveTab(s, key, to)),
      reopen: () => set((s) => reopenClosed(s)),
      closeOthers: (keepKey) => set((s) => closeOthers(s, keepKey)),
      closeAll: (keepPinned = true) => set((s) => closeAll(s, keepPinned)),
    }),
    {
      name: 'beacon-tabs',
      version: 1,
      partialize: (s) => ({ tabs: s.tabs, activeKey: s.activeKey, closed: s.closed }),
    },
  ),
);

/** Test-helper: get the pure state subset. */
export function snapshotState(): TabState {
  const { tabs, activeKey, closed } = useTabStore.getState();
  return { tabs, activeKey, closed };
}
