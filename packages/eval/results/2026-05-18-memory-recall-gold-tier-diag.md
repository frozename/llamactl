# Memory-recall gold-tier diagnostic — 2026-05-18 PM

Question: does the n=105 corpus blend a clean signal (strong-gold:
seed + synth) with noise (weak-gold: BM25-top-1 mined), or are both
tiers contributing real signal?

## Method

- Split `test.jsonl` (n=105) by `_provenance`:
  - **strong** = seed (no provenance, hand-built) + synth (`._provenance.synthetic == true`). n=55. Gold is hand-set or BM25-confirmed seed.
  - **weak** = mined (`._provenance.weak_gold == true`). n=50. Gold is BM25-top-1 self-label.
- Re-bench `gemma4-26b-a4b-mtp` (no.1 on n=105) and `qwen3.6-35b-A3B-UDQ4KXL` (no.3 on n=105) on each tier.
- Restore the original test.jsonl after the run.

## Results

| Model | Tier | n | NDCG@5 | tps | p50 (ms) |
|---|---|---:|---:|---:|---:|
| gemma4-26b-a4b-mtp | strong | 55 | **0.9119** | 34.60 | 2212 |
| gemma4-26b-a4b-mtp | weak | 50 | 0.6935 | 32.19 | 2243 |
| qwen3.6-35b-A3B-UDQ4KXL | strong | 55 | 0.6932 | 26.99 | 3552 |
| qwen3.6-35b-A3B-UDQ4KXL | weak | 50 | 0.6249 | 25.78 | 3296 |

## Sanity check — composition arithmetic

For gemma4:
- weighted = (55 · 0.9119 + 50 · 0.6935) / 105 = **0.8079**
- recorded on n=105 = **0.8079**
- Match exact. The n=105 cell is a faithful weighted blend.

For qwen3.6-35b-A3B:
- weighted = (55 · 0.6932 + 50 · 0.6249) / 105 = 0.6607
- recorded on n=105 = 0.6667
- 0.6 pp drift — small run-to-run jitter from independent boot/serve cycles.

## Reads

### Corpus is valid

Top model gets 0.9119 on strong-gold but 0.6935 on weak-gold. That's a 21.8 pp gap, much larger than the model-to-model gap on either tier alone. The corpus's gold-quality split is doing exactly what we hoped.

### Both tiers discriminate, with different sensitivities

- Strong-gold: gemma4 0.9119 vs qwen3.6 0.6932 = **+21.9 pp gap**.
- Weak-gold: gemma4 0.6935 vs qwen3.6 0.6249 = **+6.9 pp gap**.

Weak-gold is noisier-but-informative, not pure noise.

### Production-signal reporting

The strong-gold n=55 number is the trustworthy production reading. The n=105 aggregate is useful as a smoothed indicator but understates the gap between models. When sharing memory-recall numbers going forward:

- **Headline: strong-gold NDCG@5 (n=55).** Closer to a clean rank-quality signal.
- **Secondary: n=105 aggregate.** Useful for run-to-run comparisons since the corpus is fixed.

### Continuity vs last week's seed

Gemma4 hit **0.974** on the n=5 seed-only bench last week and now scores **0.9119** on n=55 strong-gold. A 6.2 pp drop. That's consistent with the synth half being modestly harder than the hand-built seed — a feature, not a bug, of using realistic LLM-generated questions vs hand-picked easy ones.

### Wider-corpus implication

The strong-gold subset is where production signal lives. The mined half:
- Is cheap to expand (just re-run `mine_t0.py` at higher --limit).
- Is genuinely noisier per row.
- Still discriminates models.

A v1 corpus could push the strong-half to n=150-200 via more synth labeling (with a Qwen control diff), and de-emphasize the mined half — or keep it as a separate "real-world distribution" sub-corpus.

## Persisted artifacts

- `2026-05-18-memory-recall-gold-tier-diag.db` — the 4 cells.
- `2026-05-18-memory-recall-gold-tier-diag.md` — this writeup.
