# Tool-call grammar corpus — FROZEN

**Date frozen:** 2026-05-16
**Decision contract:** `docs/specs/k-track-decision-contract-2026-05-16.md`

## Status

The tool-call grammar LoRA track (K.1 through K.5) is frozen. No new K-runs, no new corpus rows, no new adapters until a production-trace gold-labeling pipeline lands. The corpus + scripts + adapter artifacts stay in-tree as audit trail.

## Why

Five consecutive bounded LoRA runs at `rank=16, num_layers=16, iters=300` on Qwen3-4B-Instruct-2507 and Qwen3-1.7B base showed:

- K.1 (easy gold, n=3 test): base 100% / adapter 100% — saturated
- K.2 (Qwen3-1.7B, n=3 test): base 100% / adapter 100% — saturated
- K.4 (Qwen3-4B + K.1 adapter, n=25 hand-crafted): strict 24% / prefix 36% / name-first 91-96% — adapter ≈ base within 1 row
- K.5 (Qwen3-4B fresh LoRA on 38 hand-crafted rows, n=8 held-out): strict 3/8 / prefix 4/8 / name-first 5/8 — **adapter byte-identical to base on every row**

Decomposition of 19 K.4 base failures revealed:

- 0 structural failures
- 2 wrong-tool selection (semantic, not grammar-fixable)
- 6 multi-tool count mismatch (already fixed by prefix-match scorer)
- 11 right-tool-value-mismatch (predominantly stylistic disagreement with gold labeler)

**Root cause: the corpus is grading the model on the labeler's stylistic choices, not on objectively-correct outputs.** Neither LoRA nor grammar-constrained decoding can lift this. The decision contract's retire criteria #1 (5 consecutive runs at < +1pp) and #4 (cumulative budget exceeded) are triggered.

See:

- `docs/notes/tool-call-k4-2026-05-16.md` — K.4 dataset + scoring results
- `docs/notes/tool-call-k5-2026-05-16.md` — K.5 LoRA training + held-out eval
- `docs/notes/k-track-grammar-control-2026-05-16.md` — failure-mode decomposition + grammar control analysis
- `docs/notes/k-track-strategy-brief-2026-05-16.md` — adversarial-review brief
- `docs/specs/k-track-decision-contract-2026-05-16.md` — production threshold + retire criteria

## What stays useful

Scorer changes (`prefix_success`, `name_first_match` over positives only, `no-tool` accuracy on negatives), `REUSE_HF_BASE` integrity check, the `uncommon-v0` corpus as a negative-result reference, the decision contract pattern. These are independent of the LoRA verdict and ship.

## Re-entry condition

Re-open the K-track only when ALL of the following are in place:

1. **Production-trace gold-labeling pipeline** — replace synthetic gold with real penumbra dispatches where tool-call correctness is retroactively confirmed by user/agent behavior. Removes labeler subjectivity.
2. **Quantified production failure rate** — measured tool-call success rate on the prior 7-day `agent_performance` sample. If > 95%, there is no problem to fix.
3. **Either**: a non-LoRA alternative (grammar-constrained decoding, response*format, prompt eng) has been tested \_on production-trace data* and missed the +5pp bar; **or** the LoRA hypothesis is reformulated for a different failure mode (e.g. multi-turn rollout shape, larger rank).

## Don't delete

The artifacts under `packages/train/corpora/tool-call-grammar/` and the gitignored `packages/train/.spike-work/tool-call-grammar-*` adapter dirs are the proof-of-track-execution. Deleting them would lose the negative result and invite re-running the same experiments without the prior context.

If disk pressure forces archival, move to `packages/train/.spike-work/.archive/k-track-2026-05-16/` and add a manifest. Do not commit the deletion without a follow-up note.
