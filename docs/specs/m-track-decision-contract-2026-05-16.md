# M-track decision contract

Date: 2026-05-16
Status: active until 2026-05-30 (reassess if no validation slice has shipped by then)

This contract applies the same discipline to the memory-efficacy LoRA track that was applied to the tool-call track in `k-track-decision-contract-2026-05-16.md`. The two tracks share a failure pattern (adapter byte-identical to base at small rank) and a root cause (LLM-labeled gold with no production-trace grounding).

## What the M-track is trying to fix

The memory-efficacy classifier scores findings produced during penumbra sessions as one of four classes:

- `missed_registration` — a memory that should have been stored, wasn't
- `recall_miss` — a memory that should have been recalled, wasn't
- `memory_ignored` — a recalled memory that didn't influence the executed prompt
- `not_memory_related` — finding has nothing to do with memory efficacy

The score is consumed by `mcp__penumbra__memory_efficacy_recent` and related ops dashboards to gauge whether the memory system is actually helping. A higher minority-class recall (correctly identifying the 12% of findings that DO indicate memory problems) is what drives ops decisions.

The M-track exists to test whether a Qwen3-8B LoRA adapter trained on the 470-row labeled corpus (now 561 with the M.2 expansion) improves minority-class recall over the bare base model.

## Production metric and threshold

|           | Definition                                                                                                           | Source                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Primary   | **Macro-F1 over 4 classes** on a held-out test set drawn from the _next 7 days_ of `memory_verification_events` data | `mcp__penumbra__memory_verification_events` + labeled gold |
| Secondary | **Minority recall** on `recall_miss` and `memory_ignored` specifically                                               | per-class recall from the confusion matrix                 |
| Tertiary  | **Latency overhead** of running the adapter vs bare base on the production node                                      | `time_to_first_token`, `tokens_per_second` deltas          |

**Bar to ship an M-adapter into production:**

1. Primary lift ≥ **+5 macro-F1 points** over a 7-day window vs the bare base on production-trace data, with overlapping 95% CI.
2. Secondary lift ≥ **+10 pp** minority recall on either `recall_miss` or `memory_ignored` (the two classes the production system most needs to catch).
3. Tertiary regression ≤ **10%** on either latency metric.

If all three thresholds aren't met, the adapter does not ship. No partial wins.

## Bar to keep investing in the track

Before _any_ new M.N run (training, eval, corpus expansion):

- The hypothesis must be stated as a quantitative claim: "we expect macro-F1(adapter) − macro-F1(base) ≥ X on dataset Y."
- Dataset provenance: no silent reuse of training rows in test; label source pinned to a SHA + prompt or human-adjudicated.
- Stopping rule: max N hours of human attention, max iters, max $.

## Retire criteria — when to kill the track

Retire and freeze if any of the following holds at the next checkpoint:

1. Two consecutive bounded validation slices show < +1 macro-F1 point on the primary metric vs base.
2. Larger LoRA configurations (rank=32+, num*layers=32+, iters=1000+) also fail to lift macro-F1 by ≥ +1 point on the \_same* held-out set — i.e. the technique itself is exhausted, not just the small config.
3. Production minority-class recall is already > 80% measured on base alone (no problem to solve at this end of the curve).
4. Cumulative human attention on the track since this contract was written exceeds 12 hours without a measured production lift.

## What we already know (M.1 through M.8 retrospective)

| Run | Hparams                                  | Test                          | macro-F1 (base / adapter)            | Verdict                                                      |
| --- | ---------------------------------------- | ----------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| M.4 | rank=16, layers=16, iters=300, train=416 | n=60 canonical (88% majority) | 0.6868 / 0.6683                      | adapter -0.0185 vs base                                      |
| M.6 | (eval-only on rebalanced test)           | n=24 balanced (50/50)         | 0.6810 / 0.6611                      | adapter -0.0199, minority floor unchanged                    |
| M.7 | rank=16, layers=16, iters=300, train=451 | (training only)               | —                                    | retrained on M.2-expanded corpus                             |
| M.8 | (eval of M.7 adapter)                    | n=60 + n=24                   | identical to M.4 / M.6 to 4 decimals | **byte-identical**, +35 train rows didn't shift the boundary |

Three retire-criterion-1 violations (consecutive runs at < +1 F1 point) are on the books. Criterion-2 (larger config) has not been tested. The 12-hour budget under criterion-4 is partly spent; another 4-6 hours of attention is the safe ceiling before the freeze is automatic.

## Open governance items (parallel to K-track contract)

These do not block a validation slice but must be resolved before any new corpus row is added or any new adapter is trained:

- **Label provenance**: the 470-row gold-labels.json was generated by `codex-acp-spark` on 2026-05-15. No SHA / prompt-template pin. Dual-label disagreement check (vs Granite 4.1 or Gemma 4 26B-A4B) was never run. Sampled human adjudication is the audit referenced in `project_memory_efficacy_corpus_llm_labeled.md`.
- **Synthetic-row bias**: the M.2 expansion added 46 synthetic rows labeled by `codex-acp-fast-synth`. The audit in M.3 already flagged 4 borderline rows for relabel. Need a documented criterion for accepting synthetic vs canonical evidence.
- **Class imbalance vs metric choice**: M.6 confirmed that downsampling `not_memory_related` doesn't change the minority floor. The macro-F1 metric IS the right metric, but the minority recall ceiling is now demonstrably structural — not a corpus-shape issue.

## Validation slice (the gate to the next M-run)

The next M-track action is NOT another M.N run. It is a three-part validation slice, parallel to the K-track:

| Part | Owner   | Output                                                                                                                                                                                                                                                            |
| ---- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | maestro | Pull 7-day production sample from `memory_verification_events` joined to `memory_efficacy_recent`. Compute current macro-F1 + per-class recall baseline using bare Qwen3-8B + chat-template.                                                                      |
| B    | maestro | Run M.7 adapter under the same production sample. Measure all three metrics.                                                                                                                                                                                      |
| C    | maestro | One non-LoRA alternative: either (a) prompt-engineered few-shot with 3-5 exemplars per class, (b) a larger model (Gemma 4 26B-A4B or Granite 4.1 8B base) on the same prompt, (c) a two-stage classifier (binary "memory-related?" then 4-way only on positives). |

Compare A vs B vs C against the bar. If C ≥ bar and B < bar, ship C and retire LoRA. If both ≥ bar, ship whichever is cheaper (latency wins). If neither ≥ bar, retire the track.

The validation slice budget: **4 hours** of human attention. If A alone exceeds 4 hours of plumbing, retire without running B or C.

## What is NOT in scope for this contract

- Aesthetic or maintainability cleanup of M-track scripts (deferred).
- Multi-class extensions beyond the 4-way (deferred).
- RLHF-style preference training (out of scope until validation slice ships).
- Training a model bigger than Qwen3-8B (out of scope; would require different toolchain).

## Cross-reference with K-track

The K-track (`k-track-decision-contract-2026-05-16.md`) was frozen the same day this contract was written. Both tracks share:

- Same model class (Qwen3 + chat-template-driven decoding).
- Same toolchain (mlx-lm → bridge → GGUF → llama-server --lora).
- Same hparams (rank=16, layers=16, iters=300).
- Same null result (adapter byte-identical to base on the relevant metric).
- Same hypothesized root cause (LLM-labeled gold with no production-trace grounding).

The K-track's grammar-control analysis (`k-track-grammar-control-2026-05-16.md`) decomposed failures and found 58% are model-vs-labeler stylistic disagreements with no objectively correct answer. **It is plausible — but not yet verified — that the M-track's minority-recall floor has the same root cause**: the gold labels disagree with the model not because the model is wrong but because the labeler's classification of borderline findings is one of several defensible interpretations.

Before running validation slice part C, **the same failure-mode decomposition should be done on the M-track**: of the 19 false-negatives on the n=60 test (4 of each minority class missed at recall=0.25-0.5), how many are objectively-correct labels the model failed on vs borderline rows where the model's prediction is defensible? If the latter dominates, retire immediately without running C.

### Decomposition outcome (2026-05-16)

See `docs/notes/m-track-failure-analysis-2026-05-16.md`. Of the 6 minority false-negatives on M.4 base, **6 of 6 are objectively-correct labels the model failed on** — every misclassified prompt explicitly names the memory mechanism ("recalled context," "memory event," "ranker drops the only relevant memory") and the model still predicts `not_memory_related`. This is the opposite of the K-track pattern; the M-track has a systematic prior-toward-majority that few-shot prompting or two-stage framing can plausibly fix.

Updated validation slice priority:

- Part C is now **few-shot prompting** (3 minority exemplars in the system prompt), not grammar-constrained decoding. Estimated 1 hour. Run before any larger-config LoRA experiment.
- If few-shot lifts minority recall ≥ +10 pp: ship the prompt; retire the LoRA half of the track.
- If few-shot doesn't move the needle: run two-stage classifier (part C2, ~2 hours). If that also fails, then larger-config LoRA (part C3, ~3-4 hours).

### Part C outcome (2026-05-16)

See `docs/notes/m-track-fewshot-result-2026-05-16.md`. Few-shot prompting **passed by a 4× margin**:

- Macro-F1: 0.6868 → 0.8931 (+20.6 pp, vs +5 pp bar)
- `missed_registration` recall: 0.75 → 1.00
- `recall_miss` recall: 0.50 → 0.75
- `memory_ignored` recall: 0.25 → 0.75

The adapter is still byte-identical to base under few-shot. **The LoRA half of the M-track is now frozen by the contract's part-C decision rule.** Part C2 (two-stage) and C3 (larger LoRA) are NOT triggered.

Open ship item: wire the 3-exemplar prompt into penumbra's `memory_efficacy_*` codepath. This is a separate dispatch in the penumbra repo, not llamactl.

## How this contract gets revised

Edit this file with a `## Revision YYYY-MM-DD` block at the bottom. Do not delete prior text — the audit trail matters more than the cleanliness of the document.
