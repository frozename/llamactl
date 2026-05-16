# Brief: K-track LoRA strategy — what next?

This is a request for adversarial-review-style critique of the **tool-call grammar LoRA track** (K.1 through K.5) on llamactl. Reviewers should attack two questions:

1. **Corpus quality.** What's wrong with `packages/train/corpora/tool-call-grammar/` (gold-corpus + adversarial-v0) as a training/evaluation substrate?
2. **Methodology / alternative strategy.** Given that LoRA at the current config has produced *byte-identical* adapter-vs-base behavior across three independent datasets, what should we do instead?

## Track history

| Run | Base model | Train rows | Test rows | Result |
|-----|-----------|-----------|-----------|--------|
| K.1 | Qwen3-4B-Instruct-2507 | 24 (gold-corpus easy) | 3 | base 100% / adapter 100% — saturated |
| K.2 | Qwen3-1.7B base       | 24                    | 3 | base 100% / adapter 100% — saturated |
| K.3 | (corpus build only)   | —                     | — | 25 adversarial rows landed |
| K.4 | Qwen3-4B-Instruct-2507 + K.1 adapter | — | 25 adversarial | strict 24%, prefix 36%, name-first 84-88% — adapter ≈ base |
| K.5 | Qwen3-4B-Instruct-2507 fresh LoRA | 38 adversarial | 8 held-out adversarial | strict 3/8, prefix 4/8, name-first 5/8 — **adapter byte-identical to base on every row** |

LoRA config across all runs: `rank=16, num_layers=16, iters=300, batch=1, mlx-lm`.

## Corpus state (post-K.5)

- `gold-corpus.jsonl` — 30 easy rows, labeled by Qwen3-8B-Instruct (see `reference_qwen3_jinja_tool_call_gold_standard`).
- `adversarial-v0/seed.jsonl` (25) + `seed-batch2.jsonl` (25) — 50 hand-crafted "hard" rows across 4 categories:
  - multi-tool (9): 2+ sequential calls
  - name-collision (13): 3+ near-name tools, most-specific should win
  - ambiguous-intent (10): chat-vs-tool boundary
  - schema-edge (18): datetime regex, enums, optionals, arrays, deep nesting
- `adversarial-v0/splits/{train,valid,test}.jsonl` — 38/4/8 stratified per-category.

## Scorer (post-this-session)

- **strict**: predicted matches gold exactly (count, names, canonical args).
- **prefix**: predicted is an ordered prefix of gold — accepts sequential emission.
- **name-first**: first predicted tool name equals first gold name.
- All three are reported per run.

## Constraints

- Hardware: M4 Pro (Apple Silicon, MacBook), 48 GB unified memory.
- Toolchain: `mlx-lm 0.31.3` LoRA → PEFT bridge → `convert_lora_to_gguf.py` → `llama-server --lora`. No PyTorch/CUDA path.
- Production deployment runs `llama-server --jinja` for Qwen3 tool-call emission.
- Smoke step on `train-lora.sh` currently expects classifier-shaped output; it fails for tool-call training but isn't blocking. Not a corpus problem.

## What's *probably* wrong (working hypotheses)

These are framings to attack, not commitments:

1. **The base model already encodes everything the corpus teaches.** Qwen3+jinja saturates the easy set; the hard set fails on argument-shape / instruction-following, not tool selection. If the LoRA's gradient signal is "the model already does this right," it can't add capacity.
2. **Rank=16 is way too small.** 38 examples × 4 categories of failure patterns, with ~30-40M trainable params, may simply not have the capacity to encode 4 distinct corrections.
3. **300 iters on 38 rows is ~8 epochs.** Too few to overfit, but also too few to converge if the signal is weak.
4. **The corpus is too small at every level.** 50 hand-crafted rows can't represent the failure surface of real tool-call usage. The model needs hundreds of examples per category to disambiguate.
5. **The framing is wrong.** Single-turn assistant messages with parallel tool_calls don't match the production multi-turn flow (call → tool_result → next call). The adapter may need rollout-shaped training data.
6. **The "adversarial" rows aren't actually adversarial for the right reason.** They're rows where the *easy* corpus + base agreement was tested; if base already handles them at 90% name-first, the LoRA gradient is dominated by the 10% where the model is *just plain wrong* — which adapter training can't fix without orders of magnitude more data.
7. **We're measuring the wrong thing.** Strict-match scoring on argument JSON canonicalization is too brittle; production tool-call success doesn't require byte-exact arg match. Maybe the metric is masking actual lift.

## Specific asks for reviewers

- **Architect / Data correctness:** What does a good tool-call training corpus look like? Are there published recipes from the Qwen team / OpenAI / Anthropic for this kind of fine-tuning that we should mirror?
- **Devil's advocate / Simplicity:** Should the K-track be retired entirely? If so, what's the right alternative — grammar-constrained decoding, prompt engineering, RAG over tool docs, multi-stage classifier-then-emit?
- **Security / Maintainability:** If we add hundreds more rows, what's the labeling pipeline? Who is the gold labeler? (Currently it's an LLM — Qwen3-8B-Instruct — so we're training a small model to imitate a big one. Is that the right framing?)
- **Performance:** What's the actual production failure rate of `llama-server --jinja` on Qwen3-8B-Instruct for tool calls in penumbra dispatches? Is the K-track even targeting a measurable production problem?
- **Naming clarity:** "Adversarial" is a loaded word. Are these rows actually adversarial, or are they just "uncommon"?
