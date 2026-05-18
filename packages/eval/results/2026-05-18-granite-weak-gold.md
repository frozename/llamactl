# Granite Q-vs-params on weak-gold mined queries — 2026-05-18

Direct weak-only bench to confirm the surprise from `2026-05-18-fleet-fill.md`:
granite-3b-Q8 beat granite-8b-Q4 by +15 pp on the n=105 fleet, with the
strong-gold tier ~tied. The delta must live in the weak-gold half.

## Setup

- Corpus: `packages/eval/corpora/memory-recall/v0/mined.jsonl` swapped
  in place as `test.jsonl` (n=50, BM25-top-1 weak gold mined from
  penumbra `t0_events memory_search` calls).
- Models: granite-3b-Q8 (`Q8_0`, `:8193`), granite-8b-Q4
  (`Q4_K_M`, `:8095`). Spec: `packages/eval/specs/granite-weak-gold.json`.
- Granite-4.1-8B judge live on `:8083` (the t2-judge, separate
  instance from the bench `granite-8b-Q4` on `:8095`).
- Result db: `2026-05-18-granite-weak-gold.db`.

## Result (weak-gold mined only, n=50)

| Model | NDCG@5 | tps | p50 (ms) | p95 (ms) |
|---|---:|---:|---:|---:|
| granite-3b-Q8 | **0.5605** | 30.52 | 1716 | 2049 |
| granite-8b-Q4 | 0.2437 | 28.40 | 8480 | 9436 |

**Gap: granite-3b-Q8 wins by +31.7 pp on weak-gold.**

## Arithmetic cross-check vs published cells

For both models, `weak (n=50) × 50 + strong (n=55) × 55 = full (n=105) × 105`:

- granite-3b-Q8: 50×0.5605 + 55×0.6837 = 65.629 → /105 = **0.6250**
  (matches the fleet-fill n=105 cell `0.6250` to 4 dp).
- granite-8b-Q4: 50×0.2437 + 55×0.6839 = 49.7995 → /105 = **0.4743**
  (matches the strong-gold-fleet n=105 row `0.4743` exactly).

Both decomposes cleanly — no measurement artifact.

## Read

### Q8 small beats Q4 large by a wide margin on identifier-heavy retrieval

The mined corpus is dominated by short, identifier-heavy queries
extracted from real penumbra `t0_events` (e.g., `chain_start`,
`memory_search swa-full cache reuse`, etc.). These are *token-identity*
matching tasks — recall hinges on the model preserving distinct
embeddings for code symbols across vocab rotation / quantization.

The granite-3b-Q8's 31.7 pp lead matches the prior attention-thesis
finding from `project_attention_thesis_eval_2026-05-16.md` (Q8 small
> Q4 large on a memory-efficacy classifier) on a third workload type:
ranking retrieval. The pattern is robust.

### Latency surprise: granite-8b is 5× slower per query at near-equal tps

8b p50 = 8480 ms vs 3b p50 = 1716 ms; tps nearly tied at ~30. This
implies granite-8b emits roughly 5× more tokens per query than
granite-3b on this workload. Most plausibly: the larger model
elaborates more before committing to a ranking — and that
self-elaboration trips over the short identifier-heavy prompts.

### Production picks

- For an identifier-heavy retrieval workload on a memory-constrained
  node (≤4 GiB), **granite-3b-Q8 is the right granite**. Don't reach
  for granite-8b at Q4 unless RAM is plentiful AND the workload is
  prose-heavy.
- For *generative* workloads (refiner-rubric, code-summarize),
  granite-8b probably retains the edge — it has 2.6× more params to
  spend on producing fluent text. Future work: re-bench granite-8b
  at Q8 to disentangle "is Q4 the problem, or is 8B + ranking the
  problem?"

## Caveats

- Both granite models ran with the `:8083` t2-judge live (penumbra
  re-enables it within 5 min). Per the standing contention reading,
  only tps takes a ~2-3% hit; NDCG@5 is deterministic.
- granite-3b-Q8 ran with `-np 1` (this bench) vs `-np 4` in the
  production judge yaml. Single-slot vs 4-slot doesn't change quality
  on a sequential bench, but tps could shift on concurrent traffic.
- Weak-gold is BM25-top-1, so an *honest semantic ranker* with a
  better-than-BM25 read could underperform here. Both granites are
  scoring against the same gold; the relative result is sound.
- No direct granite-8b-Q8 cell was measured today; the "Q4 is the
  problem" hypothesis vs "8B is the problem" hypothesis is open.

## Open follow-up

- **granite-8b-Q8 weak-gold bench.** If 8b-Q8 ≈ 3b-Q8 on weak-gold,
  Q4 is the killer. If 8b-Q8 still loses, the 8B base model is
  miscalibrated for short identifier prompts. Worth ~10 min next
  session to settle.
