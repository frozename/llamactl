# memory-recall / v0 (matrix eval)

`test.jsonl` (n=105) is the matrix-eval evaluation set for the
`memory-recall` workload. Scoring shape and NDCG@5 metric defined in
`packages/eval/src/matrix/workloads/memory-recall.ts` and the spec at
`docs/specs/2026-05-18-memory-recall-workload.md`.

## Composition

- `seed.jsonl` (n=5) — hand-built smoke rows. Strong gold (1-5 ids).
- `mined.jsonl` (n=50) — mined from real penumbra t0 `memory_search`
  tool-call queries. Weak gold (BM25-top-1 self-label, single id).
- `synth.jsonl` (n=50) — labeler-generated questions over random t2
  bodies. Strong gold (seed memory_id, single id) — accepted only when
  the BM25 search for the labeler's question returns the seed memory
  in its top-10.

`test.jsonl` is just `cat seed.jsonl mined.jsonl synth.jsonl`; rebuild
by re-running `mine_t0.py` + `synth_t2.py` and concatenating.

## Mining (`mine_t0.py`)

```bash
python3 mine_t0.py --db ~/.penumbra/db.sqlite --limit 50 > mined.jsonl
```

- Pulls distinct `memory_search` queries from `t0_events`.
- BM25-OR over FTS5 `t2_fts` top-10.
- Top-1 BM25 hit is the weak-supervision gold.
- Candidate order is randomized so BM25 rank is not directly leaked.

The script is deterministic for a fixed `--seed` (default 2026_05_18).

## Honest caveats

- **Weak gold.** Gold is the BM25 top-1 hit for the query. A model that
  ranks differently is not necessarily wrong; it may have a more
  semantically faithful read than the lexical BM25 oracle. Spot-check
  a sample by hand before treating a per-model NDCG@5 as a production
  claim.
- **Single-gold rows.** Most rows have `|gold_ids| = 1`, so NDCG@5 here
  collapses to a binary "did the right id land in position 1?" with a
  log-discounted partial credit for positions 2-5. With richer gold
  (the seed half has up to 5), NDCG@5 spreads more.
- **Synth labeler is granite-4.1-8b-Q4_K_M.** It's a single labeler;
  the corpus inherits its phrasing biases. Spot-check before treating
  per-model differences smaller than ±0.05 NDCG@5 as meaningful.
  - Concrete bias observed in v0 synth: question openers concentrate
    on "What ..." (top-10 openers are all interrogatives like "What
    is the", "What changes were", "What must be", etc.). A model that
    keys on interrogative→answer pairing may outperform one that keys
    on entity/term overlap, independent of true ranking quality.
  - **Qwen-relabel control ran 2026-05-18** — `synth-qwen.jsonl` is the
    Qwen3.5-9B-MTP relabel of the same workload. Re-bench on the Qwen
    corpus preserved rankings (gemma4 0.9027 vs 0.7419 on strong-gold;
    granite-corpus delta was -0.5 to -3.6 pp). No labeler self-bias
    detected. Full write-up: `packages/eval/results/2026-05-18-relabel-qwen-control.md`.

## Bench plan

When you're ready to bench on a quiet machine:

```bash
cd packages/eval
bun src/matrix/cli.ts run \
  --workloads memory-recall \
  --models <comma-separated-spec-names> \
  --report-md /tmp/memory-recall-report.md
```

Candidate models (per `project_a3b_beats_mtp_dense_2026-05-18.md`):

- gemma4-26b-a4b-mtp (last seen 0.974 on the n=5 seed)
- qwen3.6-35b-A3B-UDQ4KXL (last seen 0.971 on the n=5 seed)
- granite-4.1-8b-Q4_K_M (also the synth labeler — bench separately to spot self-bias)
- granite-4.1-3b-Q8_0
- qwen3-8b-Q4_K_M
- qwen3.5-9b-mtp (new candidate — pulled 2026-05-18, no workload yet)
- gemma4-e4b-vanilla
- gemma4-26b-a4b-mtp-q4km

Allocate ~3 hours wall-time for the full sweep. The judge port and the
matrix `/v1` boot-probe (lifecycle.ts) should already be configured.
