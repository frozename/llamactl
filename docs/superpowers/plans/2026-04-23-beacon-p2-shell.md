# Beacon P2 — Shell Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current IDE-style chrome with the Beacon shell — Layout B title bar, view-mode activity rail, Explorer panel, persistent tab bar, restyled status bar, and slide-in Tokens inspector. Ship behind a feature flag so the old shell stays available for one release. Modules still render inside tabs; flattening `*-tabbed` modules is P3.

**Architecture:** All new shell files live under `packages/app/src/shell/beacon/`. The existing `shell/` files are left in place. `App.tsx` picks between `<IDELayout />` (legacy) and `<BeaconLayout />` (new) via a zustand-backed feature flag (`beacon.shell.v3`, default `true` so new users see the new shell). The module registry gains optional `group` + `kind` fields that the Beacon shell consumes; the legacy shell ignores them. A new `useTabStore` replaces `activeModule` — tabs open, close, pin, reorder, and persist to `localStorage`.

**Tech Stack:** React 19, zustand v5 + `persist`, `@/ui` primitives from P1, Beacon tokens from P0, Lucide icons.

---

## File Structure

Create:
- `packages/app/src/stores/tab-store.ts` — tab state: open set, active, pinned, closed LRU
- `packages/app/src/stores/shell-flag.ts` — `beacon.shell.v3` boolean
- `packages/app/src/shell/beacon/layout.tsx` — the new root layout (replaces `IDELayout` when flag is on)
- `packages/app/src/shell/beacon/title-bar.tsx` — Layout B title bar
- `packages/app/src/shell/beacon/activity-rail.tsx` — 56 px view-mode rail
- `packages/app/src/shell/beacon/explorer-panel.tsx` — 280 px panel, content depends on active rail view
- `packages/app/src/shell/beacon/explorer-tree.tsx` — the Workspace tree (leaves + dynamic groups)
- `packages/app/src/shell/beacon/tab-bar.tsx` — persistent tab strip
- `packages/app/src/shell/beacon/status-bar.tsx` — restyled status bar (shares the contribution store)
- `packages/app/src/shell/beacon/tokens-panel.tsx` — slide-in tokens inspector
- `packages/app/src/shell/beacon/first-run-tip.tsx` — 3-step onboarding overlay
- `packages/app/src/shell/beacon/registry-view.ts` — pure helper: builds the tree from `APP_MODULES` + live data
- `packages/app/src/shell/beacon/rail-views.ts` — rail view descriptors (Explorer / Search / Sessions / Fleet / Tokens / Cost / Settings)
- `packages/app/test/stores/tab-store.test.ts` — tab store unit tests
- `packages/app/test/shell/registry-view.test.ts` — tree-building unit tests

Modify:
- `packages/app/src/App.tsx` — pick between `IDELayout` and `BeaconLayout`
- `packages/app/src/modules/registry.ts` — add optional `group` (already there) + `kind?: 'static' | 'dynamic-group'` (new) + `sortOrder?: number`
- `packages/app/src/shell/command-palette.tsx` — add `⌘K` binding alongside `⌘⇧P`, add "Open in tab" section, route commands through `useTabStore.open(tabKey)`

Delete: none in P2.

---

## Task 1: Tab store — schema, operations, tests

**Files:**
- Create: `packages/app/src/stores/tab-store.ts`
- Create: `packages/app/test/stores/tab-store.test.ts`

- [ ] **Step 1: Write the failing tests for pure tab-store operations**

Create `packages/app/test/stores/tab-store.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  addOrFocus,
  closeTab,
  pinTab,
  unpinTab,
  moveTab,
  reopenClosed,
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
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test --cwd packages/app test/stores/tab-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tab store**

Create `packages/app/src/stores/tab-store.ts`:

```typescript
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
    (set, get) => ({
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
      closeOthers: (keepKey) => set((s) => {
        const kept = s.tabs.filter((t) => t.tabKey === keepKey || t.pinned);
        const dropped = s.tabs.filter((t) => t.tabKey !== keepKey && !t.pinned);
        return {
          tabs: kept,
          activeKey: keepKey,
          closed: [...dropped.reverse(), ...s.closed].slice(0, CLOSED_MAX),
        };
      }),
      closeAll: (keepPinned = true) => set((s) => {
        const kept = keepPinned ? s.tabs.filter((t) => t.pinned) : [];
        const dropped = s.tabs.filter((t) => !t.pinned || !keepPinned);
        return {
          tabs: kept,
          activeKey: kept[0]?.tabKey ?? null,
          closed: [...dropped.reverse(), ...s.closed].slice(0, CLOSED_MAX),
        };
      }),
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
```

- [ ] **Step 4: Run tests**

Run: `bun test --cwd packages/app test/stores/tab-store.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/stores/tab-store.ts packages/app/test/stores/tab-store.test.ts
git commit -m "feat(app): add tab-store (persistent tab set with pin/LRU/move ops)"
```

---

## Task 2: Shell feature flag store

**Files:**
- Create: `packages/app/src/stores/shell-flag.ts`

- [ ] **Step 1: Create the flag store**

Create `packages/app/src/stores/shell-flag.ts`:

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Gates the Beacon shell (P2) against the legacy IDELayout. Default
 * `true` so new users land on Beacon; the Settings module gets a
 * toggle so users who need the old shell can opt out for one release
 * cycle. Removed at the end of P3.
 */
interface ShellFlagStore {
  beaconShell: boolean;
  setBeaconShell: (on: boolean) => void;
}

export const useShellFlag = create<ShellFlagStore>()(
  persist(
    (set) => ({
      beaconShell: true,
      setBeaconShell: (on) => set({ beaconShell: on }),
    }),
    { name: 'beacon-shell-flag' },
  ),
);
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/stores/shell-flag.ts
git commit -m "feat(app): add beacon.shell.v3 feature flag store"
```

---

## Task 3: Registry — extend with `group` + `kind` (additive, backwards compatible)

**Files:**
- Modify: `packages/app/src/modules/registry.ts`

- [ ] **Step 1: Extend the `AppModule` interface**

In `packages/app/src/modules/registry.ts`, add to the `AppModule` interface (below the existing fields):

```typescript
  /** Beacon (P2+). Where this leaf renders in the Explorer tree.
   *  Parallel to `group`; required for every leaf the Beacon Explorer
   *  shows. Legacy IDELayout ignores it. */
  beaconGroup?:
    | 'workspace'
    | 'ops'
    | 'models'
    | 'knowledge'
    | 'observability'
    | 'settings'
    | 'hidden';

  /** Beacon kind — `static` leaves are 1:1 with a tab; `dynamic-group`
   *  leaves are containers whose children come from a runtime
   *  query (workloads, nodes, ops sessions). Legacy shell ignores. */
  beaconKind?: 'static' | 'dynamic-group';

  /** Ordering hint inside the beaconGroup — lower values come first.
   *  Ties fall back to the order in the registry array. */
  beaconOrder?: number;
```

- [ ] **Step 2: Tag every existing module with a beaconGroup**

In the same file, update each entry in `APP_MODULES` to include the new fields. Use this mapping:

| id               | beaconGroup    | beaconKind        | beaconOrder |
|------------------|----------------|-------------------|-------------|
| dashboard        | workspace      | static            | 10          |
| chat             | workspace      | static            | 20          |
| ops-chat         | ops            | static            | 10          |
| projects         | workspace      | static            | 30          |
| knowledge        | knowledge      | static            | 10          |
| workloads        | ops            | dynamic-group     | 20          |
| models           | models         | static            | 10          |
| nodes            | ops            | dynamic-group     | 30          |
| logs             | observability  | static            | 10          |
| cost             | hidden         | static            | —           |
| settings         | hidden         | static            | —           |
| ui-primitives    | hidden         | static            | —           |

Apply by adding the three fields to each entry in the array. Example for `dashboard`:

```typescript
  {
    id: 'dashboard',
    labelKey: 'Dashboard',
    icon: LayoutDashboard,
    Component: LazyDashboard,
    shortcut: 1,
    activityBar: true,
    group: 'core',
    aliases: ['home', 'overview'],
    beaconGroup: 'workspace',
    beaconKind: 'static',
    beaconOrder: 10,
  },
```

The `cost`, `settings`, and `ui-primitives` entries get `beaconGroup: 'hidden'` — they don't appear in the Explorer tree. Cost and Settings are reached via the rail; `ui-primitives` stays palette-only.

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/modules/registry.ts
git commit -m "feat(app/registry): tag every module with beaconGroup/kind/order for the Beacon Explorer"
```

---

## Task 4: Explorer tree builder (pure) + tests

**Files:**
- Create: `packages/app/src/shell/beacon/registry-view.ts`
- Create: `packages/app/test/shell/registry-view.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/app/test/shell/registry-view.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { buildExplorerTree, type ExplorerLeaf, type DynamicInstance } from '../../src/shell/beacon/registry-view';
import type { AppModule } from '../../src/modules/registry';

// A minimal stand-in for AppModule without the lazy Component.
function m(id: string, beaconGroup: string, beaconKind: 'static' | 'dynamic-group' = 'static', beaconOrder = 0): AppModule {
  return {
    id,
    labelKey: id.slice(0, 1).toUpperCase() + id.slice(1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    icon: (() => null) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Component: (() => null) as any,
    activityBar: false,
    beaconGroup: beaconGroup as AppModule['beaconGroup'],
    beaconKind,
    beaconOrder,
  };
}

describe('buildExplorerTree', () => {
  test('groups leaves by beaconGroup, sorted by beaconOrder', () => {
    const modules = [
      m('a', 'ops', 'static', 20),
      m('b', 'workspace', 'static', 10),
      m('c', 'workspace', 'static', 20),
      m('d', 'ops', 'static', 10),
    ];
    const tree = buildExplorerTree(modules, { workloads: [], nodes: [] });
    expect(tree.map((g) => g.id)).toEqual(['workspace', 'ops', 'models', 'knowledge', 'observability']);
    expect(tree[0]?.leaves.map((l) => l.id)).toEqual(['b', 'c']);
    expect(tree[1]?.leaves.map((l) => l.id)).toEqual(['d', 'a']);
  });

  test('dynamic-group leaves expand with live instances', () => {
    const modules = [m('workloads', 'ops', 'dynamic-group', 20)];
    const tree = buildExplorerTree(modules, {
      workloads: [{ id: 'wl-a', title: 'wl-a · qwen', tone: 'ok' }],
      nodes: [],
    });
    const opsGroup = tree.find((g) => g.id === 'ops');
    expect(opsGroup).toBeDefined();
    const workloadsLeaf = opsGroup!.leaves.find((l) => l.id === 'workloads');
    expect(workloadsLeaf?.kind).toBe('dynamic-group');
    expect(workloadsLeaf?.instances).toHaveLength(1);
    expect(workloadsLeaf?.instances?.[0]?.id).toBe('wl-a');
  });

  test('hidden leaves are excluded', () => {
    const modules = [m('settings', 'hidden', 'static')];
    const tree = buildExplorerTree(modules, { workloads: [], nodes: [] });
    for (const group of tree) {
      expect(group.leaves).toHaveLength(0);
    }
  });

  test('groups with no leaves are dropped', () => {
    const modules = [m('a', 'workspace', 'static')];
    const tree = buildExplorerTree(modules, { workloads: [], nodes: [] });
    expect(tree.every((g) => g.leaves.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test --cwd packages/app test/shell/registry-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tree builder**

Create `packages/app/src/shell/beacon/registry-view.ts`:

```typescript
import type { AppModule } from '@/modules/registry';

export type ExplorerGroupId = 'workspace' | 'ops' | 'models' | 'knowledge' | 'observability';

export interface DynamicInstance {
  id: string;
  title: string;
  tone?: 'ok' | 'warn' | 'err' | 'idle';
}

export interface ExplorerLeaf {
  /** Source module id (e.g. 'workloads'). */
  id: string;
  title: string;
  kind: 'static' | 'dynamic-group';
  order: number;
  /** Populated when kind === 'dynamic-group' and the live data query
   *  yielded instances for this leaf. */
  instances?: DynamicInstance[];
}

export interface ExplorerGroup {
  id: ExplorerGroupId;
  label: string;
  leaves: ExplorerLeaf[];
}

export interface DynamicSources {
  workloads: DynamicInstance[];
  nodes: DynamicInstance[];
}

const GROUP_ORDER: ExplorerGroupId[] = ['workspace', 'ops', 'models', 'knowledge', 'observability'];

const GROUP_LABELS: Record<ExplorerGroupId, string> = {
  workspace: 'Workspace',
  ops: 'Ops',
  models: 'Models',
  knowledge: 'Knowledge',
  observability: 'Observability',
};

/** Map a dynamic-group leaf id to the sources key. */
function dynamicSourceFor(leafId: string): keyof DynamicSources | undefined {
  if (leafId === 'workloads') return 'workloads';
  if (leafId === 'nodes') return 'nodes';
  return undefined;
}

/**
 * Build the Explorer tree from the static registry + live dynamic
 * sources (workloads, nodes). Pure — no side effects, easy to test.
 * Hidden-group leaves are filtered out; empty groups are dropped.
 */
export function buildExplorerTree(
  modules: readonly AppModule[],
  sources: DynamicSources,
): ExplorerGroup[] {
  const byGroup = new Map<ExplorerGroupId, ExplorerLeaf[]>();
  for (const g of GROUP_ORDER) byGroup.set(g, []);

  for (const m of modules) {
    const g = m.beaconGroup;
    if (!g || g === 'hidden' || g === 'settings') continue;
    if (!GROUP_ORDER.includes(g as ExplorerGroupId)) continue;
    const leaf: ExplorerLeaf = {
      id: m.id,
      title: m.labelKey,
      kind: m.beaconKind ?? 'static',
      order: m.beaconOrder ?? 1000,
    };
    if (leaf.kind === 'dynamic-group') {
      const src = dynamicSourceFor(leaf.id);
      leaf.instances = src ? sources[src] : [];
    }
    byGroup.get(g as ExplorerGroupId)!.push(leaf);
  }

  return GROUP_ORDER
    .map((id) => {
      const leaves = (byGroup.get(id) ?? [])
        .slice()
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      return { id, label: GROUP_LABELS[id], leaves };
    })
    .filter((g) => g.leaves.length > 0);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test --cwd packages/app test/shell/registry-view.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/shell/beacon/registry-view.ts packages/app/test/shell/registry-view.test.ts
git commit -m "feat(app/shell/beacon): add Explorer tree builder (static + dynamic leaves)"
```

---

## Task 5: Rail view descriptors

**Files:**
- Create: `packages/app/src/shell/beacon/rail-views.ts`

- [ ] **Step 1: Create the descriptors**

Create `packages/app/src/shell/beacon/rail-views.ts`:

```typescript
import {
  Coins,
  Compass,
  Folder,
  Layers3,
  Palette,
  Search,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';

export type RailViewId =
  | 'explorer'
  | 'search'
  | 'sessions'
  | 'fleet'
  | 'tokens'
  | 'cost'
  | 'settings';

export interface RailView {
  id: RailViewId;
  label: string;
  icon: LucideIcon;
  position: 'top' | 'bottom';
  /** P2 stub views render a "coming in P3" placeholder. */
  stub?: boolean;
}

export const RAIL_VIEWS: readonly RailView[] = [
  { id: 'explorer', label: 'Explorer', icon: Folder,  position: 'top' },
  { id: 'search',   label: 'Search',   icon: Search,  position: 'top', stub: true },
  { id: 'sessions', label: 'Sessions', icon: Layers3, position: 'top', stub: true },
  { id: 'fleet',    label: 'Fleet',    icon: Compass, position: 'top', stub: true },
  { id: 'tokens',   label: 'Tokens',   icon: Palette, position: 'top' },
  { id: 'cost',     label: 'Cost',     icon: Coins,   position: 'bottom' },
  { id: 'settings', label: 'Settings', icon: SettingsIcon, position: 'bottom' },
];

export function getRailView(id: RailViewId): RailView {
  return RAIL_VIEWS.find((v) => v.id === id) ?? RAIL_VIEWS[0]!;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/shell/beacon/rail-views.ts
git commit -m "feat(app/shell/beacon): add rail view descriptors (Explorer/Search/Sessions/Fleet/Tokens/Cost/Settings)"
```

---

## Task 6: ActivityRail (view-mode buttons)

**Files:**
- Create: `packages/app/src/shell/beacon/activity-rail.tsx`

- [ ] **Step 1: Create the component**

Create `packages/app/src/shell/beacon/activity-rail.tsx`:

```typescript
import * as React from 'react';
import { RAIL_VIEWS, type RailViewId } from './rail-views';
import { cx } from '@/ui';

interface ActivityRailProps {
  activeView: RailViewId;
  onChange: (next: RailViewId) => void;
}

/**
 * 56 px left rail — the Beacon view switcher. Top group = Explorer /
 * Search / Sessions / Fleet / Tokens. Bottom group = Cost / Settings.
 * Active button has brand-ghost background + 2 px brand indicator on
 * the left edge.
 */
export function ActivityRail({ activeView, onChange }: ActivityRailProps): React.JSX.Element {
  const top = RAIL_VIEWS.filter((v) => v.position === 'top');
  const bottom = RAIL_VIEWS.filter((v) => v.position === 'bottom');

  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      className={cx('bcn-rail')}
      style={{
        width: 56,
        background: 'var(--color-surface-1)',
        borderRight: '1px solid var(--color-border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '12px 0',
        gap: 4,
      }}
    >
      {top.map((v) => <RailButton key={v.id} view={v} active={v.id === activeView} onChange={onChange} />)}
      <div style={{ flex: 1 }} />
      {bottom.map((v) => <RailButton key={v.id} view={v} active={v.id === activeView} onChange={onChange} />)}
    </div>
  );
}

function RailButton({ view, active, onChange }: { view: typeof RAIL_VIEWS[number]; active: boolean; onChange: (id: RailViewId) => void }): React.JSX.Element {
  const Icon = view.icon;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={view.label}
      title={view.label}
      onClick={() => onChange(view.id)}
      data-testid={`bcn-rail-${view.id}`}
      style={{
        width: 40,
        height: 40,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 'var(--r-lg)',
        border: 'none',
        cursor: 'pointer',
        color: active ? 'var(--color-brand)' : 'var(--color-text-tertiary)',
        background: active ? 'var(--color-brand-ghost)' : 'transparent',
        position: 'relative',
        transition: 'background 160ms, color 160ms',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--color-surface-2)';
          e.currentTarget.style.color = 'var(--color-text)';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--color-text-tertiary)';
        }
      }}
    >
      {active && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: -8,
            top: 8,
            bottom: 8,
            width: 2,
            background: 'var(--color-brand)',
            borderRadius: 2,
          }}
        />
      )}
      <Icon size={18} strokeWidth={1.75} />
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/shell/beacon/activity-rail.tsx
git commit -m "feat(app/shell/beacon): add ActivityRail (view-mode rail, 56 px)"
```

---

## Task 7: ExplorerTree (consumes the tree builder + live data)

**Files:**
- Create: `packages/app/src/shell/beacon/explorer-tree.tsx`

- [ ] **Step 1: Create the component**

Create `packages/app/src/shell/beacon/explorer-tree.tsx`:

```typescript
import * as React from 'react';
import { StatusDot, TreeItem } from '@/ui';
import { APP_MODULES } from '@/modules/registry';
import { trpc } from '@/lib/trpc';
import { useTabStore, type TabEntry } from '@/stores/tab-store';
import { buildExplorerTree, type DynamicInstance, type ExplorerLeaf } from './registry-view';

/**
 * Renders the Workspace tree. Static leaves open a module tab; dynamic
 * leaves expand to show live instances (each a workload / node tab).
 * Collapse state is local (component state) — persistence across
 * sessions is left for P3 once the actual UX settles.
 */
export function ExplorerTree(): React.JSX.Element {
  const workloads = trpc.workloadList.useQuery(undefined, { refetchInterval: 10_000 });
  const nodes = trpc.nodeList.useQuery(undefined, { refetchInterval: 30_000 });

  const wlInstances: DynamicInstance[] = React.useMemo(() => {
    const rows = (workloads.data ?? []) as Array<{ name?: string; phase?: string; modelRef?: string }>;
    return rows.map((w) => ({
      id: w.name ?? 'unknown',
      title: `${w.name ?? '—'}${w.modelRef ? ` · ${w.modelRef}` : ''}`,
      tone: w.phase === 'Running' ? 'ok' : w.phase === 'Failed' ? 'err' : 'warn',
    }));
  }, [workloads.data]);

  const nodeInstances: DynamicInstance[] = React.useMemo(() => {
    const rows = (nodes.data?.nodes ?? []) as Array<{ name: string; effectiveKind?: string }>;
    return rows.map((n) => ({
      id: n.name,
      title: `${n.name} · ${n.effectiveKind ?? 'agent'}`,
      tone: 'ok',
    }));
  }, [nodes.data]);

  const tree = React.useMemo(
    () => buildExplorerTree(APP_MODULES, { workloads: wlInstances, nodes: nodeInstances }),
    [wlInstances, nodeInstances],
  );

  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const activeTabKey = useTabStore((s) => s.activeKey);
  const open = useTabStore((s) => s.open);

  const openLeaf = (leaf: ExplorerLeaf): void => {
    const entry: TabEntry = {
      tabKey: `module:${leaf.id}`,
      title: leaf.title,
      kind: 'module',
      openedAt: Date.now(),
    };
    open(entry);
  };

  const openInstance = (leaf: ExplorerLeaf, inst: DynamicInstance): void => {
    const kind = leaf.id === 'workloads' ? 'workload' : leaf.id === 'nodes' ? 'node' : 'module';
    const entry: TabEntry = {
      tabKey: `${kind}:${inst.id}`,
      title: inst.title,
      kind: kind as TabEntry['kind'],
      instanceId: inst.id,
      openedAt: Date.now(),
    };
    open(entry);
  };

  return (
    <div style={{ overflowY: 'auto', flex: 1 }}>
      {tree.map((group) => {
        const isCollapsed = collapsed[group.id] === true;
        return (
          <div key={group.id}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [group.id]: !c[group.id] }))}
              style={{
                all: 'unset',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '10px 18px 4px',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--color-text-tertiary)',
                cursor: 'pointer',
                width: '100%',
              }}
            >
              <span style={{ transition: 'transform 160ms', transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}>▾</span>
              {group.label}
            </button>
            {!isCollapsed && group.leaves.map((leaf) => (
              <React.Fragment key={leaf.id}>
                <TreeItem
                  label={leaf.title}
                  active={activeTabKey === `module:${leaf.id}`}
                  onClick={() => openLeaf(leaf)}
                  collapsed={leaf.kind === 'dynamic-group' ? (collapsed[`${group.id}/${leaf.id}`] ?? false) : undefined}
                  onDoubleClick={() => {
                    if (leaf.kind === 'dynamic-group') {
                      setCollapsed((c) => ({ ...c, [`${group.id}/${leaf.id}`]: !c[`${group.id}/${leaf.id}`] }));
                    }
                  }}
                />
                {leaf.kind === 'dynamic-group' && !(collapsed[`${group.id}/${leaf.id}`] ?? false) &&
                  (leaf.instances ?? []).map((inst) => (
                    <TreeItem
                      key={inst.id}
                      indent={1}
                      label={inst.title}
                      trailing={<StatusDot tone={inst.tone ?? 'idle'} />}
                      active={activeTabKey === `${leaf.id === 'workloads' ? 'workload' : 'node'}:${inst.id}`}
                      onClick={() => openInstance(leaf, inst)}
                    />
                  ))}
              </React.Fragment>
            ))}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/shell/beacon/explorer-tree.tsx
git commit -m "feat(app/shell/beacon): add ExplorerTree (static + dynamic leaves, live counts via tRPC)"
```

---

## Task 8: ExplorerPanel (rail-view-aware left panel)

**Files:**
- Create: `packages/app/src/shell/beacon/explorer-panel.tsx`

- [ ] **Step 1: Create the panel**

Create `packages/app/src/shell/beacon/explorer-panel.tsx`:

```typescript
import * as React from 'react';
import { Input } from '@/ui';
import { Search } from 'lucide-react';
import { useCommandPaletteOpen } from '@/shell/command-palette';
import { ExplorerTree } from './explorer-tree';
import type { RailViewId } from './rail-views';

interface ExplorerPanelProps {
  activeView: RailViewId;
}

/**
 * The 280 px left panel. Its content depends on the active rail view:
 * Explorer = module tree; Search / Sessions / Fleet / Cost = stubs in
 * P2 that become real in P3; Tokens is handled by the separate
 * TokensPanel slide-in (this panel renders the prompt).
 */
export function ExplorerPanel({ activeView }: ExplorerPanelProps): React.JSX.Element {
  return (
    <aside
      style={{
        width: 280,
        background: 'var(--color-surface-1)',
        borderRight: '1px solid var(--color-border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Header label={activeView} />
      {activeView === 'explorer' && <ExplorerBody />}
      {activeView === 'search' && <SearchStub />}
      {activeView === 'sessions' && <StubBody message="Sessions view ships in P3. Recent chat and ops sessions will group here by time." />}
      {activeView === 'fleet' && <StubBody message="Fleet view ships in P3. Node tree + quick context switcher." />}
      {activeView === 'tokens' && <StubBody message="Tokens inspector slides from the right edge — look over there." />}
      {activeView === 'cost' && <StubBody message="Cost details render here in P3. For now, open Cost via the command palette." />}
      {activeView === 'settings' && <StubBody message="Click the Settings rail button to open the Settings tab." />}
    </aside>
  );
}

function Header({ label }: { label: RailViewId }): React.JSX.Element {
  return (
    <div style={{ padding: '14px 18px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <h2
        style={{
          margin: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--color-text-tertiary)',
          fontWeight: 500,
        }}
      >
        {label === 'explorer' ? 'Beacon' : label}
      </h2>
    </div>
  );
}

function ExplorerBody(): React.JSX.Element {
  return (
    <>
      <div style={{ padding: '0 14px 10px' }}>
        <Input leadingSlot={<Search size={12} />} placeholder="Search files…" />
      </div>
      <ExplorerTree />
    </>
  );
}

function SearchStub(): React.JSX.Element {
  const [, setOpen] = useCommandPaletteOpen();
  return (
    <div style={{ padding: '14px 18px', color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
      <p>Global search lands in P3. Until then, the command palette covers most of the ground.</p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          marginTop: 12,
          padding: '6px 10px',
          background: 'var(--color-brand-ghost)',
          color: 'var(--color-brand)',
          borderRadius: 'var(--r-md)',
          border: 'none',
          cursor: 'pointer',
          fontSize: 12,
        }}
      >
        Open command palette (⌘⇧P)
      </button>
    </div>
  );
}

function StubBody({ message }: { message: string }): React.JSX.Element {
  return (
    <div style={{ padding: '14px 18px', color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
      <p>{message}</p>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/shell/beacon/explorer-panel.tsx
git commit -m "feat(app/shell/beacon): add ExplorerPanel (rail-aware left pane, stubs for P3 views)"
```

---

## Task 9: TabBar

**Files:**
- Create: `packages/app/src/shell/beacon/tab-bar.tsx`

- [ ] **Step 1: Create the component**

Create `packages/app/src/shell/beacon/tab-bar.tsx`:

```typescript
import * as React from 'react';
import { X, Pin } from 'lucide-react';
import { useTabStore, type TabEntry } from '@/stores/tab-store';

/**
 * Persistent tab strip. Pinned tabs render leftmost with a pin glyph
 * in place of the × close button. Active tab paints a 1.5 px brand
 * underbar on its top edge. Middle-click closes; right-click shows a
 * context menu (Pin, Close others, Close all).
 */
export function TabBar(): React.JSX.Element {
  const tabs = useTabStore((s) => s.tabs);
  const activeKey = useTabStore((s) => s.activeKey);
  const setActive = useTabStore((s) => s.setActive);
  const close = useTabStore((s) => s.close);
  const pin = useTabStore((s) => s.pin);
  const unpin = useTabStore((s) => s.unpin);
  const closeOthers = useTabStore((s) => s.closeOthers);
  const closeAll = useTabStore((s) => s.closeAll);

  const [menu, setMenu] = React.useState<{ x: number; y: number; tab: TabEntry } | null>(null);

  React.useEffect(() => {
    if (!menu) return;
    const handler = (): void => setMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [menu]);

  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        background: 'var(--color-surface-1)',
        borderBottom: '1px solid var(--color-border-subtle)',
        overflowX: 'auto',
        minHeight: 38,
      }}
    >
      {tabs.map((tab) => {
        const active = tab.tabKey === activeKey;
        return (
          <div
            key={tab.tabKey}
            role="tab"
            aria-selected={active}
            onClick={() => setActive(tab.tabKey)}
            onAuxClick={(e) => { if (e.button === 1) close(tab.tabKey); }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, tab });
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 14px',
              fontSize: 12,
              color: active ? 'var(--color-text)' : 'var(--color-text-tertiary)',
              background: active ? 'var(--color-surface-0)' : 'transparent',
              cursor: 'pointer',
              borderRight: '1px solid var(--color-border-subtle)',
              position: 'relative',
              whiteSpace: 'nowrap',
              transition: 'background 160ms, color 160ms',
            }}
          >
            {active && (
              <span
                aria-hidden="true"
                style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1.5, background: 'var(--color-brand)' }}
              />
            )}
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: active ? 'var(--color-brand)' : 'var(--color-text-ghost)' }} />
            <span>{tab.title}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); tab.pinned ? unpin(tab.tabKey) : close(tab.tabKey); }}
              style={{
                all: 'unset',
                width: 16,
                height: 16,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 4,
                cursor: 'pointer',
                marginLeft: 4,
                color: 'inherit',
              }}
              title={tab.pinned ? 'Unpin' : 'Close'}
            >
              {tab.pinned ? <Pin size={11} strokeWidth={2} fill="currentColor" /> : <X size={12} strokeWidth={2} />}
            </button>
          </div>
        );
      })}
      {menu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: menu.x,
            top: menu.y,
            background: 'var(--color-surface-2)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--r-md)',
            padding: 4,
            boxShadow: 'var(--shadow-md)',
            fontSize: 12,
            zIndex: 2000,
            minWidth: 180,
          }}
        >
          <MenuItem label={menu.tab.pinned ? 'Unpin' : 'Pin'} onPick={() => { menu.tab.pinned ? unpin(menu.tab.tabKey) : pin(menu.tab.tabKey); setMenu(null); }} />
          <MenuItem label="Close" onPick={() => { close(menu.tab.tabKey); setMenu(null); }} />
          <MenuItem label="Close others" onPick={() => { closeOthers(menu.tab.tabKey); setMenu(null); }} />
          <MenuItem label="Close all" onPick={() => { closeAll(true); setMenu(null); }} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, onPick }: { label: string; onPick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        all: 'unset',
        display: 'block',
        width: '100%',
        padding: '6px 10px',
        cursor: 'pointer',
        color: 'var(--color-text)',
        borderRadius: 4,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-surface-3)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/shell/beacon/tab-bar.tsx
git commit -m "feat(app/shell/beacon): add TabBar with pin/close/close-others/close-all"
```

---

## Task 10: TitleBar (Layout B)

**Files:**
- Create: `packages/app/src/shell/beacon/title-bar.tsx`

- [ ] **Step 1: Create the component**

Create `packages/app/src/shell/beacon/title-bar.tsx`:

```typescript
import * as React from 'react';
import { CommandBar, ThemeOrbs } from '@/ui';
import { useThemeStore } from '@/stores/theme-store';
import { useTabStore } from '@/stores/tab-store';
import { NodeSelector } from '@/shell/node-selector';
import { useCommandPaletteOpen } from '@/shell/command-palette';
import { Bell } from 'lucide-react';

/**
 * Layout B — macOS traffic lights (handled by main process), a
 * ⌘K breadcrumb/command bar, NodeSelector, ThemeOrbs, notifications
 * icon, avatar. No File/Edit/View menu — macOS provides its own.
 */
export function TitleBar(): React.JSX.Element {
  const themeId = useThemeStore((s) => s.themeId);
  const setThemeId = useThemeStore((s) => s.setThemeId);
  const activeKey = useTabStore((s) => s.activeKey);
  const tabs = useTabStore((s) => s.tabs);
  const [, setPaletteOpen] = useCommandPaletteOpen();

  const activeTab = tabs.find((t) => t.tabKey === activeKey);
  const crumbs = [
    { label: 'beacon' },
    ...(activeTab ? [{ label: activeTab.title, current: true }] : []),
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto auto auto auto',
        alignItems: 'center',
        gap: 10,
        height: 44,
        padding: '0 14px',
        background: 'var(--color-surface-1)',
        borderBottom: '1px solid var(--color-border-subtle)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {/* Traffic-light space — reserved so the drag region starts here,
           and the macOS lights overlay at `titleBarStyle: 'hiddenInset'`. */}
      <div style={{ width: 72 }} />

      <div
        style={{ justifySelf: 'start', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <CommandBar crumbs={crumbs} onClick={() => setPaletteOpen(true)} />
      </div>

      <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <NodeSelector />
      </div>

      <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <ThemeOrbs activeId={themeId} onPick={setThemeId} />
      </div>

      <button
        type="button"
        style={{
          all: 'unset',
          width: 28,
          height: 28,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 'var(--r-md)',
          color: 'var(--color-text-tertiary)',
          cursor: 'pointer',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
        title="Notifications (P3)"
      >
        <Bell size={14} strokeWidth={1.75} />
      </button>

      <div
        aria-hidden="true"
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, var(--color-brand), #f59e0b)',
          border: '1.5px solid var(--color-surface-1)',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/shell/beacon/title-bar.tsx
git commit -m "feat(app/shell/beacon): add TitleBar Layout B (CommandBar + ThemeOrbs + NodeSelector)"
```

---

## Task 11: StatusBar (Beacon restyle)

**Files:**
- Create: `packages/app/src/shell/beacon/status-bar.tsx`

- [ ] **Step 1: Create the restyled status bar**

Create `packages/app/src/shell/beacon/status-bar.tsx`:

```typescript
import * as React from 'react';
import { Command } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { useTabStore } from '@/stores/tab-store';
import { useStatusBarStore } from '@/stores/status-bar-store';
import { useThemeStore } from '@/stores/theme-store';
import { useCommandPaletteOpen } from '@/shell/command-palette';
import { getTheme } from '@/themes';

/**
 * Beacon status bar. Three lanes preserved from the legacy shell:
 *   left:   fleet indicators (permanent)
 *   center: per-module contributions (via useStatusBarStore)
 *   right:  command palette shortcut + theme name
 *
 * Contributions are still keyed on "active module id", but with tabs
 * the active module is the kind + source of the active tab. A module
 * tab publishes contributions keyed by its leaf id.
 */
export function StatusBar(): React.JSX.Element {
  const activeKey = useTabStore((s) => s.activeKey);
  const contributions = useStatusBarStore((s) => s.contributions);
  const themeId = useThemeStore((s) => s.themeId);
  const [, setPaletteOpen] = useCommandPaletteOpen();

  const moduleId = activeKey?.startsWith('module:') ? activeKey.slice('module:'.length) : null;
  const moduleItems = moduleId ? (contributions[moduleId] ?? []) : [];

  const nodeList = trpc.nodeList.useQuery(undefined, { refetchInterval: 30_000 });
  const workloads = trpc.workloadList.useQuery(undefined, { refetchInterval: 10_000 });

  const total = nodeList.data?.nodes.length ?? 0;
  const running = (workloads.data ?? []).filter((w: { phase?: string }) => w.phase === 'Running').length;

  const theme = getTheme(themeId);

  return (
    <div
      data-testid="beacon-status-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 26,
        padding: '0 12px',
        background: 'var(--color-surface-1)',
        borderTop: '1px solid var(--color-border-subtle)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--color-text-tertiary)',
        gap: 14,
        flexWrap: 'nowrap',
        overflow: 'hidden',
      }}
    >
      <SBItem glyph="◉" text={`${total} nodes`} tone="ok" />
      <SBItem glyph="⊡" text={`${running} running`} tone={running > 0 ? 'ok' : 'muted'} />

      {moduleItems.length > 0 && (
        <>
          <Divider />
          {moduleItems.map((it) => (
            <SBItem key={it.id} glyph={it.glyph} text={it.text} tone={it.tone === 'accent' ? 'ok' : (it.tone ?? 'muted')} />
          ))}
        </>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          style={{
            all: 'unset',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 6px',
            borderRadius: 'var(--r-sm)',
            color: 'var(--color-text-secondary)',
          }}
          title="Command palette (⌘⇧P)"
        >
          <Command size={10} />
          <span>⌘⇧P</span>
        </button>
        <span style={{ color: 'var(--color-text-tertiary)' }}>{theme.label.toLowerCase()}</span>
      </div>
    </div>
  );
}

function Divider(): React.JSX.Element {
  return <span aria-hidden="true" style={{ width: 1, height: 12, background: 'var(--color-border)' }} />;
}

interface SBItemProps { glyph?: string; text: string; tone: 'ok' | 'warn' | 'err' | 'muted' }
function SBItem({ glyph, text, tone }: SBItemProps): React.JSX.Element {
  const color =
    tone === 'ok' ? 'var(--color-ok)' :
    tone === 'warn' ? 'var(--color-warn)' :
    tone === 'err' ? 'var(--color-err)' :
    'var(--color-text-tertiary)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color }}>
      {glyph && <span aria-hidden="true">{glyph}</span>}
      <span>{text}</span>
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/shell/beacon/status-bar.tsx
git commit -m "feat(app/shell/beacon): add Beacon StatusBar (restyle, shares contribution store)"
```

---

## Task 12: TokensPanel (slide-in)

**Files:**
- Create: `packages/app/src/shell/beacon/tokens-panel.tsx`

- [ ] **Step 1: Create the panel**

Create `packages/app/src/shell/beacon/tokens-panel.tsx`:

```typescript
import * as React from 'react';

interface TokensPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 380 px slide-in inspector showing live values for every Beacon CSS
 * custom property. Grouped (Brand / Surface / Border / Text / Status
 * / Type / Spacing / Radius / Shadow). Click a row to copy the
 * computed value to the clipboard.
 */
export function TokensPanel({ open, onClose }: TokensPanelProps): React.JSX.Element {
  const sections = React.useMemo(() => SECTIONS, []);
  const root = typeof document !== 'undefined' ? document.documentElement : null;

  const read = (name: string): string => {
    if (!root) return '';
    return window.getComputedStyle(root).getPropertyValue(name).trim();
  };

  return (
    <div
      role="dialog"
      aria-label="Tokens"
      style={{
        position: 'fixed',
        top: 44,
        bottom: 26,
        right: 0,
        width: 380,
        maxWidth: '100%',
        background: 'var(--color-surface-1)',
        borderLeft: '1px solid var(--color-border-subtle)',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 260ms cubic-bezier(.4,0,.2,1)',
        zIndex: 30,
        overflowY: 'auto',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div
        style={{
          position: 'sticky',
          top: 0,
          padding: '16px 20px',
          background: 'var(--color-surface-1)',
          borderBottom: '1px solid var(--color-border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <h3 style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Tokens</h3>
        <button
          type="button"
          onClick={onClose}
          style={{ all: 'unset', cursor: 'pointer', padding: '4px 8px', color: 'var(--color-text-tertiary)' }}
        >
          ×
        </button>
      </div>
      <div style={{ padding: '12px 4px 32px' }}>
        {sections.map((section) => (
          <section key={section.label} style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border-subtle)' }}>
            <h4 style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', margin: '0 0 10px', fontWeight: 500 }}>
              {section.label}
            </h4>
            {section.tokens.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => navigator.clipboard.writeText(read(name))}
                title={`Copy ${name}`}
                style={{
                  all: 'unset',
                  display: 'grid',
                  gridTemplateColumns: '20px 1fr auto',
                  gap: 10,
                  padding: '6px 0',
                  alignItems: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  width: '100%',
                  cursor: 'copy',
                }}
              >
                <span style={{ width: 16, height: 16, borderRadius: 3, background: `var(${name})`, border: '1px solid var(--color-border-subtle)' }} />
                <span style={{ color: 'var(--color-text-secondary)' }}>{name}</span>
                <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>{read(name)}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

const SECTIONS = [
  { label: 'Brand', tokens: ['--color-brand', '--color-brand-subtle', '--color-brand-muted', '--color-brand-ghost', '--color-brand-contrast'] },
  { label: 'Surface', tokens: ['--color-surface-0', '--color-surface-1', '--color-surface-2', '--color-surface-3', '--color-surface-4'] },
  { label: 'Border', tokens: ['--color-border', '--color-border-subtle', '--color-border-strong', '--color-border-focus'] },
  { label: 'Text', tokens: ['--color-text', '--color-text-secondary', '--color-text-tertiary', '--color-text-ghost', '--color-text-inverse'] },
  { label: 'Status', tokens: ['--color-ok', '--color-warn', '--color-err', '--color-info'] },
];
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/shell/beacon/tokens-panel.tsx
git commit -m "feat(app/shell/beacon): add TokensPanel slide-in inspector"
```

---

## Task 13: First-run tip overlay

**Files:**
- Create: `packages/app/src/shell/beacon/first-run-tip.tsx`

- [ ] **Step 1: Create the overlay**

Create `packages/app/src/shell/beacon/first-run-tip.tsx`:

```typescript
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Button, Kbd } from '@/ui';

const FIRST_RUN_KEY = 'beacon.tip.shown';

/**
 * 3-step onboarding overlay shown once per user after they first see
 * the Beacon shell. Remembered via `localStorage[beacon.tip.shown]`.
 */
export function FirstRunTip(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem(FIRST_RUN_KEY) !== '1') setVisible(true);
  }, []);

  if (!visible) return null;

  const dismiss = (): void => {
    localStorage.setItem(FIRST_RUN_KEY, '1');
    setVisible(false);
  };

  const steps = [
    { title: 'Welcome to Beacon.', body: <>The left rail switches views — Explorer, Search, Tokens, etc. The Explorer tree opens any module (or a live workload) in a tab.</> },
    { title: 'Tabs persist.', body: <>Open as many as you need — they survive restarts. <Kbd>⌘W</Kbd> closes, <Kbd>⌘⇧T</Kbd> reopens, <Kbd>⌘1</Kbd>–<Kbd>⌘9</Kbd> jump by position.</> },
    { title: 'Command palette still works.', body: <>Hit <Kbd>⌘K</Kbd> or <Kbd>⌘⇧P</Kbd> anytime to fuzzy-find a module, workload, node, or action.</> },
  ];

  const current = steps[step] ?? steps[0]!;
  const isLast = step === steps.length - 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-surface-overlay)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 3000,
      }}
    >
      <div
        style={{
          width: 440,
          maxWidth: '92vw',
          background: 'var(--color-surface-1)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--r-xl)',
          padding: 28,
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.18em', color: 'var(--color-text-tertiary)', textTransform: 'uppercase', marginBottom: 12 }}>
          Step {step + 1} of {steps.length}
        </div>
        <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 600 }}>{current.title}</h2>
        <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.6, margin: '0 0 24px' }}>{current.body}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={dismiss}>Skip</Button>
          {!isLast && <Button variant="primary" onClick={() => setStep(step + 1)}>Next</Button>}
          {isLast && <Button variant="primary" onClick={dismiss}>Get started</Button>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/shell/beacon/first-run-tip.tsx
git commit -m "feat(app/shell/beacon): add FirstRunTip 3-step overlay"
```

---

## Task 14: BeaconLayout (wires everything together)

**Files:**
- Create: `packages/app/src/shell/beacon/layout.tsx`

- [ ] **Step 1: Create the layout**

Create `packages/app/src/shell/beacon/layout.tsx`:

```typescript
import * as React from 'react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { APP_MODULES } from '@/modules/registry';
import { useTabStore } from '@/stores/tab-store';
import { CommandPaletteMount, useCommandPaletteOpen } from '@/shell/command-palette';
import { TitleBar } from './title-bar';
import { ActivityRail } from './activity-rail';
import { ExplorerPanel } from './explorer-panel';
import { TabBar } from './tab-bar';
import { StatusBar } from './status-bar';
import { TokensPanel } from './tokens-panel';
import { FirstRunTip } from './first-run-tip';
import type { RailViewId } from './rail-views';

const RAIL_KEY = 'beacon.rail.view';

/**
 * Beacon shell root. Manages the rail-view selection (local state,
 * persisted to localStorage), mounts every tab's module component
 * lazily via APP_MODULES, toggles visibility with display:none so
 * state is preserved across tab switches (the same pattern the
 * legacy IDELayout uses for modules).
 */
export function BeaconLayout(): React.JSX.Element {
  const tabs = useTabStore((s) => s.tabs);
  const activeKey = useTabStore((s) => s.activeKey);
  const open = useTabStore((s) => s.open);
  const close = useTabStore((s) => s.close);
  const reopen = useTabStore((s) => s.reopen);
  const setActive = useTabStore((s) => s.setActive);

  const [railView, setRailView] = useState<RailViewId>(() => {
    if (typeof localStorage === 'undefined') return 'explorer';
    return ((localStorage.getItem(RAIL_KEY) as RailViewId) || 'explorer');
  });
  useEffect(() => { localStorage.setItem(RAIL_KEY, railView); }, [railView]);

  // Seed a default tab if none exist.
  useEffect(() => {
    if (tabs.length === 0) {
      open({ tabKey: 'module:dashboard', title: 'Dashboard', kind: 'module', openedAt: Date.now() });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle the Tokens rail view by opening the slide-in panel (it's
  // not a panel-content view, it's an overlay — ExplorerPanel shows
  // a hint, the slide-in does the work).
  const tokensOpen = railView === 'tokens';

  // Tab keyboard shortcuts: ⌘1–⌘9, ⌘W, ⌘⇧T.
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key === 'w' && !e.shiftKey && activeKey) {
        e.preventDefault();
        close(activeKey);
        return;
      }
      if (e.key === 'T' && e.shiftKey) {
        e.preventDefault();
        reopen();
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const target = tabs[n - 1];
        if (target) {
          e.preventDefault();
          setActive(target.tabKey);
        }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [tabs, activeKey, close, reopen, setActive]);

  const visitedRef = useRef(new Set<string>());
  if (activeKey) visitedRef.current.add(activeKey);
  for (const t of tabs) visitedRef.current.add(t.tabKey);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
        height: '100vh',
        position: 'relative',
        zIndex: 1,
      }}
    >
      <TitleBar />

      <div style={{ display: 'grid', gridTemplateColumns: '56px 280px 1fr', overflow: 'hidden', minHeight: 0 }}>
        <ActivityRail activeView={railView} onChange={setRailView} />
        <ExplorerPanel activeView={railView} />
        <main style={{ display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--color-surface-0)' }}>
          <TabBar />
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            <Suspense fallback={<div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading…</div>}>
              {tabs.map((tab) => {
                if (!visitedRef.current.has(tab.tabKey)) return null;
                if (tab.kind !== 'module') return null; // dynamic instances render in P3
                const moduleId = tab.tabKey.slice('module:'.length);
                const mod = APP_MODULES.find((m) => m.id === moduleId);
                if (!mod) return null;
                const Component = mod.Component;
                const isActive = tab.tabKey === activeKey;
                return (
                  <div
                    key={tab.tabKey}
                    data-module-id={moduleId}
                    aria-hidden={!isActive}
                    style={{ position: 'absolute', inset: 0, overflow: 'auto', display: isActive ? 'block' : 'none' }}
                  >
                    <Component />
                  </div>
                );
              })}
              {tabs.some((t) => t.kind !== 'module') && (
                <DynamicTabPlaceholder tabKey={activeKey} />
              )}
            </Suspense>
          </div>
        </main>
      </div>

      <StatusBar />
      <TokensPanel open={tokensOpen} onClose={() => setRailView('explorer')} />
      <CommandPaletteMount />
      <FirstRunTip />
    </div>
  );
}

function DynamicTabPlaceholder({ tabKey }: { tabKey: string | null }): React.JSX.Element | null {
  if (!tabKey || tabKey.startsWith('module:')) return null;
  return (
    <div style={{ padding: 48 }}>
      <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>Instance view</h2>
      <p style={{ color: 'var(--color-text-secondary)' }}>
        Dynamic tab <code>{tabKey}</code> — detail view ships in P3. Close this tab and open its
        parent module for now.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/shell/beacon/layout.tsx
git commit -m "feat(app/shell/beacon): add BeaconLayout root (wires rail, panel, tabs, status bar, tokens panel, first-run tip)"
```

---

## Task 15: Wire the feature flag into App.tsx

**Files:**
- Modify: `packages/app/src/App.tsx`

- [ ] **Step 1: Switch between legacy IDELayout and BeaconLayout**

Replace `packages/app/src/App.tsx` with:

```typescript
import * as React from 'react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { trpc, trpcClient } from '@/lib/trpc';
import { IDELayout } from '@/shell/ide-layout';
import { BeaconLayout } from '@/shell/beacon/layout';
import { ThemeProvider } from '@/shell/theme-provider';
import { useShellFlag } from '@/stores/shell-flag';

export function App(): React.JSX.Element {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  );
  const beaconShell = useShellFlag((s) => s.beaconShell);

  return (
    <ThemeProvider>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          {beaconShell ? <BeaconLayout /> : <IDELayout />}
        </QueryClientProvider>
      </trpc.Provider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0.

- [ ] **Step 3: Launch and verify Beacon shell is default**

Run: `bun run --cwd packages/app dev`

Expected:
- New title bar with theme orbs + node selector + command bar breadcrumb.
- 56 px activity rail on the left with Explorer active.
- 280 px Explorer panel showing Workspace/Ops/Models/Knowledge/Observability groups.
- Dashboard tab opens by default.
- Click another group's leaf → opens new tab.
- Middle-click a tab → closes. Right-click → context menu.
- `⌘1`–`⌘9` jump between tabs. `⌘W` closes active. `⌘⇧T` reopens.
- First-run tip appears; Skip dismisses it. Reload → doesn't reappear.
- Tokens rail view → slide-in panel from the right with live values.

- [ ] **Step 4: Verify the flag can roll back**

In DevTools, set `localStorage['beacon-shell-flag']` to `{"state":{"beaconShell":false},"version":0}` and reload. Expected: legacy IDELayout mounts — the old activity-bar-per-module UI. Restore to `true` and reload.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/App.tsx
git commit -m "feat(app): mount BeaconLayout by default, keep IDELayout behind the beacon-shell flag"
```

---

## Task 16: Command palette — add `⌘K` + "Open in tab" routing

**Files:**
- Modify: `packages/app/src/shell/command-palette.tsx`
- Modify: `packages/app/src/shell/commands.ts`

- [ ] **Step 1: Read the existing `commands.ts` and palette hook**

Read `packages/app/src/shell/commands.ts` to confirm the `useAppCommands` signature. (It exists — don't overwrite logic you don't already understand.)

- [ ] **Step 2: Add `⌘K` alongside `⌘⇧P` and route module-go commands through the tab store**

Open `packages/app/src/shell/command-palette.tsx`. Locate `useCommandPaletteOpen` — the hook that installs the `⌘⇧P` keydown handler. Modify the handler so it ALSO opens on `⌘K` (but not when `⌘K⌘T` is being used — preserve the theme picker chord).

Change the keydown handler body to:

```typescript
      // Esc closes.
      if (e.key === 'Escape' && open) {
        setOpen(false);
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      // ⌘⇧P: classic palette open.
      if (e.key === 'P' && e.shiftKey) {
        e.preventDefault();
        setOpen(true);
        return;
      }

      // ⌘K: same palette unless a theme-picker chord is already active
      // (the theme picker's own handler swallows K when it's waiting).
      if (e.key.toLowerCase() === 'k' && !e.shiftKey) {
        // Don't preventDefault — theme picker owns K too. The theme
        // picker's handler runs later via its own listener; it will
        // open its dialog. Here we only open the palette if the
        // theme-picker-chord isn't going to claim it.
        //
        // Simple disambiguation: if the shortcut is ⌘K alone (no
        // follow-up), open the palette after a short debounce. If
        // the follow-up key is T within 1.2s, the theme picker wins.
        //
        // Implementation: defer setOpen by 200 ms — the theme
        // picker's timeout will clear first if the user was going
        // for ⌘K⌘T.
        setTimeout(() => setOpen(true), 220);
      }
```

- [ ] **Step 3: Add "Open in tab" section — route module-go commands through `useTabStore.open`**

Still inside `command-palette.tsx`, find `modulesToCommands`. Replace it with:

```typescript
import { APP_MODULES } from '@/modules/registry';
import { useTabStore } from '@/stores/tab-store';

function modulesToCommands(): Command[] {
  const open = useTabStore.getState().open;
  const setActiveModule = useUIStore.getState().setActiveModule;
  const beaconShell = useShellFlag.getState().beaconShell;
  return APP_MODULES.map((m) => ({
    id: `go:${m.id}`,
    label: `Open ${m.labelKey}`,
    group: groupLabel(m.group),
    hint: m.shortcut ? `⌘${m.shortcut}` : undefined,
    keywords: m.aliases ?? [],
    run: () => {
      if (beaconShell) {
        open({ tabKey: `module:${m.id}`, title: m.labelKey, kind: 'module', openedAt: Date.now() });
      } else {
        setActiveModule(m.id);
      }
    },
  }));
}
```

(If `command-palette.tsx` doesn't already import `useUIStore` and `useShellFlag`, add those imports at the top of the file.)

The existing callers of `modulesToCommands(setActiveModule)` pass the setter in — update call sites to `modulesToCommands()` with no arg, since the function now reads the store directly.

- [ ] **Step 4: Typecheck + manual smoke**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0.

Launch `bun run --cwd packages/app dev`. Verify:
- `⌘⇧P` → palette opens, "Open Dashboard" etc. visible.
- `⌘K` → same palette opens (after a short ~200 ms debounce).
- `⌘K⌘T` → theme picker opens (the chord wins over the ⌘K debounce).
- Pick "Open Dashboard" from the palette → a Dashboard tab opens (or focuses if already open).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/shell/command-palette.tsx
git commit -m "feat(app/palette): add ⌘K alongside ⌘⇧P, route Open commands through tab store"
```

---

## Task 17: Add a Settings toggle for the Beacon shell

**Files:**
- Modify: `packages/app/src/modules/settings/index.tsx` (if it exists — otherwise skip with a note)

- [ ] **Step 1: Check whether Settings has an appropriate slot**

Read `packages/app/src/modules/settings/index.tsx`. Look for an "Appearance" or similar section. If one exists, add the toggle there. If the file is too bare or doesn't exist, create a minimal toggle on top.

- [ ] **Step 2: Add the toggle**

Add near the top of the Settings module body (adjust to match the file's existing style):

```tsx
import { useShellFlag } from '@/stores/shell-flag';

// Inside the component:
const beaconShell = useShellFlag((s) => s.beaconShell);
const setBeaconShell = useShellFlag((s) => s.setBeaconShell);

// In JSX:
<section style={{ padding: 24 }}>
  <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Shell</h3>
  <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--color-text-secondary)' }}>
    <input type="checkbox" checked={beaconShell} onChange={(e) => setBeaconShell(e.target.checked)} />
    Use the new Beacon shell (default). Uncheck to fall back to the legacy layout for one release cycle.
  </label>
</section>
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/modules/settings/index.tsx
git commit -m "feat(app/settings): expose Beacon shell opt-out toggle"
```

---

## Task 18: End-of-phase verification

- [ ] **Step 1: Typecheck**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0.

- [ ] **Step 2: Run every test**

Run: `bun test --cwd packages/app`
Expected: green. New tests from P2 (tab-store, registry-view) pass; carry-forward from P0/P1 still pass.

- [ ] **Step 3: Top-level suite**

Run: `bun run test`
Expected: green.

- [ ] **Step 4: Full E2E smoke against the live app**

Run: `bun run --cwd packages/app dev`
Exercise the golden path (per spec §12):

1. App launches → Dashboard tab open by default, Beacon shell chrome visible.
2. First-run tip appears → click Skip → doesn't reappear on reload.
3. Switch theme via orbs → every pane repaints. `data-theme` on `<html>` updates.
4. Open three tabs from Explorer: Chat, Projects, Logs.
5. Middle-click Projects → closes. `⌘⇧T` reopens.
6. Pin Chat (right-click → Pin) → Chat moves leftmost with pin icon.
7. Close all non-pinned (right-click → Close all) → only Chat left.
8. `⌘K` → palette opens. Pick "Open Nodes" → new tab.
9. Reload window (⌘R). Tabs restore: pinned Chat left, Nodes right, Nodes active.
10. Tokens rail → slide-in panel appears with live token values. Close.
11. Settings → toggle off the Beacon shell → reload → legacy IDELayout mounts. Toggle back on.

- [ ] **Step 5: Cross-repo check (per repo convention)**

Run an integration/smoke pass across llamactl + sirius-gateway + embersynth. Since P2 only touches `packages/app`, this is expected to pass unchanged — run it anyway per the cross-repo-validation feedback rule.

- [ ] **Step 6: Tag**

```bash
git tag beacon-p2
```

---

## Self-review against the spec

- §5.1 TitleBar Layout B — Task 10 ✓
- §5.2 ActivityRail (view modes) — Task 6 ✓; stubs for Search / Sessions / Fleet — Task 8 ✓
- §5.3 ExplorerPanel — Task 8 ✓; ExplorerTree (static + dynamic) — Tasks 4 + 7 ✓
- §5.4 TabBar + tab model — Tasks 1 + 9 ✓; keyboard ⌘1–⌘9 / ⌘W / ⌘⇧T — Task 14 ✓; context menu Pin/Close others/Close all — Task 9 ✓
- §5.5 StatusBar — Task 11 ✓
- §5.6 TokensPanel — Task 12 ✓
- §6 Navigation model — implemented via tab-store + registry-view ✓
- §6.4 Command palette ⌘K binding + "Open in tab" — Task 16 ✓
- §10 `beacon.tabs` / `beacon.tabs.active` / `beacon.tabs.closed` / `beacon.rail.view` — tab-store persist + layout effect ✓
- §14 Feature flag `beacon.shell.v3` + Settings toggle — Tasks 2 + 15 + 17 ✓
- §14 First-run tip overlay — Task 13 ✓

Deferred to P3:
- `beacon.explorer.collapsed` persistence (spec §10) — Explorer uses local state in P2; persist comes in P3 when the tree settles.
- Real Search / Sessions / Fleet rail views — P2 ships stubs.
- Dynamic instance tab bodies (workload/node/ops-session detail components) — P2 shows a placeholder; P3 builds the components.
- Flattening `*-tabbed` modules — P3.
- Module adoption of `@/ui` primitives — P3.
- Removing legacy token aliases (`--color-fg`, etc.) — end of P3.
- Removing `IDELayout` + `shell-flag` store — end of P3.
