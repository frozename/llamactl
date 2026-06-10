# Beacon — UI Renewal (Electron App)

**Status:** Design complete, ready for planning.
**Scope:** `packages/app` (Electron dashboard). No backend surface changes.
**Source design:** Beacon Design System v3 — extracted from `llamactl` (sirius indigo DNA) and `novaflow` (ember amber DNA), merged into one vocabulary with four theme families.

---

## 1. Goal

Replace the current IDE-style shell and loose visual language with **Beacon**: a coherent design system covering tokens, theme families, type voices, a component vocabulary, a rethought navigation model, and an editorial/utilitarian split that keeps dense operator surfaces disciplined while giving hero moments room to breathe.

**Non-goals:** no changes to tRPC contracts, module data flow, streaming transports, node/cluster protocol, or any package outside `packages/app`.

## 2. What changes, at a glance

1. **Tokens** — replace the `index.css` `@theme` block and `themes/index.ts` with the Beacon token set (5-step surface ramp, status colors, border/text tiers, scales, shadows, radii).
2. **Theme families** — four named families (Sirius, Ember, Clinical, Scrubs) replace Glass/Neon/Ops with first-load migration from the legacy ids.
3. **Type voices** — Inter (UI + display) and JetBrains Mono (data). Hero surfaces get Inter 300 at 56–96 px with tight negative tracking; no display serif. Emphasis inside headlines is brand-painted `<em class="t-brand">`, upright — never italic.
4. **Navigation** — replace module-as-activity-bar-entry with a VSCode-style model: activity rail = view modes, Explorer = unified module tree, tabs = persistent open set. Flatten every `*-tabbed` module into Explorer folders. Add dynamic items (live workloads, node details, ops sessions) as first-class tabs.
5. **Chrome** — new TitleBar (Layout B: traffic lights · ⌘K breadcrumb · node selector · theme orbs · notifications · avatar), new ActivityRail (view modes), new Explorer panel, new TabBar with persistent state, new StatusBar, new slide-in Tokens inspector.
6. **Editorial vs utilitarian split** — dense data surfaces stay monospace/tabular/tight. Arrival/empty/settings surfaces get serif display type, gradients, atmospheric blobs, generous whitespace.
7. **Phased delivery** — four ship-able phases (P0 Tokens, P1 Primitives, P2 Shell, P3 Modules) each independently revertable.

## 3. Tokens

### 3.1 Color

Five-step surface ramp per theme — `--color-surface-0` through `--color-surface-4` — covering: base page, shell chrome, panels, elevated cards, hovered elevation. One `--color-surface-overlay` for modal backdrops.

Border tiers: `--color-border`, `--color-border-subtle`, `--color-border-strong`, `--color-border-focus`. The renewal lowers overall border usage — panels rely on surface-step contrast for separation — but keeps the tokens for places that genuinely need a line.

Text tiers: `--color-text`, `--color-text-secondary`, `--color-text-tertiary`, `--color-text-ghost`, `--color-text-inverse`.

Brand per theme: `--color-brand`, `--color-brand-subtle`, `--color-brand-muted` (14–16% alpha), `--color-brand-ghost` (8% alpha), `--color-brand-contrast` (text on brand).

Status is fixed across themes — `--color-ok`, `--color-warn`, `--color-err`, `--color-info` — overridden only in Clinical (light theme) for contrast.

Two atmospheric tokens for hero surfaces: `--glow-brand` and `--glow-ember` (radial gradients used as backgrounds for editorial heroes).

### 3.2 Type

```
--font-sans     Inter, -apple-system, system-ui, sans-serif
--font-mono     JetBrains Mono, SF Mono, ui-monospace, monospace
--font-display  Inter, system-ui, sans-serif    /* display == sans, just tighter */
```

Two voices — Inter for every visual surface, JetBrains Mono for data. No display serif, no script, no novelty. Hero surfaces get impact from **weight (300 or 600) and size (56–128 px) and tight negative tracking**, not a different face.

Scale (all in pixels): 10, 11, 12, 13, 14, 16, 20, 24, 28, 32, 48, 56, 72, 96, 128. The app uses 11–16 for chrome and data, 20–32 for module headers, 48–128 for editorial heroes.

Numeric data uses `font-feature-settings: 'tnum'` (tabular-nums) — already the convention, now codified.

**Semantic type classes** ship in the token CSS so modules don't re-author font stacks: `.t-h1` (56 / 600 / −0.03em), `.t-h2` (28 / 600), `.t-h3` (20 / 600), `.t-h4` (16 / 600), `.t-lede` (19 / 300 / 62ch), `.t-body` (14), `.t-ui` (13), `.t-meta` (12), `.t-eyebrow` (mono 11 uppercase 0.18em tracking), `.t-label` (mono 10 uppercase 0.14em), `.t-mono` (mono 12 tnum), `.t-code` (mono 0.92em chip), and `.t-brand` (emphasis — brand color, `font-style: normal`, **never italic**).

Emphasis inside a headline is an inline `<em class="t-brand">` painted brand, upright. Italic is not an emphasis mode in Beacon.

### 3.3 Spacing, radius, shadow

Spacing scale `--s-1` (4 px) through `--s-48` (192 px).
Radius `--r-sm` (3) / `--r-md` (6) / `--r-lg` (10) / `--r-xl` (16) / `--r-2xl` (24) / `--r-pill` (999). The chrome modernization uses 10–12 px (`--r-lg` to `--r-xl`) instead of the current 3–4 px everywhere.
Shadow `--shadow-sm` / `-md` / `-lg` for panels, elevated surfaces, and floating menus respectively.

### 3.4 Theme families

| id         | role          | brand          | surfaces                  | color-scheme |
| ---------- | ------------- | -------------- | ------------------------- | ------------ |
| `sirius`   | default, dark | #6366f1 indigo | near-black                | dark         |
| `ember`    | warm dark     | #f59e0b amber  | warm near-black           | dark         |
| `clinical` | light         | #2563eb blue   | off-white ramp            | light        |
| `scrubs`   | teal dark     | #14b8a6 teal   | near-black with teal tint | dark         |

Each family is a block in the token CSS that overrides the Sirius defaults. Theme switching sets `document.documentElement.dataset.theme` and persists to `localStorage` under `beacon.theme`.

### 3.5 Legacy migration

First load after the change reads the existing `llamactl-theme` (or whatever key the current store uses) and maps:

| legacy  | → new    | extras                                                                                                |
| ------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `glass` | `sirius` | —                                                                                                     |
| `neon`  | `sirius` | set `beacon.scanlines = true` to preserve the terminal-green scanline overlay as an opt-in decoration |
| `ops`   | `scrubs` | —                                                                                                     |

The migration runs once, writes `beacon.migrated = 1`, and never runs again. Users land on the closest match without losing their preference.

## 4. Primitives

A shared `@app/ui` library (internal, same package) exporting the building blocks once — no more re-declaring button/badge/input styles per module. Minimum surface:

- `Button` — variants `primary` / `secondary` / `ghost` / `outline`, sizes `sm` / `md` / `lg`, optional leading icon, loading state.
- `Badge` — variants `default` / `brand` / `ok` / `warn` / `err`, compact mono styling.
- `StatusDot` — tone `ok` / `warn` / `err` / `idle` with optional pulse animation.
- `Kbd` — keyboard key pill with raised bottom border.
- `Input` — text input with brand focus ring; variants: plain, with leading slot, with trailing slot.
- `Tabs` / `Tab` — horizontal tab strip (used inside module surfaces where intra-module tabs still make sense, e.g. settings sections).
- `TreeItem` — used by the Explorer; handles indentation, chevron, icon, label, trailing badge/dot.
- `Card` / `Panel` — elevated container with surface-step background and optional border.
- `StatCard` — label, value (mono, large), delta, sparkline.
- `EditorialHero` — gradient-backed hero with atmospheric blobs. Title is Inter 300 at 56–96 px with tight negative tracking; accent text uses `.t-brand` (brand color, upright).
- `AtmosphericPanel` — surface-1 gradient + two blurred blobs; used for editorial sections.
- `CommandBar` (title-bar breadcrumb) — composite of orbs, path segments, slashes, kbd hint.
- `ThemeOrbs` — the four-dot theme picker shown in the title bar.
- `Lockup` — the Beacon wordmark: lowercase `beacon` in Inter 600 + an 8 px indigo orb with a matching box-shadow glow, used leftmost in the title bar.

Icons: continue with `lucide-react` (already the dependency). No migration.

## 5. Shell architecture

```
┌────────────────────────────── TitleBar (44 px) ──────────────────────────────┐
│ ○●○ | beacon / Ops / wl-ghi  ⌘K | prod-cluster ● | ○●○● | ◎ | ● avatar       │
├──────┬──────────────────────────┬─────────────────────────────────────────────┤
│      │                          │ TabBar (38 px)                              │
│ 56   │  Explorer (280 px)       ├─────────────────────────────────────────────┤
│ px   │  · view-specific tree    │ Breadcrumb (24 px, optional)                │
│ rail │                          ├─────────────────────────────────────────────┤
│      │                          │                                             │
│      │                          │          Editor surface                     │
│      │                          │                                             │
│      │                          │                                             │
├──────┴──────────────────────────┴─────────────────────────────────────────────┤
│ StatusBar (26 px) — fleet · module · theme · ⌘⇧P                              │
└───────────────────────────────────────────────────────────────────────────────┘
```

A slide-in **TokensPanel** (380 px) overlays the right edge when the Tokens rail view is active; it does not push the editor.

### 5.1 TitleBar (Layout B)

- **Left:** macOS traffic lights (unchanged — controlled by the main process), no File/Edit/View/Go/Help menu (macOS system menu carries that).
- **Center-left:** `CommandBar` — a breadcrumb `beacon / {SectionGroup} / {ActiveTab}` rendered in mono, with a leading brand orb and a trailing `⌘K` kbd hint. Click opens the command palette.
- **Right:** `NodeSelector` (existing component, restyled), `ThemeOrbs`, notifications icon (stub for P3), user avatar (gradient placeholder; fleshed out post-renewal).

The bar is `WebkitAppRegion: drag` except for interactive regions, preserving the current macOS draggable-title behavior.

### 5.2 ActivityRail (56 px, view modes)

The rail stops being a module selector. It becomes a view switcher for the left panel.

**Top (in order):** Explorer · Search · Sessions · Fleet · Tokens
**Bottom:** Cost · Settings

Each button is 40 × 40 with 10 px radius; active state = brand-ghost background + 2 px brand indicator on the left edge. Tooltips on hover.

**View semantics:**

- **Explorer** — the main module tree (see §6).
- **Search** — global search across modules, workloads, nodes, logs (initial P2 shipment just opens the command palette; full search is P3).
- **Sessions** — recent chat and ops sessions, time-grouped (P3 feature; the rail button is stubbed in P2).
- **Fleet** — compact node/cluster view for quick switching without leaving the current tab (P3).
- **Tokens** — slide-in token inspector panel showing live CSS custom property values for the active theme, with copy-to-clipboard.
- **Cost** — the Cost module's content, presented as a rail panel instead of a full-surface module (today Cost is a bottom activity-bar module; it gains a persistent side view).
- **Settings** — opens Settings as a tab (not a panel). Keeping Settings as a full tab preserves the existing layout of nested settings sections.

### 5.3 Explorer (280 px)

The Explorer's content depends on the active rail view. When Explorer is the active view, it renders the **Workspace tree** (see §6). Other rail views render their own content (Search field + results, Tokens panel, etc.).

Search field at top (`⌘F`), collapsible sections, per-user collapse state persisted to `localStorage`.

### 5.4 TabBar + tab model

- Persistent open set — serialized to `localStorage` under `beacon.tabs` (array of `{tabKey, title, kind, ...opts}`).
- Click any Explorer leaf → opens new tab or focuses existing.
- Middle-click or × closes. `⌘W` closes active tab.
- `⌘1` … `⌘9` jumps to tab N.
- `⌘⇧T` reopens most recently closed tab (LRU of last 10).
- Context menu per tab: Pin · Close others · Close all · Close unpinned · Copy tab URL (a `beacon://…` deep link — P3).
- Active tab = brand underbar on the tab's top edge (replaces the current left-inset brand stripe on activity icons).
- Pinned tabs render leftmost with a star glyph, no × on hover, survive "Close all unpinned".
- Module state is retained while the tab is open (same display-toggle behavior as today, but keyed on tab set instead of visited modules); discarded on close.
- Max open tabs soft cap = 30. Beyond that the oldest non-pinned tab LRU-evicts with a toast (user can reopen via `⌘⇧T`).

### 5.5 StatusBar (26 px)

Keeps the three-lane model (left = fleet permanent, center = module contributions, right = palette + theme name). Chrome is restyled to Beacon tokens; the contribution API (`useStatusBarStore().setModuleItems(moduleId, [...])`) is unchanged so no module has to rewrite its status bar.

### 5.6 TokensPanel (380 px slide-in)

Opens from the right edge when the Tokens rail view is active. Sections: Brand · Surface · Border · Text · Status · Type · Spacing · Radius · Shadow. Each row shows a swatch/preview, the token name, and its computed value. Click copies to clipboard. Values update live when the theme changes.

## 6. Navigation model

### 6.1 Tree structure (Explorer · Workspace view)

```
▾ Workspace
  • Dashboard                 (static)
  • Chat                      (static)
  • Projects                  (static)

▾ Ops
  • Ops Chat                  (static)
  • Planner                   (static)  ← was a tab inside ops-tabbed
  ▸ Workloads                 (group; children = live instances)
      · wl-abc · qwen-coder   (dynamic, live-tagged)
      · wl-def · embed-pool   (dynamic)
      · wl-ghi · llama-70b    (dynamic, warn-tagged)
      · Model Runs            (static sub-view for list)
      · Composites            (static sub-view)
  ▸ Nodes                     (group; children = live instances)
      · atlas · agent
      · rigel · agent
      · pulsar · cloud

▾ Models
  • Catalog · Presets · Pulls · Bench · LM Studio · Server   (statics — flattened from models-tabbed)

▾ Knowledge
  • Retrieval · Pipelines                                     (flattened from knowledge-tabbed)

▾ Observability
  • Logs

▾ Pinned                                                       (user-pinned dynamic items)
  • wl-ghi · llama-70b  ★
  • ops #42 heal loop  ★
```

Sections are collapsible; state per-user. "Pinned" is hidden when empty.

### 6.2 Static vs dynamic items, and groups

Three kinds of tree node:

- **Groups** (`▸`/`▾` headers — e.g. `Workspace`, `Ops`, `Workloads`, `Nodes`) are structural only. They expand/collapse. They do **not** open tabs. To view "all workloads as a list" the user opens the static `Model Runs` leaf inside the `Workloads` group — the list view has its own static leaf, it isn't the group itself. This matches file-tree convention (folders don't open; files do).
- **Static items** map 1:1 with today's modules or sub-tabs. Opening one routes to a known `tabKey` (e.g. `module:chat`, `module:models.catalog`). There's always at most one tab per static item.
- **Dynamic items** represent a specific instance (a workload id, a node id, an ops session id). Opening one creates a tab keyed `workload:{id}` / `node:{id}` / `ops-session:{id}`. Multiple can be open at once (e.g. three workloads side-by-side via split view in P3).

Dynamic children are populated by the same `trpc.workloadList` / `trpc.nodeList` queries the StatusBar already uses — no new data contracts.

### 6.3 Dissolving the `*-tabbed` modules

Today:

```
packages/app/src/modules/
  ops-tabbed/         → bundles: Ops Chat, Planner
  models-tabbed/      → bundles: Catalog, Presets, Pulls, Bench, LM Studio, Server
  knowledge-tabbed/   → bundles: Retrieval, Pipelines
  workloads-tabbed/   → bundles: Model Runs, Composites
  + shell/tabbed-module.tsx   (the wrapper that renders the inner tab strip)
```

After renewal:

```
packages/app/src/modules/
  ops/               → just the Ops Chat component (formerly a sub-tab)
  planner/           → former ops-tabbed::plan
  models/catalog     → former models-tabbed::catalog
  models/presets     → former models-tabbed::presets
  …etc…
```

Each former sub-tab becomes its own module entry in the registry, each with its own `tabKey`. The `shell/tabbed-module.tsx` wrapper is deleted — the editor tab bar is now the only tab strip in the app. The `*-tabbed/index.tsx` files go away; their child components move up one level.

This is the largest single change in P3 and is the whole point of the "flatten" work.

### 6.4 Command palette

Today: `⌘⇧P` opens the palette. Keep that. **Add** `⌘K` from the TitleBar center command-bar, routed to the same palette. The palette gets one new section — "Open in tab…" — listing every static and dynamic leaf from the Explorer tree, so keyboard-only users never need the mouse.

## 7. Editorial vs utilitarian

Each surface is classified as one or the other. The classification is a design invariant; modules declare their intent, and the primitives render accordingly.

**Utilitarian surfaces:** Logs, Workloads list, Models catalog, Nodes list, Pipelines, Bench, Pulls, Cost, Ops Chat history, and most of Chat's message list.

- Inter 11–13 px body, Inter 16–20 px section heads
- Mono + tabular-nums for data
- Tight 4–8 px row padding, 10–12 px section gutters
- Borders only where a line is load-bearing; prefer surface-step contrast
- No gradients, no atmospheric blobs
- `Card` panels are subtle: `surface-1` background, `border-subtle` edge

**Editorial surfaces:** Dashboard landing hero, every module empty state, Projects new-project welcome, Settings section headers, About, onboarding/first-run.

- `EditorialHero` component — Inter 300 display at 56–96 px, tight negative tracking (−0.03em)
- Emphasis inside titles via `<em class="t-brand">` (brand color, upright — never italic)
- `AtmosphericPanel` with gradient + two atmospheric blobs
- 48 px — 128 px type sizes for heroes
- 120–180 px vertical rhythm between sections
- Generous whitespace, asymmetric grids welcome

The same theme tokens drive both — editorial surfaces don't get different colors, they get different typographic and spatial treatment.

## 8. Module inventory after renewal

```
Workspace:     dashboard, chat, projects
Ops:           ops-chat, planner, workloads, nodes
  · workloads sub-views: model-runs, composites
  · workloads dynamic: workload:{id}
  · nodes dynamic:     node:{id}
  · ops sessions dynamic: ops-session:{id}
Models:        catalog, presets, pulls, bench, lmstudio, server
Knowledge:     retrieval, pipelines
Observability: logs
Rail-only views (not tabs): search, sessions, fleet, tokens, cost
Tab-only: settings
```

Registry becomes a flat list of leaf entries plus a grouping structure the Explorer consumes. Activity-bar / position / shortcut fields move out (the rail isn't module-driven anymore); a new `group` (required) + `kind: 'static' | 'dynamic-group'` replaces them.

## 9. Migration phasing

Each phase is independently shippable and revertable. No phase depends on the next being ready.

### P0 · Foundations (tokens + themes)

- Replace the `@theme` block in `packages/app/src/index.css` with the Beacon token set.
- Rewrite `packages/app/src/themes/index.ts`: Sirius / Ember / Clinical / Scrubs. Preserve the `Theme` interface's `mapVariant` and `rootBackground` / `rootOverlay` so the NodeMap keeps working.
- Load only Inter + JetBrains Mono from Google Fonts (no display serif).
- First-load migration: if `localStorage[old-key]` exists and `beacon.migrated != 1`, map to the new id and set `beacon.migrated`.
- Noise overlay (`body::before` SVG feTurbulence at 2.5 % opacity) added globally.

**Visible outcome:** app looks Beacon-themed, behaves identically. Safe rollback.

### P1 · Primitives (`@app/ui` internal lib)

- Build the component inventory from §4 under `packages/app/src/ui/`.
- Export via `@/ui/*` alias (existing `@/` path alias in `tsconfig.web.json`).
- Each primitive has a Storybook-style sandbox page reachable via the command palette (`ui: primitives`) for visual verification.
- No module is forced to migrate yet; existing modules keep using inline Tailwind.

### P2 · Shell rewrite

- Replace `TitleBar`, `ActivityBar`, `StatusBar`, `IDELayout`, `CommandPalette` mount.
- Introduce `ExplorerPanel`, `TabBar`, `TokensPanel`.
- New `useTabStore` (zustand) replacing the single-`activeModule` model in `ui-store`. The store serializes to `localStorage`.
- Registry refactor: flat leaves + `group` field + `kind`.
- Every current module still renders inside its own tab; the rail view-mode buttons work; the Explorer tree displays; tabs open/close/pin.
- The `*-tabbed` modules still exist in P2 — they render as single tabs with their old inner tab-strip. Flattening is P3.

**Visible outcome:** new navigation shape, familiar module contents. This is the risky cut — rollback means restoring the previous shell files.

### P3 · Module flattening + editorial polish

- Dissolve `ops-tabbed`, `models-tabbed`, `knowledge-tabbed`, `workloads-tabbed`. Promote each child to its own top-level module entry. Delete `shell/tabbed-module.tsx`.
- Wire dynamic items: workloads, nodes, ops sessions get their own tab surfaces (new components under `modules/ops/workload-detail.tsx`, `modules/ops/node-detail.tsx`, `modules/ops/session-detail.tsx`).
- Apply editorial treatment to the classified surfaces (dashboard, empty states, settings heads, about).
- Adopt primitives across modules — replace inline Tailwind for buttons, badges, inputs, status dots with `@/ui` equivalents.
- Retire the current `ThemePickerButton` in favor of `ThemeOrbs`. Remove the legacy migration code once it's been in prod for one release cycle.

**Visible outcome:** full Beacon. No "\*-tabbed" modules. Dynamic items openable as tabs. Dense views disciplined, hero surfaces editorial.

## 10. State & persistence

New `localStorage` keys (all prefixed `beacon.`):

| key                         | type                                            | written in                                  |
| --------------------------- | ----------------------------------------------- | ------------------------------------------- |
| `beacon.theme`              | `'sirius' \| 'ember' \| 'clinical' \| 'scrubs'` | P0                                          |
| `beacon.scanlines`          | `'1' \| '0'`                                    | P0 (set only by migration for `neon` users) |
| `beacon.migrated`           | `'1'`                                           | P0                                          |
| `beacon.tabs`               | JSON `TabSnapshot[]`                            | P2                                          |
| `beacon.tabs.active`        | string (tabKey)                                 | P2                                          |
| `beacon.tabs.closed`        | JSON `TabSnapshot[]` (LRU 10)                   | P2                                          |
| `beacon.explorer.collapsed` | JSON `string[]` (group ids)                     | P2                                          |
| `beacon.rail.view`          | rail view id                                    | P2                                          |
| `beacon.pinned`             | JSON `string[]` (tabKeys)                       | P2                                          |

Old keys are left untouched after migration — P3 removes them.

## 11. Accessibility + keyboard

- All rail buttons are `<button>` with `aria-label` and keyboard-focusable.
- Explorer is a `role="tree"` with `role="treeitem"` children; arrow keys navigate, Enter opens.
- Tabs are a `role="tablist"` with `role="tab"` children; arrow keys navigate, Enter or Space activates.
- Focus ring is `--color-brand-ghost` 3 px outside the focused element (never `outline: none`).
- All interactive elements meet 4.5:1 contrast on their surface in every theme; Clinical overrides the status colors so `ok`/`warn`/`err` clear the bar against a light background.

## 11a. Voice & content rules

These rules apply to every surface — UI copy, doc copy, commit messages, status-bar strings, tab titles. They are non-negotiable; implementers enforce them at PR review.

1. **Sentence case everywhere.** Headings, buttons, labels, tab titles. Proper nouns only (Sirius, Ember, Clinical, Scrubs, Inter, JetBrains Mono, Beacon). No Title Case, no ALL CAPS outside labels that use letter-spaced uppercase as a typographic treatment.
2. **No emoji. Ever.** Not in UI, not in docs, not in empty states, not in toasts. Use unicode glyphs: `▸ ▾ ▲ ▼ ● ◉ ◎ ✓ × ⌕ ⌘ ⇧ ⌥ ↗ ↑ ↓ ↺ ⎇ ⚙`.
3. **Em-dashes ( — ) connect clauses.** Never hyphens with spaces (" - ").
4. **Middle-dot separators (`·`) between related fragments.** `v2.1.4 · frozen · shipping`. Slashes (`/`) reserved for paths.
5. **Ellipses use the single character `…`.** Never three dots.
6. **Mono is for identifiers and telemetry only.** `svc.gateway`, `v2.1.4`, `⌘K`, `842 ms`. Never mono prose.
7. **Numbers are digits.** `4 themes`, not `four themes`. Units compact: `842ms`, `1.24M`, `99.98%`.
8. **Emphasis is brand-painted, never italic.** Inline `<em class="t-brand">` renders the emphasized word in `--color-brand` with `font-style: normal`.
9. **Third person or imperative.** Docs instruct ("Drop this in"), specs describe ("Every primitive resolves to a token"). Avoid "we" and "you" unless the surface is explicitly conversational (chat, onboarding tip).
10. **Present tense.** The system _is_, does, runs. Avoid "will support" / "is supported by".
11. **No exclamation marks.** Confidence without performance.
12. **Visual "do not" list:** no purple-blue gradients as backgrounds; no "card with a colored left border only" pattern; no inner shadows; no frosted-glass / backdrop-blur as a default surface treatment; no photography unless explicitly justified (cool, desaturated, 15 % grain if used).

## 12. Testing & verification

- Token migration: snapshot the computed styles of a reference component across all four themes (already the pattern in `test/` — extend).
- Tab store: unit test the LRU eviction, pin behavior, snapshot restore.
- Explorer tree: unit test the static/dynamic merge, per-group collapse persistence.
- E2E (`tests/ui-audit-driver-v2.ts` / `electron-mcp`): golden-path flow — open app → switch theme → open three tabs from Explorer → close one → reload → restored open set matches.
- Visual regression on the four themes via the existing audit harness.

Cross-repo: per project convention, after P2 lands run integration + smoke tests across llamactl + sirius-gateway + embersynth to confirm nothing on the cloud side depended on the old chrome selectors (none should — the app is a closed world — but confirm).

## 13. Out of scope / future work

Not in this renewal; noted for later:

- Split-view editor (two tabs side-by-side). The TabBar is designed to accommodate it later; P2/P3 ship with single-pane only.
- Multi-window (dragging a tab to a new window). `Move to new window` tab context menu item is stubbed in P2.
- Full-fat global Search across logs + ops sessions + workloads. P2 ships a stub (opens palette); P3 lands real search.
- Sessions rail view with grouped recent activity. Stub in P2, real in P3+.
- `beacon://` deep-link URLs for tab state sharing. Stubbed in P3 (Copy Tab URL), resolver is post-renewal.
- Scanlines decoration (preserved for migrated `neon` users) gets a Settings toggle but no new design work.
- Touch Bar / Vibrancy / traffic-light custom placement — none of these move.

## 14. Risks

- **P2 is a big cut.** Shell files are central. Mitigation: ship P0 and P1 first (visible wins, low blast radius); P2 lands behind a feature flag (`beacon.shell.v3 = true`) that lets us A/B the new shell against the old for one release.
- **Tab model is new muscle memory.** Users who relied on the activity-bar-as-module-switcher get a different pattern. The old registry's `⌘1`…`⌘9` "open module N" shortcuts are retired — `⌘1`…`⌘9` are now positional (tab 1…9 by position in the tab bar, VSCode semantics). Mitigation: the command palette grows an "Open in tab…" section so keyboard users open any static or dynamic leaf in one chord; first-run shows a 3-step tip overlay explaining the new shape.
- **Flattening risks:** a module's internal tabs sometimes share state (e.g. Models Catalog filter carries into Pulls). P3 needs to audit each `*-tabbed` wrapper for shared state and either keep it shared via the module's store or explicitly scope it per-tab. Caught at the per-module PR level, not upfront.
- **Google Fonts network dependency.** Inter + JetBrains Mono load from Google Fonts. Fall-back stacks (`-apple-system`, `ui-monospace`) keep text readable if the load fails; re-audit if the app ships in air-gapped contexts.

## 15. Provenance

- Sirius family and 5-step surface ramp come from llamactl (`src/themes/index.ts` glass/ops).
- Ember family, warm amber DNA, and the editorial sensibility come from novaflow.
- Clinical (light) and Scrubs (teal dark) are new additions for breadth.
- IDE chrome grammar is shared between the two source projects; Beacon v3 is the modernization pass.

## 15a. Reference assets

The frozen Beacon v2.0 design bundle is archived in the repo at `docs/superpowers/design-assets/beacon-v2/`:

- `project/tokens.css` and `project/colors_and_type.css` — the source-of-truth token files (our `packages/app/src/themes/tokens.css` is a derivative of these).
- `project/SKILL.md` — the 12 non-negotiable design rules (codified above in §11a).
- `project/README.md` — full visual foundations + voice + content rules.
- `project/source_reference.html` — the original Design System v3 IDE preview; read this for voice calibration.
- `project/preview/*.html` — 21 canonical preview cards, one per primitive / token family. Use these as pixel-match references during P1.
- `project/ui_kits/llamactl/index.html` — full interactive dense control plane mockup on Sirius. Pixel-match target for the shell rewrite in P2.
- `project/ui_kits/novaflow/index.html` — the Ember twin; useful for seeing the token system in a different mood.
- `project/assets/beacon-lockup.svg` — the wordmark used by the `Lockup` primitive.

Brainstorming scratch (chat transcript, visual-companion mockups) lives under `.superpowers/` and is gitignored — the archived bundle above is the durable reference.
