# Global Search — Design

**Status:** Approved (brainstorm), pending implementation plan
**Date:** 2026-04-25
**Phase:** Beacon Phase 3 (post-renewal feature work)
**Replaces:** module-only `SearchView` and `searchModules` ranker; layers semantic search on top of `ragSearch`
**Spec scope:** sidebar `SearchView` and command palette both query a unified, three-tier (client substring, server lexical, server semantic) global search pipeline that spans every queryable surface in the app.

## Goal

Convert the app from browse-first to query-first. Typing a few characters returns ranked, grouped, snippet-bearing results across every surface a user spends time in: modules, ops sessions, workloads, nodes, knowledge entities, logs, presets, and tab history. Results combine exact matches (instant or sub-300 ms) with semantic matches (sub-500 ms once a RAG node is online), grouped by surface and ordered by the strongest hit.

## Background

Today the app has two search-ish surfaces:

- `SearchView` (sidebar, 80 lines) — substring rank over `APP_MODULES` only. Pure-function ranker `searchModules` is unit-tested (9 tests).
- `command-palette.tsx` (288 lines) — `⌘⇧P` palette, fuzzy module match plus curated commands (themes, View/New synonyms).

Neither searches runtime data. The renewal spec (`2026-04-23-beacon-ui-renewal-design.md` §13) explicitly defers a "real" search to "P3+". Phase 2 just shipped per-session journals at `~/.llamactl/ops-chat/sessions/<id>/journal.jsonl`, which now makes session content searchable for the first time. The repo also has first-class RAG infrastructure (`packages/remote/src/rag/` — Chroma + pgvector adapters, embedder, full ingestion pipeline runtime, `ragSearch`/`ragStore`/`ragDelete` tRPC procs); the Knowledge module already runs on top of it.

Phase 3 builds Global Search to consume both new and existing infrastructure: lexical matchers for fast/exact paths, the existing RAG layer for semantic recall over content-heavy surfaces.

## Decisions

### D1. Scope: every queryable surface

V1 covers eight surfaces: `module`, `session` (ops), `workload`, `node`, `knowledge`, `logs`, `preset`, `tab-history`. Each surface declares its kind once; the orchestrator dispatches on it.

### D2. Indexing: hybrid by surface size and update cadence

Each surface is `'client'` (small or already-cached lists) or `'server'` (large or freshly-fetched content):

- **Client** — `module`, `workload`, `node`, `preset`, `tab-history`. Renderer-side substring/word-boundary match against in-memory data.
- **Server** — `session`, `knowledge`, `logs`. tRPC procs invoked from the renderer.

A separate dimension: each server surface has a **lexical** matcher (Tier 2) and may have a **semantic** matcher (Tier 3) backed by `ragSearch`. Knowledge ships with both today; sessions and logs gain ingestion pipelines as part of this work.

### D3. UI: both sidebar and palette, with clear roles

- **Sidebar `SearchView`** — persistent, browsable, results stay until query changes. The "where is it?" surface.
- **Command palette `⌘⇧P`** — transient, quick-jump. Curated commands stay above search hits. The "go to it now" surface.

Both consume the same hook (`useGlobalSearch`) and renderer primitives. Surface prefixes (`session:audit`, `mod:dash`) work identically in both.

### D4. Result presentation: grouped by surface, ranked group order

Surfaces appear as group headers. Group order is determined by each group's best hit's score, not by a fixed surface order — `dashboard` puts the Modules group first, `audit fleet` puts the Sessions group first. Within a group, hits sort by score; ties break on `parentTitle` localeCompare.

### D5. Match snippets: multiple excerpts per source, nested

A single parent (one session, one knowledge entity, one log file) can produce multiple match excerpts. Each excerpt is its own `Hit` with a `match.snippet` and highlighted spans. The renderer collapses excerpts under a single parent row in the tree.

### D6. Async behavior: client-instant, server-debounced, semantic-debounced-deeper

Three tiers of latency, all measured from the *last* keystroke:

1. **Tier 1 — Client substring.** Synchronous on every keystroke. No network.
2. **Tier 2 — Server lexical.** Debounced 250 ms after the last keystroke. Substring/word-boundary match in `opsSessionSearch`, `logsSearch`, `knowledgeSearch` (the lexical variant).
3. **Tier 3 — Server semantic / RAG.** Debounced 400 ms after the last keystroke (independent timer; does not wait for Tier 2). Calls `ragSearch` against per-surface collections (`sessions`, `knowledge`, `logs`).

Tier 2 and Tier 3 timers run in parallel from the same anchor (last keystroke). Either can resolve first; whichever does merges into the live result set independently. Surface group ordering re-sorts on every merge (rare visual shift, acceptable per Q6-C).

### D7. RAG integration: layer 3, with graceful degradation

Tier 3 is opportunistic. A new query proc, `globalSearchRagStatus`, returns `{ sessions: bool, knowledge: bool, logs: bool }` reflecting whether a RAG node with each collection is configured on the active server. If a collection is unavailable, that surface's Tier 3 variant is skipped silently — no spinner, no error.

Two new ingestion pipelines extend the existing `rag/pipeline/` runtime:

- Pipeline `ops-sessions` writes into RAG collection `sessions` — subscribes to `sessionEventBus`; emits one draft record per `session_started`/`plan_proposed`/outcome event. Embedded text = `goal` ∪ `reasoning` ∪ `JSON.stringify(step.args)` ∪ outcome summary text. Terminal events (`done`/`refusal`/`aborted`) flush the session's record set.
- Pipeline `app-logs` writes into RAG collection `logs` — tails configured log files (default: ops-chat audit log + electron main log). Rolling 5 MB window per file; older records dropped. Polls every 30 s.

The pipeline name is the ingestion-pipeline identifier (used in `rag/pipeline/registry.ts`); the collection name is what `ragSearch` queries. Both pipelines reuse the existing scheduler/journal/store/runtime; only new fetchers are added.

### D8. Match-kind tagging and ranking bias

Each `Hit` carries `matchKind: 'exact' | 'semantic'`. The UI tags semantic rows visibly. Cross-surface ranking applies a small surface bias (`module: 0.20`, `session: 0.10`, `workload: 0.10`, `node: 0.10`, `preset: 0.05`, `knowledge: 0.05`, `logs: 0.00`, `tab-history: −0.05`) and a `−0.02` semantic-tie penalty so when an exact and a semantic hit score equal, the exact wins.

### D9. Same-parent collapse across tiers

If session `abc` matches lexically (Tier 2) and semantically (Tier 3), the renderer shows one parent row with both excerpts as nested children, each labelled with its `matchKind`. The orchestrator does this collapse on `parentId`.

## Architecture

### App side (`packages/app/src`)

```
lib/global-search/
├── types.ts                 SurfaceKind, Hit, SurfaceGroup, GroupedResults, ParsedQuery
├── query.ts                 parseQuery(input): { needle, surfaceFilter? }
├── ranking.ts               applySurfaceBias, sortGroups, semantic-tie penalty
├── orchestrator.ts          runGlobalSearch({ query, signal, trpcUtils }): AsyncIterable<GroupedResults>
├── hooks/
│   └── use-global-search.ts useGlobalSearch(input): { results, status }
└── surfaces/
    ├── modules.ts           CLIENT — wraps existing searchModules
    ├── workloads.ts         CLIENT — uses cached workloadList
    ├── nodes.ts             CLIENT — uses cached nodeList
    ├── presets.ts           CLIENT — uses cached presetList
    ├── tab-history.ts       CLIENT — uses tab-store.tabs + closed
    ├── sessions.ts          SERVER lexical — calls trpc.opsSessionSearch
    ├── sessions-rag.ts      SERVER semantic — calls trpc.ragSearch (collection: 'sessions')
    ├── knowledge.ts         SERVER lexical — calls trpc.knowledgeSearch (lexical)
    ├── knowledge-rag.ts     SERVER semantic — calls trpc.ragSearch (collection: 'knowledge')
    ├── logs.ts              SERVER lexical — calls trpc.logsSearch
    └── logs-rag.ts          SERVER semantic — calls trpc.ragSearch (collection: 'logs')

shell/beacon/
├── search-view.tsx          MODIFY — replace module-only logic with the orchestrator hook
├── search-results-tree.tsx  NEW — sidebar grouped-tree renderer
└── ...

shell/
├── command-palette.tsx      MODIFY — same hook below the curated command list
└── match-snippet.tsx        NEW — render snippet text with bolded spans
```

### Server side (`packages/remote/src`)

```
search/
├── text-match.ts            findTextMatches({ needle, text, ... }): TextMatch[]
├── sessions.ts              walks journal.jsonl files, runs findTextMatches
├── knowledge.ts             lexical scan over entity titles + body excerpts
├── logs.ts                  rolling-window lexical scan
├── rag-bridge.ts            maps { surface, query } → ragSearch({ collection, query, topK })
└── types.ts                 SessionHit, KnowledgeHit, LogHit (subset of app's Hit)

rag/pipeline/fetchers/
├── sessions.ts              NEW — subscribes to sessionEventBus, drafts records
└── logs.ts                  NEW — tail-and-window log fetcher

router.ts                    MODIFY — add procs:
  opsSessionSearch:        Tier 2 lexical
  logsSearch:              Tier 2 lexical
  knowledgeSearch:         Tier 2 lexical (existing knowledge already has RAG; this is the lexical sibling)
  globalSearchRagStatus:   Tier 3 health probe
  // ragSearch (existing) serves Tier 3 directly
```

### Result schema

```ts
export type SurfaceKind =
  | 'module' | 'session' | 'workload' | 'node'
  | 'knowledge' | 'logs' | 'preset' | 'tab-history';

export interface Hit {
  surface: SurfaceKind;
  parentId: string;
  parentTitle: string;
  score: number;
  matchKind: 'exact' | 'semantic';
  ragDistance?: number;
  match?: {
    where: string;
    snippet: string;
    spans: { start: number; end: number }[];
  };
  action:
    | { kind: 'open-tab'; tab: TabEntry };
  // 'open-tab-and-scroll' with an anchor is a reserved schema variant for a
  // future phase (see "Out of scope: Highlight match in the destination tab");
  // not produced by any v1 surface.
}

export interface SurfaceGroup {
  surface: SurfaceKind;
  hits: Hit[];
  topScore: number;
  pending?: boolean;
  /** Surface-level error, if a tier failed for this surface. */
  error?: string;
}

export type GroupedResults = SurfaceGroup[];
```

### Cross-surface ranking

```ts
const SURFACE_BIAS: Record<SurfaceKind, number> = {
  module: 0.20,
  session: 0.10,
  workload: 0.10,
  node: 0.10,
  preset: 0.05,
  knowledge: 0.05,
  logs: 0.00,
  'tab-history': -0.05,
};
const SEMANTIC_TIE_PENALTY = -0.02;
```

`finalScore = surface.localScore + SURFACE_BIAS[surface] + (matchKind === 'semantic' ? SEMANTIC_TIE_PENALTY : 0)`. Group `topScore` = `max(hit.finalScore)`. Groups sort by `topScore` desc.

### Server-side text matcher

`findTextMatches` is the single shared text matcher used by every Tier 2 lexical surface. It is case-insensitive by default, optionally word-boundary, optionally case-sensitive; returns 0..N matches per text with snippet + spans + a per-match score. Snippets default to 120 characters around the match.

### RAG bridge

`packages/remote/src/search/rag-bridge.ts` is a thin adapter. Given `{ collection: 'sessions' | 'knowledge' | 'logs', query: string, topK: number }`, it calls `ragSearch` (resolving the embedder via the existing per-node logic) and returns normalized `SessionHit`/`KnowledgeHit`/`LogHit` records carrying `ragDistance` and a `where` string derived from the embedded record's metadata. If no RAG node is configured for the collection, returns `[]`.

`globalSearchRagStatus` queries `ragListCollections` on each candidate node and reports collection-presence as booleans.

## Data flow

### Lifecycle (single keystroke)

```
user types in SearchView or palette
  └─ useGlobalSearch(query):
       1. parseQuery(query) → { needle, surfaceFilter? }
       2. Tier 1 (sync): for each client surface in scope:
            hits ← surface.clientMatch(needle, cachedItems)
          merge → setResults(GroupedResults with pending: true on server groups)
       3. Tier 2 (debounce 250ms):
            for each server lexical surface in scope, in parallel:
              trpc.<surface>Search.fetch({ query: needle, limit: 30 })
            merge each as it resolves; drop pending on that group
       4. Tier 3 (debounce 400ms):
            check globalSearchRagStatus (cached for the session)
            for each available collection in scope, in parallel:
              trpc.ragSearch.fetch({ collection, query: needle, topK: 10 })
            merge each as it resolves; collapse same-parentId hits with Tier 2
       5. on next keystroke before debounce(s):
            cancel pending Tier 2 + Tier 3 fetches via AbortController
            restart from step 2
```

The hook owns one AbortController and tears it down on unmount or query change. Re-renders happen at the merge points.

### Multi-tab consistency

Every `useGlobalSearch` hook instance is independent. Multiple sidebars / multiple palettes can run concurrent queries against the same server with no shared client-side state.

### Edge cases

- **Empty query** → return `[]`; renderer shows first-run guidance.
- **Surface filter with zero hits** → return one empty group `{ surface, hits: [], pending: false }` so the renderer can render a per-surface "no `session:` hits".
- **Server matcher throws** → group gets `{ pending: false, error: '...' }`; other surfaces stay green. Renderer shows per-group inline error.
- **AbortController fires after a response started writing** → race-tolerant: results from a stale query are discarded by checking the hook's current query token before merging.
- **No RAG node configured** → Tier 3 is silently absent. Tiers 1+2 run normally.
- **Index lag** → a session that finished 5 s ago appears in Tier 2 immediately but in Tier 3 only after the `ops-sessions` pipeline indexes it (~30 s typical). Same-parent collapse means once the semantic match arrives, it appears as a nested excerpt under the already-visible Tier 2 parent row.

## Error handling

- **Disk-full when a fetcher tries to draft a record:** the pipeline's existing error path (`rag/errors.ts`) kicks in; Tier 3 stops indexing new content but querying continues against existing records.
- **Embedder unavailable mid-query:** Tier 3 surface returns `error: 'embedder timeout'` for that group only; other surfaces unaffected.
- **Malformed journal mid-walk:** the lexical scanner reuses `readJournal`'s skip-malformed-line behaviour; never throws to the caller.
- **AbortSignal mid-fetch:** every server matcher honours the signal; partial work is dropped; no half-written state.

## Testing

### Server (`packages/remote`)

| Test | Coverage |
|---|---|
| `search-text-match.test.ts` | Snippet extraction; word-boundary mode; multi-match dedupe; case sensitivity flag; span correctness |
| `search-sessions.test.ts` | Walks fixture journal directory; respects per-session 5-match cap and 30-session cap; matches across goal/reasoning/args/outcome fields |
| `search-knowledge.test.ts` (lexical) | Title vs body match scoring; cap respected |
| `search-logs.test.ts` | Last-N-bytes window; multi-line match spans; multi-file fan-in |
| `rag-bridge.test.ts` | Collection routing; topK parameter; normalization to SessionHit/KnowledgeHit/LogHit |
| `rag-pipeline-sessions-fetcher.test.ts` | Subscribes to mock event bus; drafts correct records per event; flushes on terminal |
| `rag-pipeline-logs-fetcher.test.ts` | Tail mode; rolling-window eviction; multi-file fan-in |
| `router/global-search-procs.test.ts` | `opsSessionSearch`, `logsSearch`, `knowledgeSearch` (lexical), `globalSearchRagStatus` return well-formed payloads; abort propagates |

All run under the existing hermetic `LLAMACTL_TEST_PROFILE` / `DEV_STORAGE` pattern.

### App (`packages/app`)

| Test | Coverage |
|---|---|
| `lib/global-search/query.test.ts` | Surface prefixes, multi-word queries, alias resolution (`mod:` ≡ `module:`), trim/lowercase semantics |
| `lib/global-search/ranking.test.ts` | Surface bias map applied; group topScore; group sort under various inputs; semantic-tie penalty |
| `lib/global-search/orchestrator.test.ts` | Tier 1 sync, Tier 2 debounce, Tier 3 debounce, AbortSignal cancellation, race tolerance, same-parent collapse, RAG-status disables surface |
| `lib/global-search/surfaces/modules.test.ts` | Wraps `searchModules`; produces well-formed `Hit`s |
| `lib/global-search/surfaces/workloads.test.ts` | Matches name/model fields; correct action |
| `lib/global-search/surfaces/tab-history.test.ts` | Includes both `tabs` and `closed`; deduplicates by `tabKey` |
| `lib/global-search/surfaces/sessions-rag.test.ts` | Maps `ragSearch` response → `Hit` with `matchKind: 'semantic'` and `ragDistance` populated |
| `lib/global-search/use-global-search.test.ts` | Hook timer/abort orchestration under sequenced inputs (pure logic; no React render) |

Component visual rendering (sidebar tree, palette row layout, snippet highlighting, semantic-tag pill) is verified via the two Tier C UI flows below — matching the testing posture from Phase 2.

### UI flow tests (`tests/ui-flows/`)

Two new flows under the existing electron-mcp driver, registered in the Tier C nightly suite via `scripts/smoke-ui-flows.sh`:

1. `global-search-flow.ts` — seed a journal fixture, type into sidebar `SearchView`, verify Tier 1 + Tier 2 grouped results appear, click hit, verify tab opens. Tier 3 is exercised when a RAG fixture is available; otherwise that assertion is a graceful SKIP.
2. `palette-search-flow.ts` — open palette, type a session-prefix query, verify filtered results, hit Enter, verify navigation.

Both follow the SKIP-guard pattern: any selector miss converts to graceful skip rather than failing the nightly run.

## Rollout

Single PR, all-or-nothing — the architecture is genuinely entangled (orchestrator, surfaces, renderer, server procs, ingestion pipelines all touch each other). Tag `beacon-p3-global-search`.

**Pre-merge sequence:**
1. Server text-match + lexical search procs + fetchers + RAG bridge + new router procs.
2. App types, query, ranking, orchestrator (no React), surfaces.
3. App hook, renderer, SearchView wiring, palette wiring.
4. Tier C UI flows.
5. Final tag + merge.

**Migration / data:** none. Existing `searchModules` keeps its job inside `surfaces/modules.ts` (wrapped, not replaced); existing tests stay green. New ingestion pipelines (`ops-sessions`, `app-logs`) start cold — first session/log indexed after they run for the first time. No backfill needed.

**Graceful degradation, day one.** No RAG node configured → Tier 3 absent silently. The default fresh-install path runs Tiers 1+2 with no errors.

## Out of scope (deferred)

- **Vector reranking** beyond the simple bias + tie penalty. Learned reranker, distance-curve aware merging — Phase 4 candidates once usage data exists.
- **Faceted filtering** in the result panel (date range, status, tier). Surface filters in the query are enough for v1.
- **Saved searches / pinned queries.**
- **Highlight match in the destination tab.** Clicking a session hit opens the ops-session tab but doesn't auto-scroll to the matched event. Adding `anchor` semantics through tab-store is a Phase 4 ergonomic.
- **Cross-node search.** When the gateway story lands, sessions/logs may live on multiple nodes. v1 searches the single connected node.
- **Offline embeddings cache.** Tier 3 requires a live RAG node; no client-side embedding fallback.
- **Search analytics / query logging.** Queries are ephemeral.
- **Vector index for `modules`/`workloads`/`nodes`/`presets`.** These stay client-side substring forever — semantic match has no value for short labels.

## Success criteria

1. Typing in the sidebar `SearchView` returns instant Tier 1 hits while typing; Tier 2 hits appear within ~250 ms of last keystroke; Tier 3 hits appear within ~400 ms when a RAG node is available.
2. Cross-surface results group by surface kind, ordered by group's best hit. Each parent row collapses multiple matches into nested excerpt rows.
3. Surface filters work in both sidebar and palette: `session:audit`, `wl:llama-31`, `mod:dash`, `kb:retrieval`, `log:error`.
4. Same-parent matches from Tier 2 lexical and Tier 3 semantic collapse into one parent row with both excerpt children, each tagged.
5. With no RAG node configured: search still works, Tier 3 surfaces are absent silently, no errors.
6. New session created in Ops Chat appears in Tier 2 lexical results within 1 s; in Tier 3 semantic results within ~30 s after the `ops-sessions` pipeline indexes it.
7. Existing tests stay green: `searchModules` (9), `bucketTabsByAge` (8), `dynamic-tab-router` (9), the broader 79 app + 1278 server test baselines, plus all new tests.
8. Two Tier C UI flows (`global-search-flow`, `palette-search-flow`) PASS or gracefully SKIP under the existing harness.
