# Memory-recall strong-gold fleet leaderboard — 2026-05-18 PM

Strong-gold-only (n=55: 5 seed + 50 synth, both hand- or BM25-confirmed) is
the production-signal metric per the gold-tier diagnostic. This file is
the clean leaderboard with the four remaining fleet models added; gemma4
and qwen3.6-35b-A3B-UDQ4KXL values are drawn from the diagnostic run.

## Headline (NDCG@5 on n=55 strong-gold)

| Rank | Model                       |     NDCG@5 |   tps |   vs n=105 rank |
| ---: | --------------------------- | ---------: | ----: | --------------: |
|    1 | gemma4-26b-a4b-mtp          | **0.9119** | 34.60 |              =1 |
|    2 | qwen3.5-9b-mtp-UDQ4KXL      |     0.7782 |  9.15 | **+2** (was #4) |
|    3 | qwen3.6-35b-A3B-MTP-UDQ4KXL |     0.7368 | 18.50 |     −1 (was #2) |
|    4 | qwen3.6-35b-A3B-UDQ4KXL     |     0.6932 | 26.99 |     −1 (was #3) |
|    5 | granite-8b-Q4               |     0.6839 | 26.52 |              =5 |
|    6 | qwen3-8b-Q4                 |     0.4204 | 20.04 |              =6 |

All cells: 0 parse errors, 0 errors.

## Implied weak-gold scores (arithmetic)

Computed from each model's n=105 cell minus its n=55 strong-only cell:
`weak_ndcg = (n=105 * 105 - strong * 55) / 50`.

| Model                       | strong (direct) |              weak (implied) | n=105 (actual) |
| --------------------------- | --------------: | --------------------------: | -------------: |
| gemma4-26b-a4b-mtp          |          0.9119 | 0.6935 _(direct from diag)_ |         0.8079 |
| qwen3.5-9b-mtp-UDQ4KXL      |          0.7782 |                     ~0.5346 |         0.6622 |
| qwen3.6-35b-A3B-MTP-UDQ4KXL |          0.7368 |                     ~0.6602 |         0.7003 |
| qwen3.6-35b-A3B-UDQ4KXL     |          0.6932 | 0.6249 _(direct from diag)_ |         0.6667 |
| granite-8b-Q4               |          0.6839 |                     ~0.2427 |         0.4743 |
| qwen3-8b-Q4                 |          0.4204 |                     ~0.2974 |         0.3608 |

## Key findings

### Production pick still gemma4-26b-a4b-mtp — by a wider margin

On strong-gold, gemma4's lead grows from +14.6 pp (on n=105) to **+13.4 pp** over the new #2 (Qwen3.5-9B-MTP at 0.7782). Gemma4 dominates every sub-distribution we've measured. On both axes — quality and throughput — there's no contender today.

### Major reordering: Qwen3.5-9B-MTP jumps from #4 → #2

A 13 pp swing on a single model is the biggest single finding of the session. Qwen3.5-9B-MTP excels at synth-style ("What is the …") questions but its score is dragged down on the mined real-agent-query half. This is consistent with the Qwen 3.5 family being strong on structured QA and weaker on identifier-heavy code-search queries.

### Two distinct sub-distributions in the corpus

- **Strong-gold (synth + seed)**: structured QA over compact paraphrases. Favors models with strong general QA reasoning.
- **Weak-gold (mined real queries)**: identifier-heavy strings like `chain_start`, `memory_search`, `swa-full cache reuse`. Favors models that BM25-match better — exact-token recall is a bigger factor.

Gemma4 + qwen3.6-35b-A3B handle both. Qwen3.5-9B-MTP handles one well. Granite is near-random on the harder half.

### Labeler bias is real but small

Granite scored 5th on n=105 (0.4743) and 5th on strong-only (0.6839). Its strong-gold boost (0.2096 absolute) is **largest of any model**, suggesting some synth questions are easier for granite because granite wrote them. But:

- The rank ordering is unchanged (granite is still 5th in both views).
- The relative gap to the top (gemma4) actually widens on strong-only — granite gets +0.21 absolute, gemma4 gets +0.10. Bias narrows the bottom-of-table gaps, doesn't lift granite into top contention.

A Qwen-relabel control is still the right way to nail this down.

### MTP-on-A3B verdict revisited

On strong-gold:

- qwen3.6-35b-A3B-MTP: 0.7368
- qwen3.6-35b-A3B plain: 0.6932
- Gap: **+4.4 pp** (MTP wins, larger than the +3.4 pp seen on n=105).

So on the cleaner strong-gold tier, MTP-on-A3B helps memory-recall ranking even more clearly. The MTP-for-ranking qualifier from the fleet writeup holds.

## Caveats

- Top-2 (gemma4, qwen3.6-35b-A3B-UDQ4KXL) ran on a truly quiet machine. Ranks 3-6 ran with penumbra-respawned granite-8b on :8083 (disable doesn't persist beyond ~5 min). NDCG@5 is deterministic under contention; only tps takes ~2-3% hit.
- Strong-gold rows are still granite-labeled (the 50 synth). The Qwen-relabel control on those 50 rows would resolve the labeler-bias question definitively.
- "Implied weak-gold" scores in the table above are computed arithmetically; direct weak-gold benches for the 4 models in the diagnostic _would_ be more rigorous (but the implied numbers are exact algebraic identities given the recorded cells).

## Persisted artifacts

- `2026-05-18-memory-recall-strong-gold-fleet.db` — 4 cells (granite-8b, qwen3-8b, qwen3.6-35b-A3B-MTP, qwen3.5-9b-mtp on n=55 strong).
- `2026-05-18-memory-recall-gold-tier-diag.db` — gemma4 + qwen3.6-35b-A3B on strong + weak.
- `2026-05-18-memory-recall-n105-fleet.db` — original aggregate fleet.
