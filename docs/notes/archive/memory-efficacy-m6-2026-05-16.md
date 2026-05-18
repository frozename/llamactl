# Memory-efficacy M.6 — re-eval on balanced sibling corpus

`git log -1 --oneline`: `61ca405 corpus(memory-efficacy): balanced 4-way sibling corpus (M.5) - 3x minority ratio`

Tests whether the 88% `not_memory_related` dominance in the canonical test set was masking real minority signal. Same Qwen3-8B base + chat-template + pre-expansion LoRA adapter as M.4, different test set.

Test set: `4way-chat-balanced/test.jsonl` — n=24 (12 majority + 12 minority, 50/50 split).

## Results

|        | accuracy | macro-F1 | parse rate |
|--------|----------|----------|------------|
| base   | 0.7500 | 0.6810 | 1.0000 |
| adapter| 0.7500 | 0.6611 | 1.0000 |
| delta (adapter − base) | 0.0000 | -0.0199 | 0.0000 |

### Per-class (precision / recall / F1)

| class | base P/R/F1 | adapter P/R/F1 |
|-------|-------------|----------------|
| missed_registration | 1.0000 / 0.7500 / **0.8571** | 0.7500 / 0.7500 / **0.7500** |
| recall_miss         | 1.0000 / 0.5000 / **0.6667** | 1.0000 / 0.5000 / **0.6667** |
| memory_ignored      | 1.0000 / 0.2500 / **0.4000** | 1.0000 / 0.2500 / **0.4000** |
| not_memory_related  | 0.6667 / 1.0000 / **0.8000** | 0.7059 / 1.0000 / **0.8276** |

## Comparison vs M.4 (canonical n=60, 88% majority)

| metric | M.4 base | M.6 base | Δ | M.4 adapter | M.6 adapter | Δ |
|---|---|---|---|---|---|---|
| accuracy | 0.8833 | 0.7500 | -0.1333 | 0.8833 | 0.7500 | -0.1333 |
| macro-F1 | 0.6868 | 0.6810 | -0.0058 | 0.6683 | 0.6611 | -0.0072 |

Accuracy drops mechanically because the rebalanced test set no longer lets the model coast on the dominant class. Macro-F1 is nearly identical — the metric is already correcting for class imbalance, and the *underlying* per-class signal hasn't changed.

**Per-class deltas (base, M.4 → M.6):**
- `missed_registration`: 0.7500 → 0.8571 F1 (slight lift, but P went from 0.75 → 1.0 mostly because there are fewer majority rows to confuse it with)
- `recall_miss`: 0.6667 → 0.6667 (identical — both runs recover 2 of 4 minority rows)
- `memory_ignored`: 0.4000 → 0.4000 (identical — both runs recover 1 of 4 minority rows)
- `not_memory_related`: 0.9307 → 0.8000 F1 (R still 1.0; P drops because the majority-class predictions are now diluted by minority rows)

## Verdict

The 88% `not_memory_related` dominance was NOT the binding constraint on minority recall. After rebalancing to 50/50:
- `recall_miss` still recovers 2 of 4 (R=0.50)
- `memory_ignored` still recovers 1 of 4 (R=0.25)
- The exact same rows are missed in both M.4 and M.6 (same row 8 disagreement sample)

The minority recall floor is **structural** — it lives in the model's understanding of the task framing, not in dataset balance. Further downsampling of `not_memory_related` won't help.

## Implications for next moves

- **M.5 / M.6 close the rebalancing thread.** Stop chasing dataset ratio.
- **M.7 (retrain adapter on expanded corpus)** is now the obvious next move — the current adapter has never seen the +91 minority rows added in M.1+M.2+M.3. Until then, "adapter does not help" is a statement about the pre-expansion adapter only.
- **Qualitative error analysis** on the 2/4 `recall_miss` and 3/4 `memory_ignored` rows the model misses would tell us whether the failure mode is: (a) genuinely ambiguous prompts, (b) classes that need more training examples, or (c) labeling drift between gold and the model's natural prior.
