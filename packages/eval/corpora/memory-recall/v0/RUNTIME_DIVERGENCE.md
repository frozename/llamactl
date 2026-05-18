# `memory_search_explain` vs live `memory_search` MCP — divergence demo

Llamactl-side pilot of penumbra ask #4 (per
`docs/notes/penumbra-mining-asks-2026-05-18.md`). The `memory_search_explain.py`
script wraps the same `[A-Za-z0-9]+ OR-fanout` rewriter the existing
miners (`mine_t0.py`, `synth_t2.py`) use, then runs the rewritten query
directly against `t2_fts` and returns BM25-scored candidates.

This file records two side-by-side queries to demonstrate the divergence
between the llamactl-side rewriter and the live `mcp__penumbra__memory_search`
tool — which is exactly the corpus-vs-runtime gap ask #4 wants to close.

## Query 1: `"chain_start dispatching parallel agents"`

### Llamactl-side (`memory_search_explain.py --k 3`)

```
fts_query: "chain OR start OR dispatching OR parallel OR agents"

1. b510dc3f… "Long-lived agents must use `trust=all` in chain_start"   bm25=-11.27   (t2)
2. f229ef13… "Penumbra chain_start requires trust=all for sandboxed…"  bm25=-10.30   (t2)
3. 23c4ee92… "Chain Start Trust Requirement"                            bm25= -9.64   (t2)
```

### Live `mcp__penumbra__memory_search(limit=3)`

```
1. 606801d7…  <recent-relevant-context …> snippet shows chain_start tool-use   bm25=-16.90   (t1)
2. b8cf24b5…  <recent-relevant-context …> snippet shows chain_start tool-use   bm25=-16.31   (t1)
3. 0ac0402c…  "Session summary — 2026-05-08 am"                                bm25=-13.82   (t1)
```

**Divergence: 3/3 candidates differ.** The MCP tool returns t1
(recent-context bundles) exclusively; the direct rewriter returns t2
(persistent knowledge) exclusively. Same query string, completely
disjoint candidate sets, completely different bm25 score scales.

## Query 2: `"memory verification audit trail"`

### Llamactl-side

```
fts_query: "memory OR verification OR audit OR trail"

1. 690aeaad… "Lane-close memory verification capped per tick"   bm25=-8.89   (t2)
2. 44dbaa8d… "Audit of synthetic `memory_ignored` rows"          bm25=-8.88   (t2)
3. 837f01dd… "Test harness now injects shared TaskEventBus"      bm25=-6.45   (t2)
```

### Live `mcp__penumbra__memory_search(limit=3)`

```
{ "hits": [] }
```

**Divergence: 3 vs 0 hits.** The MCP tool returns *nothing* on a query
the direct rewriter finds 3 topical t2 matches for. The MCP layer is
filtering or scoring in a way that drops every candidate that BM25
would surface; the cause is opaque from the caller side.

## Why this matters for bench corpus quality

`mine_t0.py` builds the weak-gold half of the memory-recall corpus by
extracting `memory_search` queries from `t0_events` and labeling the
BM25-top-1 hit as the gold. **But that's BM25-against-t2_fts**, which
the divergence above shows is not what `memory_search` itself returns.

So today's weak-gold rows are scored against "what BM25 would have
recommended in a counterfactual world where the rewriter and tier
selection looked like mine_t0.py's" — not against what the agent
actually saw when it ran the search.

For the corpus to measure runtime retrieval accuracy (the thing we
actually care about), the labeler needs the *same rewriter + tier
selection + scoring* the live system uses. Today it doesn't.

## What ask #4 unlocks

If penumbra lands `memory_search_explain(query) → {fts_query, candidates, scores}`
exposing the live system's rewriting + tier-blending + scoring as a
pure function, miners can:

1. Reproduce the agent's exact ranking when extracting gold.
2. Re-label past `t0_events` queries with the runtime gold instead of
   the BM25 weak-gold currently used.
3. Score new corpora against the live ranking, not a llamactl-side
   approximation.

Expected lift: the +0.05–0.10 trustworthy-NDCG@5 spread the
penumbra-asks doc estimates.

## Pilot artifact

`packages/eval/corpora/memory-recall/v0/memory_search_explain.py` —
runnable today against `~/.penumbra/db.sqlite`. The script is
intentionally read-only and the rewriter is a best-effort
approximation; it would be superseded by an authoritative
penumbra-side implementation once ask #4 lands.
