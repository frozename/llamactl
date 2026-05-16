# M-track few-shot prompting result — ship the prompt, freeze the LoRA

`git log -1 --oneline` at run time: `7e771ff docs(specs)+(notes): M-track decision contract + failure decomposition`

## Setup

Per the M-track decision contract (`docs/specs/m-track-decision-contract-2026-05-16.md`), validation slice **part C** was redefined to few-shot prompting after the failure analysis (`m-track-failure-analysis-2026-05-16.md`) showed the M-track failures were objective model errors (prior toward majority class), not labeler subjectivity like the K-track.

- Built `packages/train/corpora/memory-efficacy/4way-chat-fewshot/test.jsonl` — same 60 rows as canonical test, with 3 hand-picked minority-class exemplars (one per class: `missed_registration`, `recall_miss`, `memory_ignored`) injected into the user prompt before the actual Finding text.
- Re-ran `eval-classifier.sh` with `FRAMING=4way WRAP_CHAT_TEMPLATE=1` using the M.7 adapter + matching base GGUF on the new test set.

## Results

|        | accuracy | macro-F1 | parse rate |
|--------|----------|----------|------------|
| base zero-shot (M.4) | 0.8833 | 0.6868 | 1.0000 |
| base **few-shot** | **0.9500** | **0.8931** | 1.0000 |
| adapter zero-shot (M.8) | 0.8833 | 0.6683 | 1.0000 |
| adapter **few-shot** | 0.9500 | 0.8931 | 1.0000 |

**Macro-F1 lift from prompting alone: +0.2063 (20.6 percentage points).** This is more than 4× the contract's +5pp bar.

### Per-class minority recall (the binding metric)

| Class | Zero-shot recall | Few-shot recall | Δ |
|---|---|---|---|
| `missed_registration` | 3/4 (0.75) | **4/4 (1.00)** | +25 pp |
| `recall_miss` | 2/4 (0.50) | **3/4 (0.75)** | +25 pp |
| `memory_ignored` | 1/4 (0.25) | **3/4 (0.75)** | +50 pp |

### Per-class F1

| Class | Zero-shot | Few-shot | Δ |
|---|---|---|---|
| `missed_registration` | 0.7500 | 0.8889 | +0.139 |
| `recall_miss` | 0.6667 | 0.8571 | +0.190 |
| `memory_ignored` | 0.4000 | 0.8571 | +0.457 |
| `not_memory_related` | 0.9307 | 0.9691 | +0.038 |

## Adapter is still indistinguishable from base

Few-shot base macro-F1 = few-shot adapter macro-F1 to 4 decimals. The LoRA contributes nothing — exactly as in M.4/M.6/M.8 zero-shot. The half of M-track that tries to make the LoRA help is now triple-confirmed dead-end at this configuration.

## Verdict per M-track decision contract

Validation slice part C **passed the +5 macro-F1 bar by a 4× margin**. Per the contract:

> If part C lifts metrics ≥ +10 pp minority recall: ship the prompt; retire the LoRA half of the track.

Minority recall lifted by +25 pp on two classes and +50 pp on the third — all dwarfing the +10 pp threshold.

**Decision:**

1. **Ship the few-shot prompt** as the production memory-efficacy classifier prompt. Replace whatever current production uses with the prompt that includes the 3 exemplars.
2. **Freeze the LoRA half of the M-track** with the same FROZEN.md pattern as K-track. The +0.0185 to +0.0199 macro-F1 LoRA *regressions* across M.4/M.6/M.8 are now joined by 0.0000 delta under few-shot. The technique is exhausted; the data isn't the binding constraint.
3. **Do not run** M.4/C.2 (two-stage classifier) or M.4/C.3 (rank=32 LoRA). The contract's stopping rule for part C says "ship and retire," so neither C.2 nor C.3 is justified.

## What stays useful from the M-track

- The 561-row labeled corpus (`packages/train/corpora/memory-efficacy/gold-labels.json` + `findings.json` + the synthetic minority expansion). Useful as a fixed eval set, not for training.
- The `4way-chat-balanced/` sibling corpus (per-category stratified). Useful for measuring under different ratio assumptions.
- `4way-chat-fewshot/test.jsonl` — the actual production-shipping prompt format.
- The decision contract pattern itself, which is now validated by closing both K-track and M-track LoRA halves with explicit criteria.

## Production wiring (the actual ship)

The memory-efficacy classifier prompt lives in penumbra, not llamactl. The current production caller is `memory_efficacy_recent` / `memory_efficacy_rebuild` in the penumbra daemon, which builds the prompt before sending to a Qwen3-8B endpoint. The change is:

1. Locate the prompt assembly site in penumbra.
2. Inject the 3-exemplar block before the per-finding "Finding:" line.
3. Re-run a `memory_efficacy_rebuild` on the prior 7-day sample to verify the production lift matches this n=60 eval.
4. If production lift confirms: change rides through penumbra's normal commit cycle; no llamactl change is required.

The 3 exemplars to embed (from `4way-chat-fewshot/test.jsonl` builder):

```
Example 1 → missed_registration
Finding: A worker timeout drops the ingestion job before the memory event is persisted to the store.
{"classification":"missed_registration","reason":"Queue drops before persistence — the memory event would have existed, but was never written."}

Example 2 → recall_miss
Finding: The ranker uses a hard threshold and rejects all candidates below score 0.7, including the only relevant memory for the current dispatch.
{"classification":"recall_miss","reason":"A relevant memory existed but the ranker filtered it out before recall."}

Example 3 → memory_ignored
Finding: A formatting bug wraps the recalled instruction in quotes, so the model treats it as reported speech instead of guidance during execution.
{"classification":"memory_ignored","reason":"Memory was recalled and present in the prompt but the model did not act on it."}
```

These exemplars were drawn from the M-track train split (not test) so there's no leakage in the n=60 evaluation; if penumbra uses different exemplars, they should be drawn from a non-production-mining sample to prevent the same leakage pattern.

## Lesson — what this teaches about the LoRA program

Both K-track and M-track converged on the same finding under different root causes:

- **K-track**: gold labels are arbitrary stylistic choices; no technique can lift the metric. Frozen.
- **M-track**: gold labels are objective; the *base model has the capability* to classify correctly when shown what counts; prompting unlocks it; LoRA can't compete with a 3-row prompt change on a calibration-shaped problem.

The general lesson: **before training, test prompting.** A 3-exemplar few-shot prompt produced a +20.6 pp lift in 1 hour. Five LoRA runs across two tracks produced 0.0 pp lift in many hours. The cost ratio is enormous and the result is decisive.

Open items: this prompt change should be wired into penumbra's `memory_efficacy_*` codepath. That's a separate dispatch in the penumbra repo, not llamactl.
