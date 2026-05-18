# M-track failure analysis — different root cause than K-track

`git log -1 --oneline` at run time: `3634a20 freeze(k-track): rename adversarial-v0 → uncommon-v0 + FROZEN marker`

The M-track decision contract (`docs/specs/m-track-decision-contract-2026-05-16.md`) called for a failure-mode decomposition before deciding whether to freeze the track in parallel with K-track. This is that analysis.

## Summary

**The M-track and K-track have different root causes.** K-track failures are predominantly model-vs-labeler stylistic disagreements (no objectively correct answer). **M-track failures are unambiguous model errors on prompts that explicitly describe memory-efficacy issues.** The gold labels are objectively correct; the model has a systematic bias toward predicting `not_memory_related` even when the prompt names the memory mechanism by hand.

This means:
- K-track freeze is correct (the metric can't go up because the labels are arbitrary).
- **M-track should NOT freeze.** The metric *can* go up — there's a fixable model bias.

## The 6 false-negatives on M.4 base (n=60 canonical)

All 6 minority misclassifications predict `not_memory_related`. Inspecting each:

| Row | Gold | Prompt (what the finding says) | Model's stated reason for `not_memory_related` |
|---|---|---|---|
| 3 | `missed_registration` | "ingestion queue drops the item when the worker times out, so the memory event never gets persisted downstream" | "issue described is related to system timeout and data ingestion, not memory efficacy" |
| 5 | `recall_miss` | "Treating an optional input as an unconditional recall source can suppress relevant match paths and miss applicable memories" | "modeling an optional input … not directly related to memory efficacy" |
| 8 | `recall_miss` | "A ranker cutoff rejects all candidates below a hard threshold, causing the only relevant memory to be dropped" | "ranking mechanism … rather than memory efficacy" |
| 9 | `memory_ignored` | "Changing sync dispatch work to async enqueue can allow recalled context to be bypassed or not injected before execution" | "change in a contract's rebuild process, which is not related to memory efficacy" (model misreads prompt) |
| 10 | `memory_ignored` | "Token-pruning keeps lower-value text while cutting recalled memory, which nullifies retrieved context" | "guardrail logic in managing memory attachments and pruning, which is not directly related to memory efficacy" |
| 11 | `memory_ignored` | "A formatting bug wraps the recalled instruction in quotes, making the model treat it as reported speech instead of guidance" | "technical issue related to formatting … not related to memory efficacy" |

In each case, the **prompt explicitly contains the words** "memory," "recall," "recalled context," "recalled instruction," or "memory event." The model is not failing to extract meaning — it's actively dismissing prompts that name the memory mechanism. This is a systematic prior toward the majority class, not an information-extraction failure.

## Why the K-track grammar analysis doesn't apply

K-track failures look like:

> Gold: `{"query":"parser implementation"}` vs Model: `{"query":"parser"}` — both correct interpretations

M-track failures look like:

> Prompt: "Token-pruning cuts recalled memory, nullifying retrieved context" → Gold: `memory_ignored`, Model: `not_memory_related` ("not directly related to memory efficacy")

There is no defensible reading where row 10 is "not memory related." The model is wrong. The gold is right.

## Recommended next moves (in priority order)

Per the M-track contract, these are validation-slice candidates, NOT direct commitments. They must run under the decision contract's 4-hour budget cap.

### 1. Few-shot prompting (1 hour, lowest cost)

Add 2-3 minority-class exemplars to the system prompt:

```
Example: "A ranker drops below-threshold items" → recall_miss
Example: "Async dispatch bypasses recalled context" → memory_ignored
Example: "Queue backpressure silently drops memory writes" → missed_registration
```

Re-run M.8-style eval on n=60 + balanced n=24 with the few-shot prompt. If minority recall lifts ≥ +10 pp, **ship the prompt change**; LoRA is unnecessary.

### 2. Two-stage classifier (2 hours, medium cost)

Stage 1: binary "is this finding memory-related at all?"
Stage 2: 4-way classifier only on positive stage-1 predictions.

The model's prior toward `not_memory_related` could be neutralized by giving it a smaller decision surface. Two-stage also enables training a focused stage-2 classifier on the 91 minority rows alone, where the gradient signal isn't drowned out by 471 majority rows.

### 3. Class-weighted loss + larger rank (3-4 hours, highest cost)

Retrain at `rank=32, num_layers=32, iters=1000` with minority-class loss weighting (4-8× weight on `recall_miss` and `memory_ignored`). This is the canonical fix for prior-toward-majority bias. Run AFTER #1 and #2 — if either of them moves the needle, this is unnecessary.

## What this changes about the M-track contract

The contract's validation slice part C was specified as "non-LoRA alternative." Based on this analysis:

- **Part C should be few-shot prompting first.** It directly tests whether the model has the *capability* to classify these prompts correctly with a small nudge, separately from the LoRA-can-it-learn question.
- If part C lifts metrics ≥ +10 pp minority recall: ship the prompt; freeze LoRA.
- If part C doesn't move the needle: the model's bias is durable, and #2 / #3 are warranted.

## Don't freeze the M-track

The K-track was frozen because grammar/LoRA can't lift the metric on labels that aren't objective. The M-track is the opposite case — the labels are objective, the model is provably wrong on specific rows, and there are untested alternatives (prompting, two-stage, larger config) that target the actual failure mode.

The M-track stays active under the decision contract until at least the few-shot prompt experiment is run.
