# Phase 3 Follow-on — Cross-Node Search + Knowledge Tier 2 Cleanup

**Status:** Approved (brainstorm), pending implementation plan
**Date:** 2026-04-26
**Phase:** Beacon Phase 3 follow-on (closes the deferred items from `2026-04-25-global-search-design.md`)
**Spec scope:** Fan out `opsSessionSearch` and `logsSearch` across every kubeconfig agent node (not just the connected one), surface per-hit origin and per-query unreachable-nodes UI signal, and remove the dead `knowledgeSearch` Tier 2 proc.

## Goal

Close the two acknowledged Phase 3 v1 gaps:

1. **Cross-node search** — sessions and logs are intrinsically per-agent (each agent owns its `~/.llamactl/ops-chat/sessions/` and configured log files). Today search runs only against the connected agent. Fan out so a query hits all agent nodes in kubeconfig in parallel; merge results; surface per-hit origin tag and a footer when nodes are unreachable.
2. **Knowledge Tier 2 cleanup** — the `knowledgeSearch` proc returns `[]` because no lexical knowledge store exists in this codebase (knowledge is RAG-only). Remove the dead proc and its orchestrator call site.

## Background

`docs/superpowers/specs/2026-04-25-global-search-design.md` shipped a three-tier search (client substring, server lexical, server semantic) with two explicit deferrals in §"Out of scope":

- "Cross-node search. When the gateway story lands, sessions/logs may live on multiple nodes. v1 searches the single connected node; cross-node fan-out is a separate slice."
- The Tier 2 `knowledgeSearch` proc was wired to a `searchKnowledge` helper that takes `entities` as input. The Phase 3 plan's Task 9 step 3 noted that no list-proc returns those entities (knowledge in this codebase is RAG-shaped via `ragSearch`/`ragListCollections`/`ragStore`/`nodeUpdateRagBinding`, not a separate entity list). The proc was committed with a `return { hits: [] }` body.

This follow-on closes both. The user's actual deployment today is two agent nodes (`local` + `mac-mini`); plausible near-term growth is 5–10 agents. Cross-node fan-out targets that scale; circuit-breakers and capped concurrency for fleets of dozens are out of scope (defer until usage demands).

Knowledge, in actual deployment, is centralized at one RAG endpoint (`kb-chroma` at `localhost:8000` from `local`'s perspective). Multi-node RAG fan-out is not the operating shape and is also deferred — adding it later is a single new orchestrator surface, not a rearchitecture.

## Decisions

### D1. Knowledge Tier 2 — drop entirely

Remove the `knowledgeSearch` proc from `packages/remote/src/router.ts` and its orchestrator surface in `packages/app/src/lib/global-search/surfaces/knowledge.ts`. The `searchKnowledge` helper in `packages/remote/src/search/knowledge.ts` stays as-is — it's a pure function that's still exported, has tests, and may be reused by a future re-introduction (Option C from the brainstorm) without disturbing this slice. Tier 3 (`ragSearch`) remains the only knowledge-search surface.

Reasoning: Tier 2 was designed for surfaces where lexical scan is cheap (small JSONL files on local disk for sessions, last-N-bytes window for logs). Knowledge entities live behind a vector store via RPC; "lexical" there means another network hop + a scan. We'd pay Tier 2's latency budget without delivering its "instant" promise. `ragSearch` already returns near-exact-text matches because vector similarity captures both semantic and literal proximity.

### D2. Cross-node scope — sessions + logs

Fan out `opsSessionSearch` and `logsSearch` only. Knowledge stays single-node (today's actual deployment shape). RAG fan-out (multi-node `ragSearch`) is deferred — adding it later reuses the same fan-out infrastructure built here, with one extra surface module.

Reasoning: sessions and logs are per-agent by construction; cross-node fan-out is the natural shape and high-value (logs cross-node lets the operator inspect what happened on `mac-mini` at 3am without SSH). Knowledge is RAG-backed and currently has one endpoint; fanning to multiple RAG nodes multiplies embedder cost without delivering a use case the user actually has.

### D3. Concurrency + failure — all-parallel, partial-success with footer

Dispatch to all agent nodes in parallel. Each per-node fetch carries an `AbortSignal` racing against a per-node timeout (default 2000ms). Successful nodes' results merge in. Failed/timed-out nodes are captured as `failures: NodeFailure[]` and surfaced as a small footer in the affected surface group ("⚠ 2 nodes unreachable: mac-mini, atlas"). Other nodes' hits remain ranked normally. No fail-fast; no circuit breaker.

Reasoning: at fleet size 2–10, all-parallel handles the common case cleanly without per-query coordination overhead. Fail-fast (Option A) is untenable when one of two agents is sleeping. Capped concurrency + breaker (Option C) is appropriate at 50+ nodes — adding it later is a single-file change to the fan-out helper. YAGNI for the actual deployment.

### D4. Origin UI — subtle node tag, default-elide

Each hit gains an optional `originNode?: string`. The renderer shows the tag (small monospace span) on parent rows where `originNode !== <connected-agent-name>`; tag is elided otherwise. Cross-node hits get a visible disambiguator; local-only hits stay clean.

Reasoning: real disambiguation matters — two sessions both named "audit fleet" from `local` and `mac-mini` are different things. Hiding origin (Option A) creates ambiguity that forces a click. Group-by-node section headers (Option C) introduce a second grouping dimension that breaks Phase 3's already-decided "ranked group order" — re-litigating ranking semantics for a UX that grows unscannable as the fleet expands. Default-elide on the connected node mirrors VS Code's "show relative path when it disambiguates" pattern.

### D5. Connected-agent self-skip

The fan-out helper iterates `kubeconfig.clusters[].nodes` filtered to `kind === 'agent'` (or undefined kind, treating it as agent for backwards compat) and excludes the currently-connected node. Local search already covers it via the existing single-node path; calling self adds latency and duplicates results.

Reasoning: the connected agent is identified at hook level via the existing tab/context plumbing. Skipping it is one filter line; including it would require dedup logic across local+remote merges.

## Architecture

### Where fan-out lives

The app cannot directly invoke a tRPC proc against a non-default node — `packages/app/electron/trpc/dispatcher.ts` owns the per-node client cache (`clientCache`), keyed by `(endpoint + fingerprint + token)`. The renderer dispatches to whatever node is selected via `getActiveNodeOverride() ?? ctx.defaultNode`; there's no shape today that lets the renderer fan out across multiple nodes in a single query.

The existing `UIRouter` in `packages/app/electron/trpc/dispatcher.ts` (separate from the agent's `AppRouter`, exposed via `trpcUIClient` in `packages/app/src/lib/trpc.ts`) is exactly the right place: it's an Electron-main-side router with access to kubeconfig + the per-node client cache, and the renderer already calls it for `uiSetActiveNode`, `uiGetActiveNode`, etc. Cross-node fan-out becomes two new UI procs that enumerate agents (excluding the active one), fan out via the existing client cache, merge, and return.

### Electron main side (`packages/app/electron/trpc/`)

```
dispatcher.ts                 MODIFY
  Add two new procs to uiRouter:
    uiCrossNodeOpsSessionSearch
    uiCrossNodeLogsSearch
  Both take { query: string, perNodeTimeoutMs?: number } and
  return { hits, unreachableNodes } shaped per the schema below.
  Internally each proc:
    1. loadConfig() + currentContext()
    2. Enumerate agent nodes excluding the active node
       (active = getActiveNodeOverride() ?? ctx.defaultNode)
    3. For each peer node, build (or hit cache for) a pinned
       remote client via the existing clientCache infrastructure
    4. Call .opsSessionSearch.query({query}) / .logsSearch.query
       on each peer in parallel via fanOutSurface
    5. Tag each remote hit with originNode = node.name
    6. Return { hits: T[], unreachableNodes: string[] }

cross-node-fan-out.ts         ← NEW (pure module, sibling to dispatcher)
  Pure functions, no Electron/Node dependency in the API:
    listAgentNodes(cfg, activeNodeName): ClusterNode[]
      Filters cfg.clusters[].nodes (under currentContext) to
      agent-kind (or no kind set, treated as agent for backwards
      compat), excludes active.
    fanOutSurface<T>({
      nodes,
      perNodeFetch,         (node, signal) => Promise<T[]>
      perNodeTimeoutMs,     default 2000
      signal,               outer AbortController
    }): Promise<{ hits: T[]; failures: NodeFailure[] }>
      All-parallel dispatch via Promise.allSettled. Each node call
      gets a child AbortController racing the per-node timeout.
      Failures captured; outer abort short-circuits all in-flight.
```

### App side (`packages/app/src/lib/global-search/`)

```
types.ts                MODIFY
  Hit gains optional `originNode?: string`
  SurfaceGroup gains optional `unreachableNodes?: string[]`

ranking.ts              MODIFY (no behavior change; preserve `originNode` through merging)

orchestrator.ts         MODIFY
  mergeServerHits accepts and preserves `unreachableNodes` on the
  group it merges into.

surfaces/sessions.ts    MODIFY
  Mapping function unchanged in shape; gains an optional
  `originNode` parameter that flows through to each emitted Hit.
surfaces/logs.ts        MODIFY (same)
surfaces/knowledge.ts   DELETE (D1)

hooks/use-global-search.ts  MODIFY
  For sessions and logs, run two Tier 2 fetches in parallel:
    a. local: trpc.<surface>Search.fetch({ query }) (existing path)
    b. remote: trpcUIClient.uiCrossNode<Surface>Search.query({ query })
  Both share the same Tier 2 debounce anchor (250 ms after last
  keystroke). Local hits arrive without originNode; remote hits
  arrive already tagged. Both merge into the same SurfaceGroup;
  the remote response's unreachableNodes populates
  group.unreachableNodes.
```

### App side (`packages/app/src/shell/beacon/`)

```
search-results-tree.tsx     MODIFY
  - Render originNode tag on parent rows when present (cross-node
    hit). Local-only hits have no tag.
  - Render an unreachableNodes footer below the group's hits
    ("⚠ 2 nodes unreachable: mac-mini, atlas")
```

### Server side (`packages/remote/src/router.ts`)

```
knowledgeSearch          DELETE (D1)
opsSessionSearch         UNCHANGED — already returns hits for the
                         single agent it runs on; fan-out happens
                         in the UI router, never on the agent
logsSearch               UNCHANGED — same
```

### Schema additions

```ts
// packages/app/src/lib/global-search/types.ts

export interface Hit {
  // ...existing fields...
  /** Source agent for cross-node hits. Undefined when the hit came
   *  from the currently-connected agent (renderer elides the tag). */
  originNode?: string;
}

export interface SurfaceGroup {
  // ...existing fields (surface, hits, topScore, pending, error)...
  /** Agent node names that did not return results in time, or
   *  rejected the request, during the fan-out wave for this surface.
   *  Renderer surfaces as a small footer; does not block other hits. */
  unreachableNodes?: string[];
}

// packages/app/src/lib/global-search/fan-out.ts

export interface NodeFailure {
  nodeName: string;
  reason: 'timeout' | 'rejected' | 'aborted';
  detail?: string;
}
```

### Result types (in `fan-out.ts`)

```ts
export interface FanOutOpts<T> {
  /** Agent nodes to dispatch to; caller has already excluded self. */
  nodes: readonly ClusterNode[];
  /** Per-node fetcher. Receives the node and an AbortSignal scoped
   *  to this node's per-node timeout. Returns hits or throws. */
  perNodeFetch: (node: ClusterNode, signal: AbortSignal) => Promise<T[]>;
  /** Per-node timeout in milliseconds; default 2000. */
  perNodeTimeoutMs?: number;
  /** Outer abort signal — cancels every in-flight node call. */
  signal?: AbortSignal;
}

export interface FanOutResult<T> {
  hits: T[];
  failures: NodeFailure[];
}

export async function fanOutSurface<T>(
  opts: FanOutOpts<T>,
): Promise<FanOutResult<T>>;
```

## Data flow

### Lifecycle (single keystroke, cross-node)

```
user types in SearchView or palette
  └─ useGlobalSearch(query):
       1. parseQuery → { needle, surfaceFilter? }
       2. Tier 1 (sync): client-side surfaces — unchanged from Phase 3
       3. Tier 2 (debounce 250 ms — single anchor for both waves below):
          for each tier-2 surface (sessions, logs):
            a. local fetch (existing path): trpc.<surface>Search.fetch({query})
            b. remote fan-out: trpcUIClient.uiCrossNode<Surface>Search
                 .query({ query, perNodeTimeoutMs: 2000 })
               (the UI router does the parallel iteration, merge, and
                origin-tagging; the renderer just receives a flat
                { hits, unreachableNodes })
            c. as each promise settles, mergeServerHits the result into
               the surface's group: append:true; preserve and propagate
               unreachableNodes onto group when the remote fetch returns.
       4. Tier 3 (debounce 400 ms): unchanged from Phase 3 (knowledge is
          single-node ragSearch).
       5. on next keystroke before debounce: cancel via AbortController,
          restart from step 2. The UI proc honors signal cancellation by
          forwarding it into every per-node child AbortController.
```

### What happens in the UI router

```
uiCrossNodeOpsSessionSearch({ query, perNodeTimeoutMs }):
  1. cfg = loadConfig()
  2. ctx = currentContext(cfg)
  3. activeName = getActiveNodeOverride() ?? ctx.defaultNode
  4. nodes = listAgentNodes(cfg, activeName)
  5. fanOutSurface({
       nodes,
       perNodeFetch: async (node, signal) => {
         const client = getOrBuildClient(node, ctx.user)   // reuses clientCache
         const res = await client.opsSessionSearch.query({ query }, { signal })
         return res.hits.map((h) => ({ ...h, originNode: node.name }))
       },
       perNodeTimeoutMs: perNodeTimeoutMs ?? 2000,
       signal: ctxSignal,                                  // optional outer
     })
  6. return { hits, unreachableNodes: failures.map(f => f.nodeName) }
```

### Cross-tier merging

Same-`parentId` collapse from Phase 3 still applies. A session matching both lexically (Tier 2 from any node) and semantically (Tier 3 RAG) collapses by `parentId` into one parent row with multiple match excerpts; the renderer collapses visually. Local Tier 2 hits and remote Tier 2 hits for the same `parentId` would only collide if two agents have the same session id (ULID collisions are negligibly rare; if it happens, the renderer treats them as one parent with merged matches, which is the desired behavior).

### Per-node fetch shape

The hook builds a `callPeerNode(node, signal)` factory that returns a thin tRPC client targeting `node.endpoint` with the kubeconfig user's token. This reuses the existing `createNodeClient(cfg, { nodeName })` pattern from `packages/remote/src/client/node-client.ts` — same pinned-cert TLS, same bearer auth. The hook holds one client per node for the duration of a query (rebuilt on next keystroke; tRPC clients are cheap).

### Self-skip

`listAgentNodes(cfg, connectedNodeName)`:

```ts
const ctx = currentContext(cfg);
const cluster = cfg.clusters.find((c) => c.name === ctx.cluster)!;
return cluster.nodes.filter((n) => {
  // exclude non-agents
  const kind = (n as { kind?: string }).kind ?? 'agent';
  if (kind !== 'agent') return false;
  // exclude the connected node
  if (n.name === connectedNodeName) return false;
  return true;
});
```

`connectedNodeName` is read from the existing context (`ctx.defaultNode`).

## Error handling

- **Per-node timeout** → `NodeFailure { reason: 'timeout' }`. Other nodes' results unaffected. Footer reads "⚠ 1 node unreachable: mac-mini".
- **Per-node TLS or auth rejection** → `NodeFailure { reason: 'rejected', detail: <error message> }`. Same footer treatment.
- **Outer AbortController fires** → all in-flight per-node calls cancelled via their child signals. Hook drops stale results via the existing query-token check.
- **Empty agent-node list** → fan-out is a no-op; no remote wave runs. Local-only behavior is unchanged from Phase 3.
- **No connected node resolvable** (kubeconfig empty or context broken) → existing Phase 3 single-node path already errors out at the trpc utils layer; fan-out doesn't fire.
- **Unauthenticated peer agent** (token mismatch on a peer) → looks like `'rejected'` to the fan-out helper; surfaces in the footer. Operator runs `agent rotate-token` on that peer (the new CLI from earlier today) to recover.

## Testing

### Electron main / cross-node (`packages/app/test/electron/trpc/`)

| Test | Coverage |
|---|---|
| `cross-node-fan-out.test.ts` | `listAgentNodes` filters non-agents (kind === 'gateway' / 'rag') and excludes the active node; treats nodes with no `kind` field as agents (backwards compat). `fanOutSurface` — pure function tests with a mock `perNodeFetch`: all-succeed returns merged hits, per-node timeout produces `{ reason: 'timeout' }` failure while other nodes still merge, per-node rejection produces `{ reason: 'rejected', detail }`, outer abort short-circuits in-flight fetches, empty `nodes` returns `{ hits: [], failures: [] }` instantly |
| `dispatcher-cross-node.test.ts` (new) | `uiCrossNodeOpsSessionSearch` proc — drives the UI router via a stub `loadConfig` + a stub per-node client factory; verifies origin-tag flows onto each hit; verifies `unreachableNodes` propagates from `failures` |

### App (`packages/app/test/lib/global-search/`)

| Test | Coverage |
|---|---|
| `orchestrator.test.ts` (extend) | `mergeServerHits` preserves `unreachableNodes` when populated; `Hit.originNode` flows through merging unchanged |
| `use-global-search.test.ts` (extend) | new test for the parallel-wave scheduling — local fetch and the cross-node UI proc fire from the same Tier 2 anchor (250ms); both merge into the same SurfaceGroup; remote `unreachableNodes` lands on the group |

### Server

No new server tests. The existing `gateway-catalog-…` and `search-…` suites stay green untouched. The `searchKnowledge` helper test remains since the helper function is retained (just not wired to a proc).

### UI flow tests (`tests/ui-flows/`)

`global-search-flow.ts` (extend, not new): seed two agent fixtures — connected `local` with one session, "peer" `mac-mini` with another. Verify both sessions appear in results with the cross-node hit carrying its origin tag. Tier C nightly. SKIP-guard if the harness can't simulate a peer kubeconfig entry.

## Rollout

Single PR. Tag the merge `beacon-p3-cross-node-search`. No coordinated cross-repo work — sirius/embersynth/nova untouched. The `knowledgeSearch` proc deletion is a server-side change but its only consumer was the app's now-deleted `surfaces/knowledge.ts`; no external API breakage.

**Pre-merge sequence:**

1. `types.ts` schema additions (additive optional fields).
2. `fan-out.ts` pure module + tests.
3. Surface mapper updates (sessions, logs) to thread `originNode`.
4. Hook integration: parallel local + remote waves for sessions and logs.
5. Renderer: origin tag + unreachable-nodes footer.
6. `knowledgeSearch` proc deletion + `surfaces/knowledge.ts` deletion + orchestrator call-site removal.
7. Final regression sweep + tag + merge.

## Out of scope (deferred)

- **Multi-node RAG fan-out (knowledge across multiple RAG nodes).** Single RAG endpoint is the actual deployment shape today. Adding multi-RAG is one new surface module that reuses `fanOutSurface`; defer until usage demands.
- **Capped concurrency + circuit breaker.** Appropriate at fleet size 50+. v1 is all-parallel.
- **Per-node timeout configurable in settings.** Hard-coded 2000ms default. Tunable knob is a follow-up if real-world latencies vary.
- **Resurrected lexical knowledge search (Option C from the brainstorm).** Requires new adapter surface for direct vector-store entity scan; defer until usage proves it's wanted.
- **Cross-node origin filtering** (`session:audit @mac-mini` to scope to a single peer). The existing surface filters are enough for v1; node-scoping is a future query-syntax addition.
- **Faceted UI controls for cross-node toggles** ("only this node" / "all nodes"). All-nodes-by-default is the only mode v1 ships.

## Success criteria

1. With two agents in kubeconfig (`local` + `mac-mini`), typing a query that matches sessions on both produces a unified result list. Hits from `mac-mini` carry an `originNode` tag visible to the operator; hits from `local` (the connected agent) do not.
2. With `mac-mini` unreachable (laptop closed, network partition), the query returns `local` hits within Tier 2's 250ms anchor + `local` round-trip; the affected surface group's footer reads "⚠ 1 node unreachable: mac-mini" within 2s of the keystroke (the per-node timeout).
3. With both agents responsive, total Tier 2 time is dominated by `max(local-rtt, peer-rtt)` not `sum(...)` — fan-out is parallel.
4. The `knowledgeSearch` proc no longer exists in `router.ts`; the `surfaces/knowledge.ts` file no longer exists; existing app tests stay green; `bunx tsc -p packages/app/tsconfig.web.json --noEmit` count unchanged from baseline.
5. Tier 3 knowledge search (`ragSearch`) is unaffected and continues to return semantic hits as in Phase 3.
6. Cross-repo regression sweep stays green: llamactl unchanged at its current baseline, sirius/embersynth/nova counts unchanged.
