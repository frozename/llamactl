# Memory-recall fleet-fill — gemma4-e4b + granite-3b-Q8

Adds the two missing candidates from the PM-note carry-forward list to
the existing 6-model fleet, fleshing out the leaderboard to 8 models.

## Setup

- Specs: `packages/eval/specs/{gemma4-e4b,granite-3b-Q8}.json` (single
  cells) + `packages/eval/specs/fleet-fill-2026-05-18.json` (merged).
- Corpus: `packages/eval/corpora/memory-recall/v0/test.jsonl` swapped
  in place between bench calls (strong-gold = seed+synth n=55, then
  n=105 = seed+mined+synth).
- Granite-4.1-8B judge stayed live on `:8083` (penumbra re-enables it
  within 5 min of any disable). NDCG@5 is deterministic under
  contention; tps takes ~2-3% hit.
- Results dbs: `2026-05-18-fleet-fill-{strong,n105}.db`.

## Combined leaderboard — strong-gold (n=55)

| Rank | Model | NDCG@5 | tps | source |
|---:|---|---:|---:|---|
| 1 | gemma4-26b-a4b-mtp | **0.9119** | 34.60 | strong-gold-fleet |
| 2 | **gemma4-e4b-vanilla** | **0.8927** | 31.42 | this run |
| 3 | qwen3.5-9b-mtp-UDQ4KXL | 0.7782 | 9.15 | strong-gold-fleet |
| 4 | qwen3.6-35b-A3B-MTP-UDQ4KXL | 0.7368 | 18.50 | strong-gold-fleet |
| 5 | qwen3.6-35b-A3B-UDQ4KXL | 0.6932 | 26.99 | strong-gold-fleet |
| 6 | granite-8b-Q4 | 0.6839 | 26.52 | strong-gold-fleet |
| 7 | **granite-3b-Q8** | **0.6837** | 29.99 | this run |
| 8 | qwen3-8b-Q4 | 0.4204 | 20.04 | strong-gold-fleet |

## Combined leaderboard — n=105 full corpus

| Rank | Model | NDCG@5 | tps | source |
|---:|---|---:|---:|---|
| 1 | gemma4-26b-a4b-mtp | **0.8079** | 32.63 | n105-fleet |
| 2 | **gemma4-e4b-vanilla** | **0.7175** | 30.84 | this run |
| 3 | qwen3.6-35b-A3B-MTP-UDQ4KXL | 0.7003 | 18.02 | n105-fleet |
| 4 | qwen3.6-35b-A3B-UDQ4KXL | 0.6667 | 26.78 | n105-fleet |
| 5 | qwen3.5-9b-mtp-UDQ4KXL | 0.6622 | 8.59 | n105-fleet |
| 6 | **granite-3b-Q8** | **0.6250** | 30.08 | this run |
| 7 | granite-8b-Q4 | 0.4743 | 27.31 | n105-fleet |
| 8 | qwen3-8b-Q4 | 0.3608 | 20.06 | n105-fleet |

All cells: 0 parse errors, 0 errors.

## Key findings

### gemma4-e4b-vanilla is the surprise of the run

E4B vanilla slots at **#2 on both tiers**, only -1.9 pp behind the 26B
MTP on strong-gold (0.8927 vs 0.9119) and -9.0 pp on n=105 (0.7175 vs
0.8079). The same E4B that was a maestro **disaster** with MTP (22/36
@ 28.61 tps on the 2026-05-13 within-machine bench) is a memory-recall
**second-place** at vanilla settings.

The vanilla → MTP reversal isn't a contradiction: per
`project_e4b_reval_2026-05-13.md` the E4B MTP assistant head is broken
on hard-reasoning tasks specifically; the base model is competitive
when used straight. Memory-recall is a ranking workload, not the
hard-reasoning maestro mix that exposed the broken head.

**E4B is the new budget pick** for any node that can't fit the 26B:
~10 GiB expected vs ~22 GiB for the 26B MTP variant, 30+ tps, n=55
quality only -1.9 pp behind production.

### granite-3b-Q8 essentially matches granite-8b-Q4

On strong-gold: 0.6837 (3b-Q8) vs 0.6839 (8b-Q4) — within 0.0002,
beneath any reasonable noise floor. On n=105: 3b-Q8 **beats** 8b-Q4 by
+15.1 pp (0.6250 vs 0.4743).

This matches the attention-thesis finding from
`project_attention_thesis_eval_2026-05-16.md`: smart-Q8 on a small
attention-rich model beats Q4 on a 2.6× larger model. Confirms on a
*ranking* workload (the original was a memory-efficacy classifier).

Note the n=105 vs strong-gold flip: granite-8b-Q4 collapses on the
weak-gold mined-query half (BM25-top-1 identifier strings) where
granite-3b-Q8 holds. Why a smaller model would handle code-identifier
recall better than the larger one is the next interesting question —
quant-level vs param-count balance for token-level recall.

### Throughput sweet spot

gemma4-e4b-vanilla (31.42 tps) and granite-3b-Q8 (29.99 tps) tie for
practical throughput, but e4b wins by +20.9 pp NDCG@5 on strong-gold
and +9.3 pp on n=105. Quality-per-token leader.

For nodes that can fit it, **e4b-vanilla strictly dominates
granite-3b-Q8** on memory-recall.

## Production read

- **Production memory-recall pick: still gemma4-26b-a4b-mtp.** Lead
  grows from +1.9 pp to +9.0 pp from strong-gold to n=105 — handles
  both sub-distributions cleanly.
- **Budget pick: gemma4-e4b-vanilla.** -1.9 pp vs production at 1/3
  the RAM and same-class throughput.
- **Sub-budget pick: granite-3b-Q8.** -22.8 pp vs production but
  4 GiB expected memory and beats granite-8b-Q4 on the harder half.
  Strong candidate for the smallest co-located role.

## Caveats

- Both runs had penumbra-respawned granite-8b on :8083 (judge config).
  Per the n=105-fleet contention check, only tps is affected (~2-3%
  hit); NDCG@5 is deterministic.
- e4b-vanilla and granite-3b-Q8 both used `--no-warmup -np 1` with the
  ctx-size + KV settings from the production workload yamls. Not a
  param sweep — these are point-checks under canonical args.
- The "granite-3b beats granite-8b on weak-gold" finding deserves a
  direct replay on the weak-only n=50 to make sure it isn't a
  noise-floor artifact of the n=55 vs n=50 splits.
