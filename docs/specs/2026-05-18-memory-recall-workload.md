# Memory recall workload (matrix harness)

**Status:** Scaffolding landed 2026-05-18; corpus expansion pending.

## Purpose

Measure how well a model **re-ranks** candidate memories given a query. The existing memory-efficacy workloads ask: *did the system surface a memory at all?* This new workload asks: *given a set of candidates, did the model identify the right ones in the right order?*

## Decisions (locked 2026-05-18)

| Question | Decision |
|---|---|
| Corpus source | **Hybrid: 50 mined + 50 synthetic** (target n=100) |
| Candidate pool | **BM25 top-10 from penumbra's real search()** |
| Model task | **Rank-order the 10 candidates** (output a permutation of IDs) |
| Scoring metric | **NDCG@5** (Normalized Discounted Cumulative Gain) |

## Corpus shape

One JSONL row per scenario:

```json
{
  "query": "How do I handle concurrent writes without race conditions?",
  "context": "Agent is implementing a multi-writer sync protocol.",
  "candidates": [
    { "id": "mem_001", "text": "..." },
    { "id": "mem_002", "text": "..." },
    ...
    { "id": "mem_010", "text": "..." }
  ],
  "gold_ids": ["mem_002", "mem_005"]
}
```

- `candidates` always length 10 (BM25 top-10).
- `gold_ids` 1-3 entries, the candidates that ARE genuinely relevant.
- Order of `candidates` is randomized at generation time (don't leak BM25 rank).

## Workload behavior

Prompt the model with the query + 10 candidates and ask it to output a JSON array of IDs in descending relevance:

```
{"ranking": ["mem_005", "mem_002", "mem_001", "mem_007", "mem_004", "mem_010", "mem_003", "mem_006", "mem_008", "mem_009"]}
```

Scorer parses the JSON, computes NDCG@5 against `gold_ids`:

- Relevance grade: `1.0` if `id ∈ gold_ids` else `0.0`.
- Standard binary-relevance NDCG@5:
  - `DCG@5 = sum_{i=1..5} rel(rank_i) / log2(i+1)`
  - `IDCG@5 = sum_{i=1..min(5,|gold_ids|)} 1 / log2(i+1)`
  - `NDCG@5 = DCG@5 / IDCG@5`
- Aggregate as `mean_ndcg5` across rows via a new aggregator in `runner.ts` (mirror of `mean_exact_match`).

## Corpus build plan (next session)

### Mined half (n=50)

1. Open the penumbra sqlite DB. Use `mcp__penumbra__memory_search` or query `t2_fts` directly.
2. Pull 50 distinct queries from `t0_events` where the session also has a downstream `t2_memory_verification_events` row.
3. For each query, run `search()` to get BM25 top-10 — those are `candidates`.
4. Gold = intersection of (top-10 IDs) with the (memory_ids verified in same session).
5. Discard rows where intersection is empty (the gold wasn't in top-10) — those are misses, not in-distribution for this workload.

### Synthetic half (n=50)

1. Sample 50 memory bodies from t2 spanning multiple obs_types and projects.
2. For each, prompt a strong LLM (granite-8b-Q4 or qwen3.6-35b-A3B) with: *"Write a query that would correctly retrieve this memory, plus three queries that would be a near-miss."*
3. Use BM25 to grab top-10 candidates for each query.
4. Hand-verify gold for a random subset; otherwise default gold = the seed memory + any BM25 hit with cosine sim > 0.7 against the seed.

## Implementation plan

This session ships:
- `packages/eval/src/matrix/workloads/memory-recall.ts` — workload definition + NDCG@5 scorer.
- `packages/eval/src/matrix/runner.ts` — new `mean_ndcg5` aggregator branch.
- `packages/eval/test/matrix-memory-recall.test.ts` — NDCG@5 unit tests.
- `packages/eval/corpora/memory-recall/v0/seed.jsonl` — 5 hand-built rows (smoke).
- `packages/eval/src/matrix/cli.ts` — register workload.

Next session ships:
- `packages/eval/corpora/memory-recall/v0/mined.jsonl` (n=50)
- `packages/eval/corpora/memory-recall/v0/synth.jsonl` (n=50)
- `packages/eval/corpora/memory-recall/v0/test.jsonl` (combined, shuffled)
- Bench results across the 8-9 candidate models.

## Open questions

- Whether NDCG@5 over n=100 is statistically sufficient; if not, may extend to n=300 in v1.
- Whether to surface per-candidate confidence scores instead of just rank order (would enable AUC-style metrics).
- How to attribute partial matches when `|gold_ids| > 1` and the model gets only one right.

## References

- Penumbra search: `penumbra/packages/core/src/readers/search.ts:26-173`
- T2 verification events: `penumbra/packages/core/src/db/schema.ts:106-123`
- Memory-efficacy workloads: `packages/eval/src/matrix/workloads/memory-efficacy-{binary,4way,4way-balanced}.ts`
