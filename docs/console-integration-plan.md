# Operator console integration plan

Companion to `docs/console-ui-plan.md`. That document says _what_ the console
must expose; this one analyses the current `packages/app` architecture and
says _how_ the new modules plug into it without turning the Beacon shell,
the IPC dispatcher or the registry into a pile of special cases. It follows
the same shape as Penumbra's `docs/console-integration-plan.md`; where the
two consoles differ (tRPC over Electron IPC instead of HTTP + SSE, a tab
store instead of a URL router, a pixel-diff gate) the llamactl-specific
answer is given.

## 1. Current architecture (main, `74434039`)

### 1.1 Shell

`shell/beacon/layout.tsx` composes `TitleBar` (breadcrumb, ⌘K, NodeSelector,
theme orbs) → `ActivityRail` (56 px) + `ExplorerPanel` (280 px) + content
(`TabBar` above a lazily-rendered module or `DynamicTabRouter`) → status bar,
command palette, first-run tip, error boundary. Navigation is **tab-store
driven**: `useTabStore.open({tabKey, kind, instanceId})`, with
`tabKey = module:<id> | workload:<id> | node:<name> | ops-session:<id> |
settings`. There is no URL router. Tabs, theme and Explorer collapse state
persist via Zustand `persist`.

Strengths worth keeping: lazy module loading, pinned tabs + reopen LRU,
keyboard shortcuts, the Explorer's mix of static registry leaves and dynamic
children (workloads, nodes, sessions), status-bar contributions per module
(`status-bar-store`), and the palette's module/alias/dynamic-entity search.

### 1.2 Registry

`modules/registry.ts` exports one `APP_MODULES: AppModule[]` (22 entries):

```ts
export interface AppModule {
  id: string;
  labelKey: string;
  icon: LucideIcon;
  Component: LazyExoticComponent<ComponentType>;
  position?: "top" | "bottom";
  shortcut?: number;
  activityBar?: boolean;
  group?: "core" | "models" | "ops" | "observability";
  aliases?: string[];
  beaconGroup?:
    | "workspace"
    | "ops"
    | "models"
    | "knowledge"
    | "observability"
    | "settings"
    | "hidden";
  beaconKind?: "static" | "dynamic-group";
  beaconOrder?: number;
  smokeAffordance: string;
}
```

The registry is **navigation metadata only**. It does not know which
procedures a module reads, which mutations it offers, which dynamic tab
kinds it renders, or which palette commands it contributes. Consequences:

- `DynamicTabRouter` / `tab-dispatch.ts` hard-code three `TabKind`s
  (`workload`, `node`, `ops-session`) and import the detail components
  directly. Adding `composite:`, `project:`, `pipeline:`, `proposal:` tabs
  means editing the shell.
- `use-explorer-tree-data.ts` hard-codes which queries feed dynamic
  children.
- `shell/commands.ts` hand-writes palette commands (theme, view, new, dev);
  module actions are not discoverable from ⌘K.
- `RAIL_VIEWS` still ships `search`, `sessions`, `fleet` as `stub: true`.
- Procedure coverage is unmeasured: 40 of 122 router procedures have no
  renderer caller and nothing fails.

### 1.3 tRPC client and node addressing

Renderer: `lib/trpc.ts` creates `createTRPCReact<AppRouter>()` over a single
custom `ipcLink` (`lib/ipc-link.ts`) that speaks to the preload bridge
(`exposeElectronTRPC`). A second plain client, `trpcUIClient`, targets the
two UI-only procedures `uiSetActiveNode` / `uiGetActiveNode`.

Main process: `electron/trpc/dispatcher.ts` introspects the base
`@llamactl/remote` router and wraps every procedure. Per call it reads the
active node override, resolves kubeconfig, and either calls
`baseRouter.createCaller({})` in-process (`inproc://` / control-plane
allowlist) or forwards to a pinned-TLS tRPC client built with
`buildPinnedLinks` + `node-pinned-fetch.ts` (undici agent, pinned CA,
bearer). Subscriptions ride the same path (SSE link for remote nodes) and
are abort-aware. `cross-node-fan-out.ts` implements the `all`-node reads
used by global search, with per-node timeouts and partial-failure reporting.

This is the right seam: the renderer never sees URLs, tokens or certs.
Two limitations matter for the plan:

- **Node scope is implicit.** Procedures that take `{node}` in their input
  (`chatStream`, `nodeModels`, `ragSearch`, …) are addressed explicitly;
  everything else silently goes to the active node. Views cannot tell the
  user which node a table describes.
- **Fan-out is bespoke.** `fanOutSurface` exists only for search; there is
  no generic "run read procedure X on every agent node" for fleet views.

### 1.4 Queries, subscriptions, mutations

- `App.tsx` sets `staleTime: 30_000`, `refetchOnWindowFocus: false`.
  Operational status polls at 5–30 s via `refetchInterval`.
- Subscriptions use `trpc.<proc>.useSubscription(input, {onData, enabled})`
  directly in hooks (`use-chat`, `use-bench`, `use-server-control`,
  `composites/detail-tab`, `logs`). Each hook re-implements buffering,
  enabled/teardown and invalidation on terminal events.
- Mutations are plain `trpc.<proc>.useMutation` with ad-hoc `onSuccess`
  invalidation; 24 `invalidateQueries` call sites, several of them the
  un-targeted `queryClient.invalidateQueries()` that refetches every active
  query on the node.
- Confirmation is inconsistent: `projectRemove` uses `window.confirm`,
  `workloadDelete` / `nodeRemove` / `compositeDestroy` have their own inline
  patterns, and only the Operator Console (`ops-chat/proposal-bubble.tsx`)
  renders the read / dry-run-safe / destructive tier cards with typed
  confirmation.
- There is no toast layer; success/error surfaces are per-component text.

### 1.5 Primitives and theme

`src/ui/` holds atmospheric-panel, badge, button, card, command-bar,
editorial-hero, input, kbd, lockup, sparkline, stat-card, status-dot, tabs,
theme-orbs, tree-item. `modules/ui-primitives` is a gallery/smoke surface.
`themes/tokens.css` defines the semantic token set (surfaces, text, borders,
tones, density) for five theme families. Missing for the plan: data table,
drawer/modal, confirm dialog, toast, JSON/YAML viewer, diff, form field
group, empty/error state, stream panel.

### 1.6 Tests, gate, build

`bun test` per package; app tests cover the dispatcher, IPC origin,
fan-out, stores, shell tree, several modules and the renderer-no-Bun
constraint. `tests/ui-audit-modules.json` mirrors the registry and
`ui-audit-modules-drift.test.ts` fails if they diverge; `scripts/audit.sh`
renders all 22 modules and pixel-diffs against `tests/ui-audit-baselines`.
Tier-A smoke navigates every module and asserts its `smokeAffordance`.
Build is electron-vite + electron-builder; **there is no browser-served
renderer** — the app is Electron-only (see §8).

## 2. Target module contract

Extend the registry entry so a module declares its capabilities; the shell
and the tests derive behaviour from the declaration instead of hard-coding.

```ts
// modules/registry.ts
export interface AppModule {
  // …existing fields unchanged…

  /** Dynamic tab kinds this module renders, e.g. `composite`, `proposal`. */
  tabKinds?: readonly TabKindSpec[];
  /** Explorer children under a `dynamic-group` leaf. */
  explorerChildren?: () => ExplorerChild[]; // hook, runs inside the tree
  /** Palette commands contributed by the module. */
  commands?: (ctx: CommandContext) => Command[];
  /** Status-bar contributions (replaces per-module useStatusBarItems glue). */
  useStatusItems?: () => StatusBarItem[];
  /** Rail badge, e.g. pending healer proposals. */
  useBadge?: () => number | null;
  /** Procedures this module is responsible for (coverage test, §6). */
  procedures: readonly (keyof AppRouter["_def"]["procedures"])[];
}

export interface TabKindSpec {
  kind: string; // "composite"
  Component: LazyExoticComponent<ComponentType<{ instanceId: string }>>;
  title: (instanceId: string) => string;
}
```

Shell changes that follow:

- `tab-store.ts`: `TabKind` becomes `"module" | "settings" | (string & {})`;
  `dispatchTab` looks the kind up in a `TAB_KINDS` map built from
  `APP_MODULES.flatMap(m => m.tabKinds ?? [])` instead of three `if`s.
  `DynamicTabRouter` renders `spec.Component`.
- `use-explorer-tree-data.ts`: iterates `explorerChildren` hooks from the
  registry (workloads, nodes, sessions move into their owning modules;
  composites, projects, proposals become new children).
- `commands.ts`: `useAppCommands` concatenates `m.commands(ctx)` so every
  action in the UI plan is reachable from ⌘K.
- `activity-rail.tsx`: renders `useBadge()` counts.
- `RAIL_VIEWS`: `fleet` and `sessions` lose `stub: true` once the `fleet`
  module and the `ops-sessions` explorer children exist; `search` is
  backed by the existing global-search orchestrator.

Migration is additive: existing entries compile with the new optional
fields; `procedures` is the only required addition and is filled during P0
from the inventory.

## 3. Node scope and fan-out

Add one renderer-side concept, `NodeScope`, and one main-process primitive.

```ts
// lib/node-scope.ts
export type NodeScope = { kind: "active" } | { kind: "node"; name: string } | { kind: "all" };

export function useNodeScope(): [NodeScope, (s: NodeScope) => void]; // zustand, per-tab
```

- Views that address a single node keep calling procedures as today; the
  `NodeScopeBar` header reads `uiGetActiveNode` + `nodeList` and displays
  the resolved endpoint kind (`inproc`, pinned HTTPS, tunnel) so the user
  always knows where a table came from.
- Procedures whose input already has `{node}` are passed the scope's node
  explicitly; the bar exposes a per-tab override without changing the
  global active node.
- **Fan-out for reads.** Generalise `fanOutSurface` into a UI-only
  procedure on the dispatcher router:

  ```ts
  uiFanOut: t.procedure
    .input(
      z.object({
        procedure: z.enum(FAN_OUT_ALLOWLIST),
        input: z.unknown(),
        timeoutMs: z.number().optional(),
      }),
    )
    .query(async ({ input }) => ({
      results: Array<
        { node: string; ok: true; data: unknown } | { node: string; ok: false; error: string }
      >,
    }));
  ```

  with `FAN_OUT_ALLOWLIST` restricted to read procedures (`nodeFacts`,
  `nodeBudget`, `serverStatus`, `workloadList`, `reconcilerStatus`,
  `fleetSnapshot`, `catalogList`, `benchCompare`, `opsSessionSearch`,
  `logsSearch`). Mutations are never fanned out from the UI; the CLI `all`
  target remains the tool for that.

## 4. Data layer: queries, live streams, actions

### 4.1 Domain hooks

Keep tRPC React Query as the client (no custom transport needed — the IPC
link already validates through the router's Zod schemas). Organise hooks by
domain under `modules/<id>/api.ts` and export the query keys the module owns
so invalidation is targeted:

```ts
// modules/workloads/api.ts
export const workloadKeys = {
  list: () => getQueryKey(trpc.workloadList),
  describe: (name: string) => getQueryKey(trpc.workloadDescribe, { name }),
  reconciler: () => getQueryKey(trpc.reconcilerStatus),
};
```

Replace every bare `queryClient.invalidateQueries()` with key lists from
these objects (P0 clean-up; the 24 call sites are enumerable).

### 4.2 `useLiveStream`

One hook over `trpc.<proc>.useSubscription` that owns the buffer, the
scroll-lock, terminal-event detection and reconnect state, so logs, server
start, composite status, bench runs, pulls, model-host start, rpc-server
start, healer runs and ops sessions share a `StreamPanel`:

```ts
export function useLiveStream<TEvent>(
  sub: { useSubscription: SubscriptionHook<TEvent> },
  input: unknown,
  opts: {
    enabled: boolean;
    max?: number; // ring buffer, default 2000
    isTerminal?: (e: TEvent) => boolean;
    onTerminal?: (events: TEvent[]) => void; // invalidate keys here
  },
): { events: TEvent[]; state: "idle" | "live" | "done" | "error"; error?: string; clear(): void };
```

Remote-node subscriptions already reconnect in the dispatcher; the hook only
surfaces `state` so the panel can show "reconnecting".

### 4.3 `useTieredAction`

The single mutation entry point for the UI plan's tiers, layered on the
Ops Chat registry so tiers are never re-declared in the renderer:

```ts
type Tier = "read" | "mutation-dry-run-safe" | "mutation-destructive";

export function useTieredAction<TInput, TResult>(spec: {
  tool?: OpsChatToolName; // when set, tier comes from OPS_CHAT_TOOLS
  tier?: Tier; // required when tool is undefined
  label: string;
  run: (input: TInput, o: { dryRun: boolean }) => Promise<TResult>;
  dryRunSupported?: boolean; // shows DryRunPreview first
  preview?: (r: TResult) => ReactNode; // renders the dry-run result
  target?: (input: TInput) => string; // typed-confirm string
  invalidate: (input: TInput) => QueryKey[];
}): {
  execute(input: TInput): Promise<void>;
  isPending: boolean;
  phase: "idle" | "dry-run" | "confirm" | "running";
};
```

Behaviour:

- `read` → run, toast on error.
- `mutation-dry-run-safe` → if `dryRunSupported`, run `{dryRun: true}`,
  open `DryRunPreview` with `preview(result)`, then run wet on confirm;
  otherwise a one-line confirm.
- `mutation-destructive` → `TypedConfirm` requiring `target(input)` typed
  back, optional reason (recorded in the audit line once §6.7 of the UI plan
  lands).
- When `tool` is set, `run` is implemented as
  `operatorRunTool({name: tool, arguments, dryRun})` so the audit log
  receives the call; the raw mutation is used only for procedures without a
  tool. `opsChatTools` is queried once at start-up to expose the tier map to
  the renderer (`lib/tool-tiers.ts`), which also lets `ops-chat-coverage`
  style tests assert every UI action has a tool or an explicit tier.

Existing call sites to migrate in P0: `workloadDelete`, `nodeRemove`,
`compositeDestroy`, `projectRemove`, `promoteDelete`, `uninstall`,
`ragPipelineRemove`, `opsSessionDelete`, `serverStop`, `keepAliveStop`,
`reconcilerStart/Stop/Kick`.

### 4.4 Toasts

Add a `toast-store` (Zustand, transient) and a `<Toaster/>` in
`BeaconLayout`; `useTieredAction` and `useLiveStream` are its only
producers initially.

## 5. Shared primitives to add

Under `src/ui/`, styled with the existing tokens, each with a gallery entry
in `modules/ui-primitives` so the pixel gate covers them:

| primitive                               | used by                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `DataTable`                             | every list view (sortable, sticky header, row actions, empty state)      |
| `Drawer`, `Modal`                       | detail drawers, TypedConfirm, DryRunPreview                              |
| `TypedConfirm`                          | destructive tier                                                         |
| `DryRunPreview`                         | dry-run-safe tier (renders diff / DAG / plan)                            |
| `Toast`                                 | action outcomes                                                          |
| `StreamPanel`                           | `useLiveStream` consumers                                                |
| `JournalTable`                          | ops-chat audit, healer, fleet, tunnel, routing, RAG, cost journals       |
| `JsonView`                              | drawers, audit lines, facts                                              |
| `ManifestEditor`                        | ModelRun / ModelHost / NodeRun / Composite / RagPipeline / Project YAML  |
| `DiffView`                              | apply preview (desired vs observed), infra activate                      |
| `EntityLink`                            | `node:` `workload:` `composite:` `project:` `session:` `proposal:` chips |
| `TierChip`, `PhaseChip`, `PressureChip` | shared vocabulary with CLI output                                        |
| `NodeScopeBar`                          | module headers (§3)                                                      |
| `CopyCommand`                           | local-only CLI operations                                                |
| `EmptyState`, `ErrorState`              | consistent zero-data / failure rendering                                 |

## 6. Coverage tests

Two additive tests in `packages/app/test`:

1. **Procedure coverage** — import the router type keys (runtime:
   `Object.keys(appRouter._def.procedures)`), the union of
   `APP_MODULES[].procedures`, and `EXCLUDED_PROCEDURES` (with a reason
   string each: `chatComplete` "used by MCP pipeline stubs only", …). Fail if
   any router key is in neither set, or if a listed procedure has no textual
   reference under `packages/app/src` (same grep approach as the inventory).
2. **Tier coverage** — for every `OPS_CHAT_TOOLS` entry, assert some module
   declares a `useTieredAction` with that `tool` (collected via a static
   registry `ACTIONS` exported from each `api.ts`). Mirrors
   `packages/mcp/test/smoke.test.ts:ops-chat-coverage` from the UI side.

Both run under `bun run --cwd packages/app test`; the existing
`ui-audit-modules-drift.test.ts` keeps the registry ↔ JSON ↔ baseline
triangle honest for new modules.

## 7. Migration sequence

Each step is a PR that leaves the app shippable and the pixel gate green
(baselines re-seeded only for modules whose chrome intentionally changed).

- **P0.1 Registry capability fields.** Add optional `tabKinds`,
  `explorerChildren`, `commands`, `useBadge`, `useStatusItems`, required
  `procedures`; fill `procedures` for the 22 modules from the inventory;
  land the procedure-coverage test with today's 40 unused procedures in
  `EXCLUDED_PROCEDURES` tagged `todo:P0` so the list can only shrink.
- **P0.2 Shell generalisation.** `TAB_KINDS` map, `DynamicTabRouter` from
  registry, Explorer children from registry, palette commands from
  registry, rail badges. Move `workload`/`node`/`ops-session` detail
  components under their modules.
- **P0.3 Action layer.** `lib/tool-tiers.ts` (from `opsChatTools`),
  `useTieredAction`, `TypedConfirm`, `DryRunPreview`, `Toast`; migrate the
  destructive and dry-run-safe call sites listed in §4.3; replace bare
  `invalidateQueries()`.
- **P0.4 Live layer.** `useLiveStream` + `StreamPanel`; migrate logs, server
  start, composite status, bench, pulls.
- **P0.5 Node scope.** `NodeScopeBar`, `useNodeScope`, `uiFanOut` with the
  read allowlist; fleet tiles on Dashboard via `fleetSnapshot` fan-out.
- **P0.6 Primitives.** `DataTable`, `Drawer`, `JsonView`, `JournalTable`,
  `EntityLink`, chips, `CopyCommand`, `EmptyState`; gallery entries +
  baselines.
- **P1+** — module PRs per the UI plan's phases, each adding: registry
  entry, `api.ts` with keys + `ACTIONS`, views, `tests/ui-audit-modules.json`
  row, baseline PNG, and removals from `EXCLUDED_PROCEDURES`.

## 8. Electron-only today — options for a "web console"

The request is for a web console; the app is Electron-only. Three options,
in increasing cost:

1. **Stay Electron, add remote reach.** The dispatcher already talks to
   remote agents over pinned HTTPS and the tunnel relay; nothing in the UI
   plan requires a browser. Zero transport work; operators need the packaged
   app.
2. **Serve the renderer from the agent.** Add a `/console` static mount to
   `packages/remote/src/server/serve.ts` serving `packages/app/out/renderer`,
   and give `lib/trpc.ts` a second link set: `httpBatchLink` +
   `unstable_httpSubscriptionLink` (split on `op.type === "subscription"`)
   against `/trpc` with the kubeconfig bearer, selected when
   `window.electronTRPC` is absent. Node addressing moves from the Electron
   main process to the agent (the agent's router is already per-node; `all`
   fan-out would need a control-plane endpoint). Requires: bearer entry UI,
   CSP for the static mount, and §6.7 operator identity because the token is
   shared. Renderer code is already Bun-free (`renderer-no-bun.test.ts`) and
   uses only the IPC link, so the split is contained to `lib/trpc.ts`,
   `lib/ipc-link.ts` and the `uiSetActiveNode` pair.
3. **Central control-plane web app.** A new `packages/console-web` served by
   a central that owns kubeconfig and fans out; the Electron dispatcher's
   logic (`dispatcher.ts`, `cross-node-fan-out.ts`, `node-pinned-fetch.ts`)
   moves server-side. Largest change; the right end state if several
   operators share a fleet.

Recommendation: execute the UI plan on Electron (option 1) — every module
is transport-agnostic through tRPC React Query — and carry option 2 as a P3
item gated on §6.7 of the UI plan. Decide option 3 only if multi-operator
use becomes real.

## 9. Risks

- **Pixel gate churn.** Shell changes (badges, NodeScopeBar, toasts) touch
  every baseline. Land P0.2/P0.5 chrome behind a flag defaulting off until
  the module PRs re-seed baselines in one sweep (`bun run audit:update`).
- **Registry typing.** `procedures: (keyof AppRouter[...])[]` needs the
  dispatcher router type; `lib/trpc.ts` already imports `AppRouter` from
  `electron/trpc/router`, but the composite-declaration portability issue
  noted there may require exporting a plain `ProcedureName` union from
  `@llamactl/remote` instead.
- **Tier drift.** If the renderer caches `opsChatTools` and the registry
  changes, tiers could be stale; refetch on window focus for that one
  query and fail closed (treat unknown as destructive).
- **Fan-out cost.** `uiFanOut` on large fleets multiplies pinned-HTTPS
  calls; cap concurrency in `cross-node-fan-out.ts` and cache per node with
  the standard 30 s staleTime.
- **Audit passthrough gaps.** Procedures without an Ops Chat tool bypass
  `audit.jsonl` until they are added to `OPS_CHAT_TOOLS`; the tier-coverage
  test makes the gap visible rather than silent.
