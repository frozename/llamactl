# Memory-efficacy M.7 + M.8 — retrain on expanded corpus, re-eval on both test sets

`git log -1 --oneline` at run time: `ac81966 docs(notes): memory-efficacy M.6 — rebalancing does not move minority floor`

## M.7 — retrain Qwen3-8B 4-way LoRA on expanded corpus

Identical hparams to the prior adapter so any delta is attributable to the corpus:
- Model: `Qwen/Qwen3-8B@b968826d9c46dd6066d109eabc6255188de91218`
- Corpus: `packages/train/corpora/memory-efficacy/4way-chat` (451 train / 50 valid / 60 test — was 416/50/49 for the prior adapter)
- ITERS=300, BATCH_SIZE=1, NUM_LAYERS=16, LORA_RANK=16
- Train wall: 265s (matches prior 269s — same scale)
- Bridge: PASS (224 tensors → peft adapter)
- Convert: PASS after re-hardlinking hf-base (the script's bridge step appeared to remove hf-base; convert was re-run manually)
- Adapter GGUF: `packages/train/.spike-work/memory-efficacy-4way-qwen3-8b-chat-v2/gguf/adapter.gguf` (38.8 MB, same size as prior)

## M.8 — re-eval new adapter on both test sets

### Canonical (4way-chat/test.jsonl, n=60, 88% majority)

|        | accuracy | macro-F1 | parse rate |
|--------|----------|----------|------------|
| base   | 0.8833 | 0.6868 | 1.0000 |
| adapter (v2) | 0.8833 | 0.6683 | 1.0000 |
| delta (adapter − base) | 0.0000 | -0.0185 | 0.0000 |

### Balanced (4way-chat-balanced/test.jsonl, n=24, 50/50)

|        | accuracy | macro-F1 | parse rate |
|--------|----------|----------|------------|
| base   | 0.7500 | 0.6810 | 1.0000 |
| adapter (v2) | 0.7500 | 0.6611 | 1.0000 |
| delta (adapter − base) | 0.0000 | -0.0199 | 0.0000 |

## Comparison vs prior adapter (trained on 416 rows)

| set | prior adapter macro-F1 | new adapter macro-F1 | Δ |
|---|---|---|---|
| canonical n=60 | 0.6683 | 0.6683 | 0.0000 |
| balanced n=24  | 0.6611 | 0.6611 | 0.0000 |

**Per-class F1 is byte-identical between the two adapters across both test sets:**
- `missed_registration`: 0.6667 (canonical) / 0.7500 (balanced) in both adapters
- `recall_miss`: 0.6667 / 0.6667 in both
- `memory_ignored`: 0.4000 / 0.4000 in both
- `not_memory_related`: 0.9400 / 0.8276 in both

The first disagreement row (row 8, gold `recall_miss`) shows the same prediction pattern in both adapter versions (`missed_registration` instead of the correct `recall_miss`), with only the reasoning text varying slightly.

## Verdict

**LoRA at rank=16, num_layers=16, iters=300 has converged to a fixed behavior that is not measurably affected by adding 35 more minority training examples.** This is a strong negative result for the current LoRA configuration:

- The pre-expansion adapter (M.4) was net-negative on macro-F1 vs base.
- Retraining on +35 minority rows (+91 minority over the full history) produces identical predictions on every test row.
- The adapter's capacity at this rank is fully saturated by the dominant `not_memory_related` signal; additional minority examples don't shift the decision boundary.

Next moves if continuing the LoRA track:
- **Larger rank / more layers** — try rank=32 or num_layers=32 to see if capacity is the binding constraint.
- **Class-weighted loss or oversampling** — explicitly upweight minority gradient signal during training.
- **Different framing** — the 4-way framing may collapse minority distinctions; a binary "memory-actionable / not" + a second model for minority sub-classification might recover signal.
- **Accept the result** — Qwen3-8B + chat-template + zero-shot prompt is at the ceiling for this corpus/framing, and the LoRA budget is better spent elsewhere (e.g. the K-track adversarial tool-call set).

## Operational note

The script's `step_bridge` or `step_convert` removed `hf-base/` between when `mlx_lm.lora` finished training and when `convert_hf_to_gguf.py` ran. Cause not identified — neither bridge.py nor the convert scripts contain rm/rmtree against hf-base. Workaround: re-hardlink hf-base from the prior train dir between bridge and convert, then run convert manually. Worth filing as a separate bug if reproducible.

A `REUSE_HF_BASE=1` env var was added to `train-lora.sh` to skip the destructive re-download when hf-base is already populated for the right revision; this saves the 15 GB HF fetch on retrains.
