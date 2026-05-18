# Phase 2 — task-refiner generation rubric eval — 2026-05-17

**Status:** complete (n=25, rubric-judged, single-judge bias caveat)
**Source plan:** `docs/notes/fleet-eval-extension-plan-2026-05-17.md` Phase 2
**Refiner system prompt:** `penumbra/packages/core/src/services/dispatch-prompt-refiner.ts:4-18` (`REFINER_SYSTEM_PROMPT`, copied verbatim into the eval driver)

## Result

| Candidate | scored | intent | contract | noise | **composite** |
|---|---|---|---|---|---|
| Granite-4.1-3B Q8_0 `:8085` (current production refiner) | 25/25 | 2.52 | 2.44 | **2.24** | 0.800 |
| Granite-4.1-8B Q4_K_M `:8083` | 25/25 | **2.80** | **2.60** | 2.12 | **0.836** |

Composite delta: 8B − 3B = **+0.036 (+4.5 pp)**. Both 25/25 zero parse failures. Wall: 8B 428s vs 3B 356s on the same 25 inputs (~20% slower).

## Pattern that the composite hides

The 3B beats the 8B on `noise_removal` (+0.12) but loses on `intent_preservation` (−0.28) and `contract_clarity` (−0.16). At first read this looks like a clean trade-off — terser vs. more faithful. Sampling the two widest-gap inputs shows the trade-off is asymmetric: **the 3B is over-pruning useful task context, not just preamble.**

Example 1 — workflow-runtime Task 8.4 (gap +0.444):
- 3B (composite 0.556): "Implement the workflow registry integration into buildServices as described. Extend the Services interface..."  *(no file paths, no constraint section, no test reference)*
- 8B (composite 1.000): "Implement wiring the workflow registry into the `buildServices` function in `packages/core/src/services.ts` and add a corresponding smoke test in `packages/core/test/services.test.ts`. **Constraints:** Modify only ..."  *(concrete paths, explicit constraints)*

Example 2 — v2-cross-repo-smoke Task 1.1 (gap +0.333):
- 3B (composite 0.444): "...completion is considered done when the task is marked as complete in the system, with no specific acceptance criteria."  *(vague — invents "no specific criteria" rather than preserving the real plan reference)*
- 8B (composite 0.778): "...using the specification, tests, and acceptance criteria detailed in `/Volumes/WorkSSD/repos/personal/penumbra/docs/superpowers/plans/v2-cross-repo-smoke.md`..."  *(preserves the plan file reference)*

The 3B's higher noise_removal score is the rubric judge counting "stripped preamble" without penalizing "stripped useful context". The judge scores the **shape** of the output, not whether a downstream ACP agent could execute it without re-asking for the file paths.

## Production implication

**Refiner workload is the second one where the production granite-3b is the worse fit, not the better one** (the first was home-mgmt classify, Phase 1).

| Workload | Production model | Better candidate | Composite delta |
|---|---|---|---|
| memory-efficacy (4-way) | granite-3b-Q8 | (3B optimal) | — |
| home-mgmt classify | granite-3b-Q8 (default) | granite-8b-Q4 | +0.27 (macro-F1) |
| dispatch refiner | granite-3b-Q8 (default) | granite-8b-Q4 | +0.04 (composite) |

The refiner gap is smaller (4.5 pp vs 27 pp for home-mgmt), but the failure mode — silently dropping file references and constraint sections — affects every downstream coding-agent dispatch the production runs. The composite metric understates the operational cost.

**Recommendation:** swap the refiner from `local` (granite-3b-Q8) to a granite-8b alias before the next production push, OR add a refiner-specific override in the daemon plist (`PENUMBRA_REFINER_MODEL`). Defer the swap if the +20% wall-clock cost matters more than the dispatch-quality lift; quantify by running a couple of recent dispatches through both refined outputs and observing whether the 3B-refined version produced needless clarification round-trips.

## Caveats

- **Single-judge bias.** The judge is `granite-8b` :8083 — the same model as one of the candidates. Granite-8B judges its own outputs. The reported gap is plausibly inflated by ~self-flattering. The bias-corrected delta is unknown without a cross-judge pass (e.g. claude-acp-sonnet rescoring the same outputs).
- **n=25.** Composite means come with non-trivial standard error. A second 25-row sweep would let us compute confidence intervals.
- **Rubric judge can't see downstream impact.** The judge scores shape; the real metric is "did the dispatched agent execute correctly after the refiner". That requires a downstream eval (run both refined outputs through codex-acp-fast and compare commit-rate / fix-rate).
- **Gemma-4-26B `:8181` is still returning HTTP 500 "Compute error"** — couldn't add as a third candidate or as cross-judge. Worth diagnosing as ops triage; the workload was a maestro-bench winner and is sitting unusable.

## Artifacts

- `/tmp/phase2-refiner/inputs.jsonl` — 25 raw chain_start prompts sampled from `~/.penumbra/db.sqlite` `handoffs` table (`status='resolved'`, `parent_handoff_id IS NULL`, `to_agent ∈ {codex-acp-*, claude-acp-sonnet, gemini-acp-pro}`, length 400-4500 chars), randomized
- `/tmp/phase2-refiner/eval.py` — eval driver (scratch — could promote to `packages/train/scripts/eval-generation-rubric.sh` rewrite)
- `/tmp/phase2-refiner/results.json` — full per-input refined outputs + judge scores + composite

## Follow-ups (priority-ordered)

1. **Cross-judge pass** with a non-Granite model (claude-acp-sonnet via dispatch, or a temp Gemma 4 E4B once `:8181` is fixed). One pass = 50 judgments. Settles whether the 4.5 pp gap is real or inflated by single-judge bias.
2. **Downstream-impact eval.** Take 5 refined-by-3B vs refined-by-8B pairs, send through codex-acp-fast, count clarification round-trips and net commits. This is the ground truth the rubric can't see.
3. **Gemma-4-26B `:8181` ops triage.** It's been returning 500 since session start; root cause + restart could unlock both a third candidate and the cross-judge slot.
