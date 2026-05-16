# K-track decision contract

Date: 2026-05-16
Status: active until 2026-05-30 (reassess if no validation slice has shipped by then)

## What the K-track is trying to fix

`llama-server --jinja` on Qwen3-8B-Instruct is the production tool-call emitter for penumbra dispatches (chain_start, long-lived ticks, agent routing). When the model emits a malformed or wrong-argument tool call, the dispatch either soft-fails silently (caller gets a stub) or hard-fails with a parser error visible in agent_performance.

The K-track exists to test whether a small LoRA adapter, trained on a hand-crafted corpus of difficult tool-call prompts, materially improves that production failure rate vs. the bare base model.

## Production metric and threshold

| | Definition | Source |
|---|---|---|
| Primary | **Tool-call success rate** on real penumbra dispatches in the prior 7 days | `agent_performance.outcome == 'success'` filtered to handoffs where the agent attempted at least one tool call |
| Secondary | **Parse-error rate** (HTTP 400 / null tool_name / malformed args) | claude-agent-acp adapter logs + worker stderr |
| Tertiary | **Latency overhead** of running with `--lora` loaded | `time_to_first_token`, `tokens_per_second` deltas vs no-adapter baseline |

**Bar to ship a LoRA adapter into production:**

1. Primary lift ≥ **+5 percentage points** over a 7-day window on the bare base, with overlapping 95% CI.
2. Secondary lift ≥ **+3 pp** on parse-error reduction.
3. Tertiary regression ≤ **10%** on either latency metric.

If all three thresholds aren't met, the adapter does not ship. No partial wins.

## Bar to keep investing in the track

Before *any* new K.N run (training, eval, corpus expansion):

- The hypothesis under test must be stated as a quantitative claim: "we expect P(success | adapter) − P(success | base) ≥ X on dataset Y."
- The dataset must have provenance: explicit lineage from prior splits, no silent re-use of training rows in test, label-source pinned to a SHA or human-adjudicated.
- The experiment must declare a stopping rule: max N hours, max $ inferred from `cost_recent`, or max iters.

If a run cannot satisfy all three before kickoff, it doesn't run.

## Retire criteria — when to kill the track

Retire and freeze if any of the following holds at the next checkpoint:

1. Two consecutive bounded validation slices show < +1 pp on the primary metric vs. base.
2. The non-LoRA alternative (grammar-constrained decoding being the first to test) hits the +5 pp bar on its own — i.e. LoRA is unnecessary.
3. Production tool-call success rate is already > 95% measured (no problem to solve).
4. Cumulative human attention on the track exceeds 12 hours since this contract was written, without a measured production lift.

"Freeze" means: keep all corpus + scripts + adapters in-tree as `.archive/k-track/` with a final summary note. Do not delete; do not continue.

## Validation slice (the gate to the next K-run)

The next K-track action is NOT another K.N run. It is a three-part validation slice:

| Part | Owner | Output |
|---|---|---|
| A | maestro | Pull 7-day production sample from `agent_performance` + worker logs. Compute current primary, secondary, tertiary baseline. |
| B | maestro | Run K.5 adapter under the *real* dispatch path (penumbra worker → claude-agent-acp → llama-server --lora) on the same 7-day sample. Measure all three metrics. |
| C | maestro | Run grammar-constrained decoding (per-tool argument GBNF from JSON schema) on the same 7-day sample. Measure all three metrics. |

Compare A vs B vs C against the bar. If C ≥ bar and B < bar, ship C and retire LoRA. If both ≥ bar, ship whichever is cheaper (latency wins). If neither ≥ bar, retire the track.

The validation slice itself has a budget: **4 hours** of human attention. If A alone exceeds 4 hours of plumbing, retire without running B or C — the production data isn't accessible enough to justify the track.

## Open governance items (per adversarial-review)

These do not block the validation slice but must be resolved before any *new* corpus row is added or any *new* adapter is trained:

- **Label provenance**: pin the Qwen3-8B-Instruct teacher to a HF revision SHA and a code-versioned prompt template. Dual-label disagreement check against a different model (Granite 4.1 or Gemma 4 26B-A4B). Sampled human adjudication on 10% of rows.
- ~~**Corpus naming**~~: ✓ renamed `adversarial-v0` → `uncommon-v0` (2026-05-16, same day as contract; see `FROZEN.md`).
- **Data governance**: when production traces feed back into the corpus, run PII + secret redaction (matching the patterns in `packages/secret-redact/` if it exists; otherwise a new shared module).
- **Lineage**: stop claiming "three independent datasets" until the K.4 and K.5 row overlap is quantified and called out explicitly.

## What is NOT in scope for this contract

- Aesthetic or maintainability cleanup of existing K-track code (deferred).
- Grammar-constrained decoding *as a separate production initiative* (this contract scopes it as a non-LoRA control only).
- Multi-turn / rollout-shaped training data (deferred until validation slice completes).
- Larger-rank / more-layers LoRA configurations (deferred until validation slice completes).

## How this contract gets revised

Edit this file with a `## Revision YYYY-MM-DD` block at the bottom. Do not delete prior text — the audit trail matters more than the cleanliness of the document.
