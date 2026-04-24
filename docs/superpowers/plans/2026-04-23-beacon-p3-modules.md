# Beacon P3 — Module Flattening + Editorial Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Beacon renewal. Flatten every `*-tabbed` module so each former sub-tab is its own Explorer leaf. Wire dynamic tab components (workload / node / ops-session detail views). Persist Explorer collapse state. Apply primitives and editorial treatment to the top modules. Build the real Search / Sessions / Fleet rail views. Retire the legacy shell, the feature flag, the legacy theme migration, and the legacy token aliases.

**Architecture:** Each former `*-tabbed` wrapper is deleted; its children are promoted to top-level module entries in the registry. Dynamic tab components (`WorkloadDetail`, `NodeDetail`, `OpsSessionDetail`) live under `modules/ops/detail/`, keyed by the `tabKey` prefix — `BeaconLayout` dispatches based on prefix. A new `explorer-collapse-store` persists per-group collapse state. The legacy IDELayout, `shell-flag` store, `ThemePickerButton`, and legacy token aliases are removed in a final cleanup task.

**Tech Stack:** Same as P2. No new dependencies.

---

## File Structure

Create:
- `packages/app/src/stores/explorer-collapse-store.ts` — persisted Explorer collapse state
- `packages/app/src/modules/ops/detail/workload-detail.tsx` — dynamic tab component
- `packages/app/src/modules/ops/detail/node-detail.tsx`
- `packages/app/src/modules/ops/detail/ops-session-detail.tsx`
- `packages/app/src/modules/ops/detail/index.ts` — barrel exporting the three detail components + tab-kind dispatcher
- `packages/app/src/shell/beacon/dynamic-tab-router.tsx` — routes a non-module tabKey to the right detail component
- `packages/app/src/shell/beacon/search-view.tsx` — real Search rail view
- `packages/app/src/shell/beacon/sessions-view.tsx` — real Sessions rail view
- `packages/app/src/shell/beacon/fleet-view.tsx` — real Fleet rail view
- `packages/app/test/stores/explorer-collapse-store.test.ts`

Move / rename (per flattening plan):
- `packages/app/src/modules/ops-tabbed/*` → promote children to `modules/ops-chat/` (already exists) + `modules/plan/` (already exists)
- `packages/app/src/modules/models-tabbed/*` → promote to `modules/models/catalog/`, `modules/models/presets/`, `modules/models/pulls/`, `modules/models/bench/`, `modules/models/lmstudio/`, `modules/models/server/`
- `packages/app/src/modules/knowledge-tabbed/*` → promote to `modules/knowledge/retrieval/`, `modules/knowledge/pipelines/`
- `packages/app/src/modules/workloads-tabbed/*` → promote to `modules/workloads/model-runs/`, `modules/workloads/composites/`

Modify:
- `packages/app/src/modules/registry.ts` — replace the four `*-tabbed` entries with the flattened children
- `packages/app/src/shell/beacon/layout.tsx` — render dynamic tabs via `dynamic-tab-router`; read collapse state from the store
- `packages/app/src/shell/beacon/explorer-tree.tsx` — read/write collapse state from the store
- `packages/app/src/shell/beacon/explorer-panel.tsx` — mount real Search/Sessions/Fleet views
- `packages/app/src/App.tsx` — remove `useShellFlag` switch, always mount BeaconLayout
- `packages/app/src/stores/theme-store.ts` — remove the legacy `readLegacyAndClear` migration
- `packages/app/src/themes/tokens.css` — remove the legacy aliases block
- `packages/app/src/modules/dashboard/index.tsx` — adopt EditorialHero for landing state
- `packages/app/src/shell/title-bar.tsx` — legacy; update its ThemePickerButton usage to ThemeOrbs or delete

Delete:
- `packages/app/src/shell/tabbed-module.tsx`
- `packages/app/src/shell/ide-layout.tsx`
- `packages/app/src/shell/title-bar.tsx` (legacy; Beacon has its own)
- `packages/app/src/shell/activity-bar.tsx` (legacy)
- `packages/app/src/shell/status-bar.tsx` (legacy)
- `packages/app/src/stores/shell-flag.ts`
- `packages/app/src/shell/theme-picker.tsx` — `ThemePicker` dialog kept (palette-triggered), `ThemePickerButton` removed
- `packages/app/src/modules/ops-tabbed/`, `models-tabbed/`, `knowledge-tabbed/`, `workloads-tabbed/` — all four directories

---

## Task 1: Explorer collapse store + tests

**Files:**
- Create: `packages/app/src/stores/explorer-collapse-store.ts`
- Create: `packages/app/test/stores/explorer-collapse-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/app/test/stores/explorer-collapse-store.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { useExplorerCollapse } from '../../src/stores/explorer-collapse-store';

beforeEach(() => {
  useExplorerCollapse.setState({ collapsed: {} });
});

describe('explorer-collapse-store', () => {
  test('isCollapsed returns false by default', () => {
    expect(useExplorerCollapse.getState().isCollapsed('workspace')).toBe(false);
  });

  test('toggle flips the flag', () => {
    useExplorerCollapse.getState().toggle('ops');
    expect(useExplorerCollapse.getState().isCollapsed('ops')).toBe(true);
    useExplorerCollapse.getState().toggle('ops');
    expect(useExplorerCollapse.getState().isCollapsed('ops')).toBe(false);
  });

  test('set overrides the flag', () => {
    useExplorerCollapse.getState().set('models', true);
    expect(useExplorerCollapse.getState().isCollapsed('models')).toBe(true);
    useExplorerCollapse.getState().set('models', false);
    expect(useExplorerCollapse.getState().isCollapsed('models')).toBe(false);
  });

  test('keys are independent', () => {
    useExplorerCollapse.getState().set('workspace', true);
    expect(useExplorerCollapse.getState().isCollapsed('workspace')).toBe(true);
    expect(useExplorerCollapse.getState().isCollapsed('ops')).toBe(false);
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test --cwd packages/app test/stores/explorer-collapse-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/app/src/stores/explorer-collapse-store.ts`:

```typescript
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Persisted per-user Explorer collapse state. Keys are free-form
 * strings — callers use one key per collapsible row (group ids like
 * `workspace`, or composite keys like `ops/workloads` for dynamic
 * sub-groups). Default = not collapsed.
 */
interface Store {
  collapsed: Record<string, boolean>;
  isCollapsed: (key: string) => boolean;
  toggle: (key: string) => void;
  set: (key: string, value: boolean) => void;
}

export const useExplorerCollapse = create<Store>()(
  persist(
    (set, get) => ({
      collapsed: {},
      isCollapsed: (key) => get().collapsed[key] === true,
      toggle: (key) => set((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } })),
      set: (key, value) => set((s) => ({ collapsed: { ...s.collapsed, [key]: value } })),
    }),
    { name: 'beacon-explorer-collapsed', version: 1 },
  ),
);
```

- [ ] **Step 4: Run tests**

Run: `bun test --cwd packages/app test/stores/explorer-collapse-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the store into `explorer-tree.tsx`**

Edit `packages/app/src/shell/beacon/explorer-tree.tsx`. Replace the `useState<Record<string, boolean>>` collapse management with the store:

```typescript
import { useExplorerCollapse } from '@/stores/explorer-collapse-store';

// Inside the component — remove `const [collapsed, setCollapsed] = useState(...)`
const collapsed = useExplorerCollapse((s) => s.collapsed);
const toggleCollapse = useExplorerCollapse((s) => s.toggle);

// Replace every `collapsed[group.id] === true` with `collapsed[group.id] === true` (no change)
// Replace every `setCollapsed((c) => ({ ...c, [key]: !c[key] }))` with `toggleCollapse(key)`
```

- [ ] **Step 6: Verify collapse state persists across reloads**

Run: `bun run --cwd packages/app dev`
- Collapse the Ops group → reload → it stays collapsed.
- Expand a dynamic leaf (double-click Workloads) → reload → stays expanded.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/stores/explorer-collapse-store.ts packages/app/test/stores/explorer-collapse-store.test.ts packages/app/src/shell/beacon/explorer-tree.tsx
git commit -m "feat(app): persist Explorer collapse state across sessions"
```

---

## Task 2: Flatten ops-tabbed

**Files:**
- Delete: `packages/app/src/modules/ops-tabbed/`
- Modify: `packages/app/src/modules/registry.ts`

Background: `ops-tabbed` bundles two sub-tabs — `Ops Chat` (mapped to `modules/ops-chat/`) and `Planner` (mapped to `modules/plan/`). Both child modules already exist as full modules.

- [ ] **Step 1: Read the `ops-tabbed` entry**

Open `packages/app/src/modules/ops-tabbed/index.tsx`. Confirm its sub-tabs are indeed `ops-chat` (→ `OpsChatTab`) and `plan` (→ `PlanTab`), and that both source components live under `modules/ops-chat/index.tsx` and `modules/plan/index.tsx`.

- [ ] **Step 2: Update the registry**

In `packages/app/src/modules/registry.ts`:

1. Delete the `LazyOpsPage = lazy(() => import('./ops-tabbed/index'));` line.
2. Add two new lazy imports:
   ```typescript
   const LazyOpsChat = lazy(() => import('./ops-chat/index'));
   const LazyPlan = lazy(() => import('./plan/index'));
   ```
3. Delete the `ops-chat` entry in `APP_MODULES` that currently uses `Component: LazyOpsPage`. Replace with two entries:

```typescript
  {
    id: 'ops-chat',
    labelKey: 'Ops Chat',
    icon: Terminal,
    Component: LazyOpsChat,
    shortcut: 3,
    activityBar: true,
    group: 'ops',
    aliases: ['operator console', 'operator'],
    beaconGroup: 'ops',
    beaconKind: 'static',
    beaconOrder: 10,
  },
  {
    id: 'plan',
    labelKey: 'Planner',
    icon: Terminal,
    Component: LazyPlan,
    activityBar: false,
    group: 'ops',
    aliases: ['plan', 'planner'],
    beaconGroup: 'ops',
    beaconKind: 'static',
    beaconOrder: 15,
  },
```

4. Remove the comment about `ops-tabbed` and `planner: subsumed by ops-chat` in the registry header prose — those notes are now stale.

- [ ] **Step 3: Delete the wrapper directory**

Run: `git rm -r packages/app/src/modules/ops-tabbed`

- [ ] **Step 4: Handle the sub-tab index if needed**

`modules/ops-chat/index.tsx` and `modules/plan/index.tsx` may have been re-exporting something the tabbed wrapper needed. Read both — if they do nothing beyond default-export the component, no change is needed. If they read a `tabs=[...]` prop from a parent, strip that down to a plain component.

- [ ] **Step 5: Typecheck + smoke**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0.

Launch the app: Explorer should now show `Ops Chat` and `Planner` as two separate leaves under the Ops group. Opening `Planner` opens its own tab.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/modules/registry.ts
git rm -r packages/app/src/modules/ops-tabbed
git commit -m "refactor(app): flatten ops-tabbed — promote Ops Chat + Planner to top-level modules"
```

---

## Task 3: Flatten models-tabbed

**Files:**
- Delete: `packages/app/src/modules/models-tabbed/`
- Modify: `packages/app/src/modules/registry.ts`

Sub-tabs from the current wrapper: `catalog`, `presets`, `pulls`, `bench`, `lmstudio`, `server`. Child components already live under `modules/models/catalog/`, `modules/models/presets/`, etc. (or equivalent; verify path in step 1).

- [ ] **Step 1: Locate each child component**

For each sub-tab id, find its source component:

```
bash: rg -n "export default" packages/app/src/modules/models-tabbed/
```

The wrapper imports them as `CatalogTab`, `PresetsTab`, etc. — trace the import path to find each source file. Expect paths like `./catalog`, `../models/catalog`, etc.

- [ ] **Step 2: Promote each child to its own registry entry**

In `packages/app/src/modules/registry.ts`:

1. Delete `const LazyModelsPage = lazy(() => import('./models-tabbed/index'));`
2. Add:
```typescript
const LazyModelsCatalog = lazy(() => import('./models/catalog'));
const LazyModelsPresets = lazy(() => import('./models/presets'));
const LazyModelsPulls   = lazy(() => import('./models/pulls'));
const LazyModelsBench   = lazy(() => import('./models/bench'));
const LazyModelsLMStudio= lazy(() => import('./models/lmstudio'));
const LazyModelsServer  = lazy(() => import('./models/server'));
```
(Adjust the import paths based on Step 1's findings. If the source files live under `modules/models-tabbed/children/`, move each one to `modules/models/<sub-id>/index.tsx` first via `git mv` — see step 3.)

3. Delete the `models` entry from `APP_MODULES`. Replace with six entries:

```typescript
  {
    id: 'models.catalog',
    labelKey: 'Catalog',
    icon: Database,
    Component: LazyModelsCatalog,
    activityBar: false,
    group: 'models',
    aliases: ['models catalog'],
    beaconGroup: 'models',
    beaconKind: 'static',
    beaconOrder: 10,
  },
  {
    id: 'models.presets',
    labelKey: 'Presets',
    icon: Database,
    Component: LazyModelsPresets,
    activityBar: false,
    group: 'models',
    beaconGroup: 'models',
    beaconKind: 'static',
    beaconOrder: 20,
  },
  {
    id: 'models.pulls',
    labelKey: 'Pulls',
    icon: Database,
    Component: LazyModelsPulls,
    activityBar: false,
    group: 'models',
    beaconGroup: 'models',
    beaconKind: 'static',
    beaconOrder: 30,
  },
  {
    id: 'models.bench',
    labelKey: 'Bench',
    icon: Database,
    Component: LazyModelsBench,
    activityBar: false,
    group: 'models',
    beaconGroup: 'models',
    beaconKind: 'static',
    beaconOrder: 40,
  },
  {
    id: 'models.lmstudio',
    labelKey: 'LM Studio',
    icon: Database,
    Component: LazyModelsLMStudio,
    activityBar: false,
    group: 'models',
    beaconGroup: 'models',
    beaconKind: 'static',
    beaconOrder: 50,
  },
  {
    id: 'models.server',
    labelKey: 'Server',
    icon: Database,
    Component: LazyModelsServer,
    activityBar: false,
    group: 'models',
    beaconGroup: 'models',
    beaconKind: 'static',
    beaconOrder: 60,
  },
```

- [ ] **Step 3: Move source files if needed**

For each child whose source lives inside `models-tabbed/`, move it:

```bash
mkdir -p packages/app/src/modules/models/{catalog,presets,pulls,bench,lmstudio,server}
git mv packages/app/src/modules/models-tabbed/catalog.tsx packages/app/src/modules/models/catalog/index.tsx
# repeat for each child…
```

Strip each file down to a plain component (no tab-wrapper-specific props).

- [ ] **Step 4: Delete the wrapper**

```bash
git rm -r packages/app/src/modules/models-tabbed
```

- [ ] **Step 5: Typecheck + smoke**

`bun run --cwd packages/app typecheck` → exits 0. Launch → Explorer shows Models → Catalog / Presets / Pulls / Bench / LM Studio / Server as six separate leaves.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/modules/registry.ts packages/app/src/modules/models
git rm -r packages/app/src/modules/models-tabbed
git commit -m "refactor(app): flatten models-tabbed — six top-level models.* modules"
```

---

## Task 4: Flatten knowledge-tabbed

**Files:**
- Delete: `packages/app/src/modules/knowledge-tabbed/`
- Modify: `packages/app/src/modules/registry.ts`

Sub-tabs: `retrieval`, `pipelines`.

- [ ] **Step 1: Apply the same flattening pattern as Task 3**

In `registry.ts`:

1. Delete `const LazyKnowledgePage = lazy(() => import('./knowledge-tabbed/index'));`
2. Add:
   ```typescript
   const LazyKnowledgeRetrieval = lazy(() => import('./knowledge/retrieval'));
   const LazyKnowledgePipelines = lazy(() => import('./knowledge/pipelines'));
   ```
3. Delete the `knowledge` entry. Replace with:

```typescript
  {
    id: 'knowledge.retrieval',
    labelKey: 'Retrieval',
    icon: Brain,
    Component: LazyKnowledgeRetrieval,
    activityBar: false,
    group: 'core',
    aliases: ['rag', 'retrieval'],
    beaconGroup: 'knowledge',
    beaconKind: 'static',
    beaconOrder: 10,
  },
  {
    id: 'knowledge.pipelines',
    labelKey: 'Pipelines',
    icon: Brain,
    Component: LazyKnowledgePipelines,
    activityBar: false,
    group: 'core',
    aliases: ['ingest', 'pipelines'],
    beaconGroup: 'knowledge',
    beaconKind: 'static',
    beaconOrder: 20,
  },
```

- [ ] **Step 2: Move source files**

```bash
mkdir -p packages/app/src/modules/knowledge/{retrieval,pipelines}
# git mv from knowledge-tabbed/<child>.tsx to knowledge/<child>/index.tsx
```

- [ ] **Step 3: Delete the wrapper**

```bash
git rm -r packages/app/src/modules/knowledge-tabbed
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/modules/registry.ts packages/app/src/modules/knowledge
git rm -r packages/app/src/modules/knowledge-tabbed
git commit -m "refactor(app): flatten knowledge-tabbed — Retrieval + Pipelines as top-level modules"
```

---

## Task 5: Flatten workloads-tabbed

**Files:**
- Delete: `packages/app/src/modules/workloads-tabbed/`
- Modify: `packages/app/src/modules/registry.ts`

Sub-tabs: `workloads` (labelled "Model Runs"), `composites`.

**Special case:** `workloads` is the dynamic-group leaf in the Explorer tree — see `registry-view.ts`. Keep the group itself as `id: 'workloads'` with `beaconKind: 'dynamic-group'` so the Explorer can hang live instances under it; the "Model Runs" list view becomes a child leaf `workloads.model-runs`.

- [ ] **Step 1: Apply the pattern**

In `registry.ts`:

1. Delete `const LazyWorkloadsPage = lazy(() => import('./workloads-tabbed/index'));`
2. Add:
   ```typescript
   const LazyWorkloadsList = lazy(() => import('./workloads/list'));
   const LazyWorkloadsComposites = lazy(() => import('./workloads/composites'));
   const LazyWorkloadsPlaceholder = lazy(() => import('./workloads/placeholder'));
   ```
3. Update the existing `workloads` entry — change its `Component` to `LazyWorkloadsPlaceholder` (the group itself doesn't render a list anymore; opening the leaf opens a placeholder that reads "open a specific workload from the Explorer, or see the Model Runs list"). Keep `beaconKind: 'dynamic-group'`.
4. Add two new entries:

```typescript
  {
    id: 'workloads.model-runs',
    labelKey: 'Model Runs',
    icon: Layers,
    Component: LazyWorkloadsList,
    activityBar: false,
    group: 'ops',
    beaconGroup: 'ops',
    beaconKind: 'static',
    beaconOrder: 22,
  },
  {
    id: 'workloads.composites',
    labelKey: 'Composites',
    icon: Layers,
    Component: LazyWorkloadsComposites,
    activityBar: false,
    group: 'ops',
    aliases: ['composites'],
    beaconGroup: 'ops',
    beaconKind: 'static',
    beaconOrder: 24,
  },
```

- [ ] **Step 2: Create the placeholder + move children**

```bash
mkdir -p packages/app/src/modules/workloads/{list,composites,placeholder}
# git mv workloads-tabbed/workloads.tsx → workloads/list/index.tsx
# git mv workloads-tabbed/composites.tsx → workloads/composites/index.tsx
```

Create `packages/app/src/modules/workloads/placeholder/index.tsx`:

```typescript
import * as React from 'react';

export default function WorkloadsPlaceholder(): React.JSX.Element {
  return (
    <div style={{ padding: 48, color: 'var(--color-text-secondary)' }}>
      <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>Workloads</h2>
      <p>Expand this group in the Explorer to pick a specific workload, or open <strong>Model Runs</strong> for the full list.</p>
    </div>
  );
}
```

- [ ] **Step 3: Delete the wrapper**

```bash
git rm -r packages/app/src/modules/workloads-tabbed
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/modules/registry.ts packages/app/src/modules/workloads
git rm -r packages/app/src/modules/workloads-tabbed
git commit -m "refactor(app): flatten workloads-tabbed — Model Runs + Composites as leaves, Workloads stays a dynamic group"
```

---

## Task 6: Delete the legacy tabbed-module wrapper

**Files:**
- Delete: `packages/app/src/shell/tabbed-module.tsx`

- [ ] **Step 1: Confirm there are no remaining callers**

Run: `rg "tabbed-module" packages/app/src`
Expected: zero matches. If any remain, resolve those first.

- [ ] **Step 2: Delete**

```bash
git rm packages/app/src/shell/tabbed-module.tsx
```

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(app): delete legacy shell/tabbed-module.tsx"
```

---

## Task 7: WorkloadDetail dynamic tab component

**Files:**
- Create: `packages/app/src/modules/ops/detail/workload-detail.tsx`

- [ ] **Step 1: Implement a useful-enough detail view**

Create `packages/app/src/modules/ops/detail/workload-detail.tsx`:

```typescript
import * as React from 'react';
import { Badge, Card, StatCard, StatusDot } from '@/ui';
import { trpc } from '@/lib/trpc';

interface Props {
  workloadId: string;
}

/**
 * Detail surface for a single workload. Subscribes to the live status
 * query for this id, renders phase + model + stats + recent log
 * entries. Minimal v1 — ops chat can deep-link into this and the
 * view earns its keep even without every field populated.
 */
export function WorkloadDetail({ workloadId }: Props): React.JSX.Element {
  const workloads = trpc.workloadList.useQuery(undefined, { refetchInterval: 5_000 });
  const row = (workloads.data ?? []).find((w: { name?: string }) => w.name === workloadId) as
    | { name?: string; phase?: string; modelRef?: string; node?: string; tokensPerSec?: number }
    | undefined;

  if (!row) {
    return (
      <div style={{ padding: 48, color: 'var(--color-text-secondary)' }}>
        <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>Workload {workloadId}</h2>
        <p>Not in the current workload list. It may have finished or been removed.</p>
      </div>
    );
  }

  const tone = row.phase === 'Running' ? 'ok' : row.phase === 'Failed' ? 'err' : 'warn';

  return (
    <div style={{ padding: 48, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 24 }}>
        <h2 style={{ fontSize: 28, margin: 0, fontWeight: 600 }}>{row.name}</h2>
        <StatusDot tone={tone} label={row.phase ?? 'unknown'} pulse={tone === 'ok'} />
        {row.modelRef && <Badge variant="brand">{row.modelRef}</Badge>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 32 }}>
        <StatCard label="Phase" value={row.phase ?? '—'} />
        <StatCard label="Node" value={row.node ?? '—'} />
        <StatCard label="t/s" value={row.tokensPerSec ? row.tokensPerSec.toFixed(1) : '—'} unit={row.tokensPerSec ? 't/s' : undefined} />
        <StatCard label="Model" value={row.modelRef ?? '—'} />
      </div>

      <Card>
        <h3 style={{ fontSize: 15, margin: '0 0 12px' }}>Raw</h3>
        <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-secondary)', background: 'var(--color-surface-2)', padding: 16, borderRadius: 'var(--r-md)', overflow: 'auto' }}>
          {JSON.stringify(row, null, 2)}
        </pre>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/modules/ops/detail/workload-detail.tsx
git commit -m "feat(app/modules/ops): add WorkloadDetail dynamic tab component"
```

---

## Task 8: NodeDetail dynamic tab component

**Files:**
- Create: `packages/app/src/modules/ops/detail/node-detail.tsx`

- [ ] **Step 1: Implement**

Create `packages/app/src/modules/ops/detail/node-detail.tsx`:

```typescript
import * as React from 'react';
import { Badge, Card, StatCard, StatusDot } from '@/ui';
import { trpc } from '@/lib/trpc';

interface Props {
  nodeName: string;
}

export function NodeDetail({ nodeName }: Props): React.JSX.Element {
  const list = trpc.nodeList.useQuery(undefined, { refetchInterval: 15_000 });
  const node = (list.data?.nodes ?? []).find((n: { name: string }) => n.name === nodeName) as
    | { name: string; effectiveKind?: string; endpoint?: string; version?: string; phase?: string }
    | undefined;

  if (!node) {
    return (
      <div style={{ padding: 48, color: 'var(--color-text-secondary)' }}>
        <h2 style={{ fontSize: 20, margin: '0 0 8px' }}>Node {nodeName}</h2>
        <p>Not in the current cluster map.</p>
      </div>
    );
  }

  const tone = node.phase === 'Ready' || !node.phase ? 'ok' : 'warn';

  return (
    <div style={{ padding: 48, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 24 }}>
        <h2 style={{ fontSize: 28, margin: 0, fontWeight: 600 }}>{node.name}</h2>
        <StatusDot tone={tone} label={node.phase ?? 'ready'} pulse={tone === 'ok'} />
        <Badge variant="default">{node.effectiveKind ?? 'agent'}</Badge>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 32 }}>
        <StatCard label="Kind" value={node.effectiveKind ?? 'agent'} />
        <StatCard label="Endpoint" value={node.endpoint ?? '—'} />
        <StatCard label="Version" value={node.version ?? '—'} />
      </div>

      <Card>
        <h3 style={{ fontSize: 15, margin: '0 0 12px' }}>Raw</h3>
        <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-secondary)', background: 'var(--color-surface-2)', padding: 16, borderRadius: 'var(--r-md)', overflow: 'auto' }}>
          {JSON.stringify(node, null, 2)}
        </pre>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/app/src/modules/ops/detail/node-detail.tsx
git commit -m "feat(app/modules/ops): add NodeDetail dynamic tab component"
```

---

## Task 9: OpsSessionDetail stub

**Files:**
- Create: `packages/app/src/modules/ops/detail/ops-session-detail.tsx`
- Create: `packages/app/src/modules/ops/detail/index.ts`

- [ ] **Step 1: Create the stub**

Create `packages/app/src/modules/ops/detail/ops-session-detail.tsx`:

```typescript
import * as React from 'react';

interface Props {
  sessionId: string;
}

/** Placeholder — full session replay lands later. Renders the id and
 *  a hint so the tab isn't empty. */
export function OpsSessionDetail({ sessionId }: Props): React.JSX.Element {
  return (
    <div style={{ padding: 48, maxWidth: 1100, margin: '0 auto' }}>
      <h2 style={{ fontSize: 28, margin: '0 0 8px', fontWeight: 600 }}>Ops session {sessionId}</h2>
      <p style={{ color: 'var(--color-text-secondary)' }}>
        Session replay + timeline ship post-renewal. For now, the session tab serves as a stable
        anchor you can pin and return to.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Create the barrel**

Create `packages/app/src/modules/ops/detail/index.ts`:

```typescript
export { WorkloadDetail } from './workload-detail';
export { NodeDetail } from './node-detail';
export { OpsSessionDetail } from './ops-session-detail';
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/modules/ops/detail/ops-session-detail.tsx packages/app/src/modules/ops/detail/index.ts
git commit -m "feat(app/modules/ops): add OpsSessionDetail stub + ops/detail barrel"
```

---

## Task 10: Dynamic tab router + BeaconLayout wiring

**Files:**
- Create: `packages/app/src/shell/beacon/dynamic-tab-router.tsx`
- Modify: `packages/app/src/shell/beacon/layout.tsx`

- [ ] **Step 1: Create the router**

Create `packages/app/src/shell/beacon/dynamic-tab-router.tsx`:

```typescript
import * as React from 'react';
import { WorkloadDetail, NodeDetail, OpsSessionDetail } from '@/modules/ops/detail';
import type { TabEntry } from '@/stores/tab-store';

/**
 * Render the right dynamic detail component for a non-module tab.
 * Dispatches based on the `tabKey` prefix (matches the keys
 * ExplorerTree emits).
 */
export function DynamicTabRouter({ tab }: { tab: TabEntry }): React.JSX.Element | null {
  if (tab.kind === 'workload' && tab.instanceId) {
    return <WorkloadDetail workloadId={tab.instanceId} />;
  }
  if (tab.kind === 'node' && tab.instanceId) {
    return <NodeDetail nodeName={tab.instanceId} />;
  }
  if (tab.kind === 'ops-session' && tab.instanceId) {
    return <OpsSessionDetail sessionId={tab.instanceId} />;
  }
  return null;
}
```

- [ ] **Step 2: Replace the placeholder in BeaconLayout**

Edit `packages/app/src/shell/beacon/layout.tsx`. In the main render, replace the current `tabs.some((t) => t.kind !== 'module')` + `DynamicTabPlaceholder` block with:

```typescript
{tabs.filter((t) => t.kind !== 'module').map((tab) => {
  if (!visitedRef.current.has(tab.tabKey)) return null;
  const isActive = tab.tabKey === activeKey;
  return (
    <div
      key={tab.tabKey}
      data-tab-key={tab.tabKey}
      aria-hidden={!isActive}
      style={{ position: 'absolute', inset: 0, overflow: 'auto', display: isActive ? 'block' : 'none' }}
    >
      <DynamicTabRouter tab={tab} />
    </div>
  );
})}
```

And remove the now-unused `DynamicTabPlaceholder` helper at the bottom of the file. Add `import { DynamicTabRouter } from './dynamic-tab-router';` to the top.

- [ ] **Step 3: Typecheck + smoke**

`bun run --cwd packages/app typecheck` → exits 0.

Launch → expand Workloads in the Explorer → click a live workload → opens a tab with the WorkloadDetail view. Same for a node.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/shell/beacon/dynamic-tab-router.tsx packages/app/src/shell/beacon/layout.tsx
git commit -m "feat(app/shell/beacon): route dynamic tabs through DynamicTabRouter"
```

---

## Task 11: Dashboard editorial hero

**Files:**
- Modify: `packages/app/src/modules/dashboard/index.tsx`

- [ ] **Step 1: Read the current Dashboard**

Open `packages/app/src/modules/dashboard/index.tsx`. Identify the top section — if there's a landing "welcome" or empty-state block, replace it with `EditorialHero`. If the dashboard is always populated (stats grid, etc.), add a compact `EditorialHero` above the grid with a tighter title size.

- [ ] **Step 2: Add the hero**

At the top of the returned JSX, insert:

```tsx
import { EditorialHero } from '@/ui';

<EditorialHero
  eyebrow="Dashboard"
  title="Your fleet"
  titleAccent="at a glance"
  lede="Nodes, workloads, and cost — in one view. Pin a workload or open a specific node from the Explorer to dig in."
  pills={[
    { label: 'healthy', tone: 'ok' },
    { label: 'Beacon', tone: 'info' },
  ]}
/>
```

Place it above the existing content; preserve everything below it.

- [ ] **Step 3: Typecheck + smoke**

`bun run --cwd packages/app typecheck` → exits 0. Launch → Dashboard shows the editorial hero with serif title; the rest of the dashboard renders below unchanged.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/modules/dashboard/index.tsx
git commit -m "feat(app/dashboard): add EditorialHero landing treatment"
```

---

## Task 12: Primitive adoption playbook + reference migration (Chat, Logs, Projects)

**Files:**
- Modify: `packages/app/src/modules/chat/index.tsx`
- Modify: `packages/app/src/modules/logs/index.tsx`
- Modify: `packages/app/src/modules/projects/index.tsx`

This task seeds the migration pattern. Remaining modules adopt primitives incrementally in follow-up PRs — full coverage is not a P3 gating requirement; three high-traffic references is.

- [ ] **Step 1: Playbook — find-and-replace patterns**

For each target module, apply these substitutions (read the file first; don't rewrite code you don't understand):

| Find                                                                | Replace with                          |
|---------------------------------------------------------------------|---------------------------------------|
| `<button type="button" class="... text-xs ...">`                    | `<Button variant="secondary" size="sm">` |
| `<span class="... rounded bg-[color-mix…] text-xs …">`              | `<Badge variant="…">`                 |
| Inline keyboard shortcut spans (`<span class="border-b-2 …">K</span>`) | `<Kbd>K</Kbd>`                     |
| Inline status dots (`<span class="h-2 w-2 rounded-full bg-...">`)   | `<StatusDot tone="ok|warn|err|idle" />` |
| Inline input with manual focus styles                                | `<Input>`                             |
| Empty-state hero blocks                                              | `<EditorialHero>` (for full-bleed) or `<AtmosphericPanel>` (for inline) |

The `@/ui` primitives consume Beacon tokens directly — no theme-flip edge cases to chase during migration.

- [ ] **Step 2: Migrate `modules/chat/index.tsx`**

Read the current file. Replace inline button/badge/input markup with `@/ui` primitives per the playbook. Leave layout, data flow, and stream handling untouched.

Typecheck after each change: `bun run --cwd packages/app typecheck` → exits 0.

- [ ] **Step 3: Migrate `modules/logs/index.tsx`**

Same pattern. Logs is data-dense — only replace chrome primitives (search box → `Input`, filter chips → `Badge`), do not touch the virtualized list or row rendering.

- [ ] **Step 4: Migrate `modules/projects/index.tsx`**

Projects has a meaningful empty state today — replace the empty-state block with `<EditorialHero title="New project" titleAccent="starts here" lede="…">` and a `<Button variant="primary" size="lg">Create project</Button>` as the action. Keep the list layout once a project exists.

- [ ] **Step 5: Manual smoke test across all three**

Launch the app, open each of the three migrated modules in every theme, confirm no visual regressions.

- [ ] **Step 6: Commit each migration separately**

```bash
git add packages/app/src/modules/chat
git commit -m "refactor(app/chat): adopt @/ui primitives"

git add packages/app/src/modules/logs
git commit -m "refactor(app/logs): adopt @/ui primitives"

git add packages/app/src/modules/projects
git commit -m "refactor(app/projects): adopt @/ui primitives + editorial empty state"
```

Note: the remaining modules (dashboard's stats grid, nodes, models, knowledge, workloads, cost, settings, server, etc.) adopt primitives in follow-up PRs as each surface is touched. P3 does not block on full coverage.

---

## Task 13: Real Search rail view

**Files:**
- Create: `packages/app/src/shell/beacon/search-view.tsx`
- Modify: `packages/app/src/shell/beacon/explorer-panel.tsx`

- [ ] **Step 1: Create the component**

Create `packages/app/src/shell/beacon/search-view.tsx`:

```typescript
import * as React from 'react';
import { Input, TreeItem, Kbd } from '@/ui';
import { Search as SearchIcon } from 'lucide-react';
import { APP_MODULES } from '@/modules/registry';
import { useTabStore } from '@/stores/tab-store';

/**
 * Global search across static modules. Rank by substring match in
 * labelKey + aliases. Selecting a row opens it as a tab. Live
 * workloads/nodes are not in scope yet — follow-up once there's a
 * single "search-everything" query.
 */
export function SearchView(): React.JSX.Element {
  const [q, setQ] = React.useState('');
  const open = useTabStore((s) => s.open);

  const results = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return APP_MODULES
      .filter((m) => m.beaconGroup && m.beaconGroup !== 'hidden')
      .map((m) => {
        const hay = [m.labelKey, ...(m.aliases ?? []), m.id].join(' ').toLowerCase();
        return { m, score: hay.includes(needle) ? (m.labelKey.toLowerCase().startsWith(needle) ? 2 : 1) : 0 };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.m.labelKey.localeCompare(b.m.labelKey))
      .slice(0, 30);
  }, [q]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px' }}>
        <Input
          leadingSlot={<SearchIcon size={12} />}
          placeholder="Search modules…"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          autoFocus
        />
      </div>
      <div style={{ padding: '0 0 12px', overflowY: 'auto', flex: 1 }}>
        {q.trim() === '' && (
          <div style={{ padding: '12px 18px', color: 'var(--color-text-tertiary)', fontSize: 12, lineHeight: 1.6 }}>
            Type to search modules. For fuzzy matching with aliases, the command palette (<Kbd compact>⌘⇧P</Kbd>) is still the pro move.
          </div>
        )}
        {results.map(({ m }) => (
          <TreeItem
            key={m.id}
            label={m.labelKey}
            trailing={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)' }}>{m.beaconGroup}</span>}
            onClick={() => open({ tabKey: `module:${m.id}`, title: m.labelKey, kind: 'module', openedAt: Date.now() })}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into ExplorerPanel**

In `packages/app/src/shell/beacon/explorer-panel.tsx`, replace the `SearchStub` helper with:

```typescript
import { SearchView } from './search-view';

// … and in the switch:
{activeView === 'search' && <SearchView />}
```

Remove the `SearchStub` function.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/shell/beacon/search-view.tsx packages/app/src/shell/beacon/explorer-panel.tsx
git commit -m "feat(app/shell/beacon): add real Search rail view (module index search)"
```

---

## Task 14: Real Sessions rail view

**Files:**
- Create: `packages/app/src/shell/beacon/sessions-view.tsx`
- Modify: `packages/app/src/shell/beacon/explorer-panel.tsx`

- [ ] **Step 1: Create the component**

Create `packages/app/src/shell/beacon/sessions-view.tsx`:

```typescript
import * as React from 'react';
import { TreeItem } from '@/ui';
import { useTabStore } from '@/stores/tab-store';

/**
 * Recent tabs, grouped by "today / earlier / last week" based on
 * openedAt. Uses the tab store's closed LRU plus currently-open
 * tabs so there's always something to look at. A fuller
 * session-replay view — with chat transcripts and ops timelines —
 * lands later.
 */
export function SessionsView(): React.JSX.Element {
  const tabs = useTabStore((s) => s.tabs);
  const closed = useTabStore((s) => s.closed);
  const open = useTabStore((s) => s.open);

  const all = React.useMemo(() => [...tabs, ...closed].sort((a, b) => b.openedAt - a.openedAt), [tabs, closed]);

  const now = Date.now();
  const today: typeof all = [];
  const earlier: typeof all = [];
  const lastWeek: typeof all = [];
  for (const t of all) {
    const age = now - t.openedAt;
    if (age < 24 * 3_600_000) today.push(t);
    else if (age < 7 * 24 * 3_600_000) earlier.push(t);
    else lastWeek.push(t);
  }

  return (
    <div style={{ overflowY: 'auto', flex: 1 }}>
      <Group label="Today" items={today} onOpen={open} />
      <Group label="Earlier this week" items={earlier} onOpen={open} />
      <Group label="Older" items={lastWeek} onOpen={open} />
    </div>
  );
}

function Group({ label, items, onOpen }: { label: string; items: Array<{ tabKey: string; title: string; kind: string; openedAt: number; instanceId?: string }>; onOpen: (e: any) => void }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 style={{ padding: '10px 18px 4px', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', margin: 0, fontWeight: 500 }}>
        {label}
      </h3>
      {items.map((t) => (
        <TreeItem
          key={t.tabKey + ':' + t.openedAt}
          label={t.title}
          trailing={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-tertiary)' }}>{t.kind}</span>}
          onClick={() => onOpen({ ...t })}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Wire into ExplorerPanel**

In `explorer-panel.tsx`, replace the `sessions` stub:

```typescript
import { SessionsView } from './sessions-view';

{activeView === 'sessions' && <SessionsView />}
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/shell/beacon/sessions-view.tsx packages/app/src/shell/beacon/explorer-panel.tsx
git commit -m "feat(app/shell/beacon): add Sessions rail view (recent tabs grouped by age)"
```

---

## Task 15: Real Fleet rail view

**Files:**
- Create: `packages/app/src/shell/beacon/fleet-view.tsx`
- Modify: `packages/app/src/shell/beacon/explorer-panel.tsx`

- [ ] **Step 1: Create the component**

Create `packages/app/src/shell/beacon/fleet-view.tsx`:

```typescript
import * as React from 'react';
import { StatusDot, TreeItem } from '@/ui';
import { trpc } from '@/lib/trpc';
import { useTabStore } from '@/stores/tab-store';

/**
 * Compact node list for quick context switching. Click a node → opens
 * its detail tab. Real node/cluster selection (i.e. changing the
 * active fleet) happens via NodeSelector in the title bar; this view
 * is a read-only quick-nav.
 */
export function FleetView(): React.JSX.Element {
  const list = trpc.nodeList.useQuery(undefined, { refetchInterval: 15_000 });
  const open = useTabStore((s) => s.open);
  const nodes = (list.data?.nodes ?? []) as Array<{ name: string; effectiveKind?: string; phase?: string }>;

  if (nodes.length === 0) {
    return (
      <div style={{ padding: 14, color: 'var(--color-text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
        No nodes in the current cluster. Add one via <code>llamactl node add</code>.
      </div>
    );
  }

  return (
    <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
      {nodes.map((n) => {
        const tone = n.phase === 'Ready' || !n.phase ? 'ok' : 'warn';
        return (
          <TreeItem
            key={n.name}
            label={n.name}
            trailing={<StatusDot tone={tone} />}
            onClick={() => open({ tabKey: `node:${n.name}`, title: `Node · ${n.name}`, kind: 'node', instanceId: n.name, openedAt: Date.now() })}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Wire in**

In `explorer-panel.tsx`:

```typescript
import { FleetView } from './fleet-view';

{activeView === 'fleet' && <FleetView />}
```

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/shell/beacon/fleet-view.tsx packages/app/src/shell/beacon/explorer-panel.tsx
git commit -m "feat(app/shell/beacon): add Fleet rail view (node quick-nav)"
```

---

## Task 16: Retire the feature flag + legacy shell

**Files:**
- Modify: `packages/app/src/App.tsx`
- Delete: `packages/app/src/shell/ide-layout.tsx`
- Delete: `packages/app/src/shell/title-bar.tsx`
- Delete: `packages/app/src/shell/activity-bar.tsx`
- Delete: `packages/app/src/shell/status-bar.tsx`
- Delete: `packages/app/src/shell/theme-picker.tsx` (only the `ThemePickerButton` export is unused; the `ThemePicker` dialog stays if it's referenced elsewhere — check)
- Delete: `packages/app/src/stores/shell-flag.ts`
- Modify: `packages/app/src/modules/settings/index.tsx` — remove the Beacon toggle added in P2 Task 17

- [ ] **Step 1: Confirm no-one reads the flag except App.tsx + Settings**

Run: `rg "useShellFlag" packages/app/src`
Expected: two hits — `App.tsx` and the Settings module.

- [ ] **Step 2: Unconditionally mount BeaconLayout**

Edit `packages/app/src/App.tsx`:

```typescript
import * as React from 'react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { trpc, trpcClient } from '@/lib/trpc';
import { BeaconLayout } from '@/shell/beacon/layout';
import { ThemeProvider } from '@/shell/theme-provider';

export function App(): React.JSX.Element {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } } }),
  );
  return (
    <ThemeProvider>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <BeaconLayout />
        </QueryClientProvider>
      </trpc.Provider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 3: Remove the toggle from Settings**

Remove the shell-toggle `<section>` from `packages/app/src/modules/settings/index.tsx` plus its `useShellFlag` import.

- [ ] **Step 4: Check ThemePicker references before deletion**

Run: `rg "ThemePicker|theme-picker" packages/app/src`
- If `ThemePicker` (the dialog) is only used by the title-bar's `ThemePickerButton`, delete the whole file.
- If `ThemePicker` is also opened by the palette or by `useThemePickerOpen`, keep the `ThemePicker` dialog + `useThemePickerOpen` hook but delete the `ThemePickerButton` export.

- [ ] **Step 5: Delete the legacy files**

```bash
git rm packages/app/src/shell/ide-layout.tsx
git rm packages/app/src/shell/title-bar.tsx
git rm packages/app/src/shell/activity-bar.tsx
git rm packages/app/src/shell/status-bar.tsx
git rm packages/app/src/stores/shell-flag.ts
# plus theme-picker.tsx IF safe per step 4
```

- [ ] **Step 6: Typecheck + full smoke**

`bun run --cwd packages/app typecheck` → exits 0.
Launch → Beacon shell mounts unconditionally. No legacy shell anywhere.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/App.tsx packages/app/src/modules/settings/index.tsx
git commit -m "refactor(app): retire IDELayout + beacon-shell feature flag"
```

---

## Task 17: Remove legacy token aliases + legacy theme migration

**Files:**
- Modify: `packages/app/src/themes/tokens.css`
- Modify: `packages/app/src/stores/theme-store.ts`

- [ ] **Step 1: Confirm no remaining references to legacy token names**

Run:
```bash
rg -- "--color-fg|--color-fg-muted|--color-accent|--color-warning|--color-danger|--color-success|--color-brand-dim|--color-fg-inverted" packages/app/src
```
Expected: zero hits outside `tokens.css` itself. If any remain — they're in modules that haven't migrated to `@/ui` primitives yet. Hold the alias deletion until those spots are fixed, or fix them inline now.

- [ ] **Step 2: Remove the legacy alias block**

In `packages/app/src/themes/tokens.css`, delete the comment + block:

```css
/* Legacy aliases — consumed by modules that still reference the pre-Beacon
 * token names. Removed at the end of P3 once every reference migrates. */
:root {
  --color-fg: var(--color-text);
  …
  --color-brand-dim: var(--color-brand-subtle);
}
```

- [ ] **Step 3: Remove the legacy theme-id migration**

In `packages/app/src/stores/theme-store.ts`, remove the `readLegacyAndClear` function and its call site. Replace the seed line with:

```typescript
export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      themeId: DEFAULT_THEME,
      scanlines: false,
      setThemeId: (id) => set({ themeId: id }),
      setScanlines: (on) => set({ scanlines: on }),
    }),
    { name: 'beacon-theme', version: 2 },
  ),
);
```

Bump `version` to `2` so older snapshots get discarded (they were already migrated — the legacy path ran in P0).

Also remove the `migrate.ts` import — it's unused here now. Keep `migrate.ts` itself; nothing removes it, and it documents the historical mapping.

- [ ] **Step 4: Typecheck + smoke**

`bun run --cwd packages/app typecheck` → exits 0.
Launch → app runs identically.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/themes/tokens.css packages/app/src/stores/theme-store.ts
git commit -m "refactor(app): drop legacy token aliases + legacy theme migration (Beacon is now the only path)"
```

---

## Task 18: End-of-phase verification

- [ ] **Step 1: Typecheck**

Run: `bun run --cwd packages/app typecheck`
Expected: exits 0.

- [ ] **Step 2: Run every test**

Run: `bun test --cwd packages/app`
Expected: green. New tests from P3 (explorer-collapse-store) pass; P0/P1/P2 tests still pass.

- [ ] **Step 3: Top-level suite + cross-repo**

Run: `bun run test`
Expected: green.

Run the integration/smoke pass across llamactl + sirius-gateway + embersynth per the cross-repo validation rule. P3 touched only `packages/app` — expected pass.

- [ ] **Step 4: Full golden path**

Run: `bun run --cwd packages/app dev`

Exercise:
1. Fresh start → Beacon shell, Dashboard tab open, editorial hero visible.
2. Explorer: expand Ops → click a live workload → tab opens with workload detail; metrics populate.
3. Click Nodes → expand → click a node → node-detail tab opens.
4. Models group expands; every sub-page (Catalog / Presets / Pulls / Bench / LM Studio / Server) opens as its own tab.
5. Knowledge group expands; Retrieval + Pipelines open as tabs.
6. Sessions rail view → shows today's open + recently-closed tabs.
7. Search rail view → type "ops" → Ops Chat + Planner surface → click opens tab.
8. Fleet rail view → list of nodes; click opens node detail.
9. Tokens rail view → slide-in inspector shows live values; click-to-copy works.
10. Reload → tab set restores; Explorer collapse state restores.
11. Cycle all four themes — every new surface paints correctly.

- [ ] **Step 5: Tag**

```bash
git tag beacon-p3
```

---

## Self-review against the spec

- §5.3 Explorer collapse state persisted per-user — Task 1 ✓
- §6.3 Dissolve `*-tabbed` modules — Tasks 2–5 ✓; delete `shell/tabbed-module.tsx` — Task 6 ✓
- §6.2 Dynamic tab components — Tasks 7–10 ✓; tabs persist state while open ✓
- §7 Editorial treatment on Dashboard — Task 11 ✓; additional surfaces (empty states, about, settings heads) noted as incremental follow-up in Task 12 playbook
- §4 Primitive adoption across modules — reference migration in Task 12 (Chat, Logs, Projects); full coverage = long tail
- §5.2 Real Search / Sessions / Fleet rail views — Tasks 13–15 ✓
- §14 Feature flag removal + legacy shell deletion — Task 16 ✓
- §3.5 Legacy migration removal (after one release cycle) — Task 17 ✓
- Legacy token alias removal — Task 17 ✓

Follow-ups beyond P3 (spec §13 + incremental):
- Split-view editor (§13) — TabBar is ready for it; implementation is a separate initiative.
- Full-fat Search across logs + ops sessions + workload history — beyond module-index search.
- Session replay + timeline for OpsSessionDetail — currently a stub.
- Primitive adoption in the remaining modules (dashboard stats grid, nodes, models.*, knowledge.*, workloads.*, cost, settings, server). Long-tail cleanup.
- About / release-notes editorial pages.
- `beacon://` deep-link URLs (§13 — stubbed in P3's tab context menu).
