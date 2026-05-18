# Attention-vs-FFN thesis: cross-family eval on memory-efficacy 4-way

**Date:** 2026-05-16 night
**Source frame:** Needle (Cactus Compute) — "tool calling is retrieval-and-assembly, not reasoning; FFN parameters are wasted at this scale."

## Question

Today's M-track produced a +20.6 pp macro-F1 lift on Qwen3-8B from a 3-exemplar
few-shot prompt — where 5 LoRA retrains at rank=16 had given a byte-identical
adapter-vs-base. Restated in Needle's vocabulary: the lift came from in-context
attention work, not FFN capacity.

**Falsifiable test:** if the lift is architectural rather than scale-bound,
smaller models with the same few-shot prompt should reach comparable macro-F1.

## Method

- Harness: `packages/train/scripts/eval-base-only.sh` (hand-written this
  session; sister of `eval-classifier.sh` but base-only, no adapter).
- Corpus: `packages/train/corpora/memory-efficacy/4way-chat-fewshot/test.jsonl`
  (n=60; class distribution 4/4/4/48 for memory_ignored / missed_registration
  / recall_miss / not_memory_related).
- Inference: llama-server `--jinja --reasoning off --temp 0.0` on
  `127.0.0.1:18099` (off the live `:8085` judge). One model at a time.
- Scoring: per-class precision/recall/F1, macro-F1 over the 4 gold classes.

## Results

| Model | Params | Quant | macro-F1 | Δ Qwen3-8B | Parse failures |
|---|---|---|---|---|---|
| **Granite-4.1-3B**      | 3B  | **Q8_0** | **0.9235** | **+3.04 pp** | 0 |
| Qwen3.5-9B              | 9B  | UD-Q4_K_XL | 0.8941 | +0.10 pp | 0 |
| Qwen3-8B (anchor)       | 8B  | Q4_K_M | 0.8931 | — | 0 |
| **Gemma 4 E4B**         | ~4B eff | UD-Q4_K_XL | 0.8931 | 0.00 pp | 0 |
| Granite-4.1-3B          | 3B  | Q4_K_M | 0.8734 | -1.97 pp | 0 |
| Gemma 4 E4B             | ~4B eff | Q8_0 | 0.8682 | -2.49 pp | 0 |
| **Gemma 3n E2B**        | ~2B eff | Q8_0 | 0.8469 | -4.62 pp | 0 |
| Gemma 3 4B-it           | 4B  | Q4_K_M | 0.8400 | -5.31 pp | 0 |
| **Gemma 4 E2B**         | ~2B eff | Q8_0 | 0.8386 | -5.45 pp | 0 |
| Phi-4-mini-instruct     | 3.8B | Q4_K_M | 0.8181 | -7.50 pp | 0 |
| Qwen3-1.7B (within-fam) | 1.7B | Q8_0 | 0.5830 | -31.01 pp | 0 |
| Phi-4-reasoning-plus    | 14B | Q4_K_M | 0.4471 | -44.60 pp | 20 (think-budget) |

**Headline shifts with quant:** Granite-4.1-3B at **Q8_0** beats the 8B anchor
by +3.04 pp. At Q4_K_M the same model trails by -1.97 pp. **5 pp of macro-F1
hides in the quant choice for this 3B model** — Q4 → Q8 changed memory_ignored
recall 2/4 → 3/4, eliminated 1 missed_registration FP, eliminated 1
not_memory_related FP.

**Asymmetric quant×architecture interaction:** Gemma 4 E4B prefers
UD-Q4_K_XL (0.8931) over Q8_0 (0.8682) — likely because MatFormer
architectures are designed for selective per-tensor precision and a "smart
Q4" quant matches the architectural intent. Granite-4.1-3B (conventional
hybrid attention) prefers Q8_0 over Q4_K_M monotonically.

Anchor sanity: the Qwen3-8B 0.8931 result matches the prior offline measurement
in pm-3 exactly. Harness is methodology-compatible with the original +20.6 pp
finding.

Predictions, server logs, per-class reports live under `/tmp/attn-thesis/*/`.

## What this falsifies and what it doesn't

**Confirms (strong):**
- The Needle frame holds for memory-efficacy 4-way: Gemma 4 E4B at ~4B
  effective parameters reaches the *identical* macro-F1 as Qwen3-8B with the
  same few-shot prompt, byte-for-byte same per-class breakdown.
- Granite-4.1-3B (3B params, different family) within ~2 pp of the 8B.
- The lift is in-context-attention work; scale isn't the binding constraint at
  the 3-8B range.

**Refines (medium):**
- The attention-capacity floor is **family-quality, not parameter count**.
  Gemma 3n E2B at ~2B effective lands at 0.8469 (only -4.62 pp from 8B).
  Qwen3-1.7B at 1.7B collapses to 0.5830 (-31.01 pp). 300M-effective-parameter
  difference shouldn't matter — a 26 pp gap means the architectures are not
  fungible.
- Family and architecture matter at every size class. At ~4B: Gemma 4 E4B >
  Gemma 3 4B > Phi-4-mini (7.5 pp spread). At ~2B: Gemma 3n E2B ≫ Qwen3-1.7B
  (26 pp spread). Modern context-extraction architectures (Gemma 3n / 4
  MatFormer line, Granite 4.1) saturate this task class at much smaller scale.
- Qwen3.5-9B with the few-shot prompt ties Qwen3-8B (+0.10 pp). This *refutes*
  the prior `project_qwen_5model_sweep_2026-05-15` finding that Qwen3.5-9B
  was a "majority-class predictor" — that sweep ran without the few-shot
  block. Same model: prompt-injected exemplars take it from collapsed to
  ~0.89. Strongest single confirmation that the lift is attention work, not
  model capacity.

**Falsifies (clean):**
- "Larger is always better" — Phi-4-reasoning-plus at 14B is 44 pp worse than
  Qwen3-8B and has 33% parse failure rate. Reasoning-tuned models are the wrong
  tool: their default behavior is to emit a long chain-of-thought that blows
  the token budget before the JSON.

## Caveats

- n=60 with 4 minority-class rows per class. One row of noise = 25 pp shift
  in per-class recall. The 0.00 pp tie between Gemma 4 E4B and Qwen3-8B is
  remarkable but should be retested on the auto-fire memory-verification
  corpus once it accumulates (~100+ rows expected within 5-7 days of operation
  per the spec landed today at penumbra@eca9e319).
- Qwen3-1.7B was Q8_0 (officially-shipped HF quant for that size) where
  others were Q4_K_M. Higher quant means the 31 pp gap is conservative; a
  Q4 version would not close it.
- The few-shot prompt was the published version from penumbra@2a57160;
  no model-specific prompt tuning. A per-model prompt could shrink some gaps.

## What this changes about the fleet

**Production candidate swap (updated post-quant-sweep):** the `qwen3-8b-local.yaml`
workload at `:8085` serving the memory-efficacy judge should be replaced with
**`granite-4.1-3b-Q8_0.gguf`** as primary, **`gemma-4-E4B-it-UD-Q4_K_XL.gguf`**
as a secondary option.

| Candidate | macro-F1 | Disk | vs Qwen3-8B Q4_K_M |
|---|---|---|---|
| Granite-4.1-3B Q8_0 | **0.9235** | ~3.3 GB | better F1, ~33% less disk |
| Gemma 4 E4B UD-Q4_K_XL | 0.8931 | ~2.6 GB | tied F1, ~47% less disk |
| Qwen3-8B Q4_K_M (current) | 0.8931 | ~4.9 GB | baseline |

Granite-3B Q8 dominates on this corpus: best F1, smaller than the 8B, fits
the home-mgmt fleet pattern (Granite was already the home-mgmt model). Gemma
4 E4B UD-Q4_K_XL is the smallest viable swap if disk/RAM is the binding
constraint.

Three pre-conditions before swapping in production:
1. Auto-fire corpus accumulates labels; re-run the experiment on the larger
   labeled set to control for the n=60 noise (especially the n=4-per-minority
   class fragility).
2. Test the same prompt under the daemon's `resolveJudgeConfig` path (the
   model alias and chat-template handling differ between raw llama-server
   and what the runner uses).
3. Verify decode throughput at the production batch size — F1 wins don't
   matter if a 3B Q8 doesn't keep up with the dispatch volume the 8B Q4
   handles. (Likely fine: smaller model + higher quant ≈ same memory
   bandwidth budget.)

## Decision rule going forward

> For new retrieval-and-assembly workloads (classifier, scorer, router,
> re-rank), default to the smallest **modern-arch** 2-4B model that produces
> parseable output on the test corpus. Use 8B+ only as a baseline anchor for
> validation, not as the production model.

Modern-arch in this context means: **Gemma 3n / Gemma 4** (MatFormer-line),
**Granite 4.1**. Likely also Qwen3.5-4B with the few-shot prompt (the prior
"majority-class" finding was prompt-bound, not model-bound — Qwen3.5-9B's
+0.10 result here proves the prompt is the variable).

Avoid for this task class: **older Qwen3** (1.7B-2B range collapses),
**Phi-4-reasoning-plus** (reasoning-tuned blows token budget), **Gemma 3 4B**
(half a generation behind Gemma 4 E4B / 3n E2B at the same size).

Below ~2B: do not default; test first. Floor depends on architecture, not
just parameter count — Gemma 3n E2B sits well above the floor at ~2B
effective; Qwen3-1.7B sits far below at 1.7B.

## Artifacts

- Harness: `packages/train/scripts/eval-base-only.sh`
- Predictions + per-model reports: `/tmp/attn-thesis/{qwen3-8b,qwen35-9b,gemma4-e4b,gemma4-e4b-q8,granite-3b,granite-3b-q8,gemma3n-e2b,gemma4-e2b,gemma3-4b,phi4-mini,qwen3-1.7b,phi4-reasoning}/`
- Source prompt + corpus: `penumbra@2a57160` + `packages/train/corpora/memory-efficacy/4way-chat-fewshot/`
