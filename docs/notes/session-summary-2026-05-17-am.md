# Session summary — 2026-05-17 am

Project: `llamactl`. Session started: `2026-05-17T02:58:27.930Z`.

## What was learned / observed

Recent t2 observations (promoted from this session's t0 events). Conventional-commit prefix on the matching commits below tells you whether each item was built (`feat:`), fixed (`fix:`), or refactored (`refactor:`).


- **Handling of Hugging Face download lock during training** — If the LoRA trainer stalls due to a Hugging Face download lock, the process should be aborted gracefully by recording the blocker in the spike-work directory and leaving the repository in a recoverable state.

- **Escalated permissions for spike-work output directory** — When the spike-work output directory encounters sandbox write restrictions, the training process should be rerun with escalated permissions to ensure artifact creation.

- **Report shape adjustment for 4-way metrics** — The evaluation script now generates a sidecar table alongside the macro-F1 line to accommodate the four-way classification metrics, ensuring proper reporting of individual class performance.

- **Spike-work directory usage for train/eval artifacts** — Existing spike-work directories are utilized for storing intermediate train and evaluation artifacts, avoiding overwriting of prior results and maintaining a recoverable state.

- **Eval script extended for 4-way framing** — The eval script `packages/train/scripts/eval-classifier.sh` was modified to support a `FRAMING` environment variable with values `binary` or `4way`, enabling four-way classification evaluation while preserving existing binary evaluation log


## Commits this session

```
884a58c docs(notes): maestro-continuation 2026-05-17 pm — full session narrative + handoff
f20c669 docs(notes): phase 2 — task-refiner rubric eval (8B beats 3B by 4.5 pp)
b3e865a docs(notes): phase 0 verify — daemon-path reproduces 0.9235 macro-F1
8a29d82 docs(notes): fleet eval extension plan — phased workload eval roadmap
4eb8892 fix(core/proxy): stabilize tests for body cap + route-cache
e95b3d8 fix(core/proxy): cap JSON bodies and cache model→endpoint map
```

## Dispatch events


- 2026-05-17T03:13:07.248Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:13:07.644Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:13:08.173Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:13:31.946Z `claim` handoff `7df525ea-9f74-402b-bd74-bac7a59d6cc6`

- 2026-05-17T03:13:31.947Z `claim` handoff `73a8ed3f-b541-4e37-a0fd-cdeaaa5d0828`

- 2026-05-17T03:13:31.947Z `claim` handoff `1fe886ea-e73b-4125-aafb-ab4675ad338a`

- 2026-05-17T03:13:31.947Z `dispatch.start` handoff `7df525ea-9f74-402b-bd74-bac7a59d6cc6`

- 2026-05-17T03:13:31.947Z `dispatch.start` handoff `73a8ed3f-b541-4e37-a0fd-cdeaaa5d0828`

- 2026-05-17T03:13:31.947Z `dispatch.start` handoff `1fe886ea-e73b-4125-aafb-ab4675ad338a`

- 2026-05-17T03:13:32.028Z `acp.server.start` handoff `7df525ea-9f74-402b-bd74-bac7a59d6cc6`

- 2026-05-17T03:13:32.029Z `acp.server.start` handoff `73a8ed3f-b541-4e37-a0fd-cdeaaa5d0828`

- 2026-05-17T03:13:32.032Z `acp.server.start` handoff `1fe886ea-e73b-4125-aafb-ab4675ad338a`

- 2026-05-17T03:13:32.156Z `acp.session.start` handoff `73a8ed3f-b541-4e37-a0fd-cdeaaa5d0828`

- 2026-05-17T03:13:32.161Z `acp.session.start` handoff `1fe886ea-e73b-4125-aafb-ab4675ad338a`

- 2026-05-17T03:13:32.164Z `acp.session.start` handoff `7df525ea-9f74-402b-bd74-bac7a59d6cc6`

- 2026-05-17T03:13:35.786Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:13:35.792Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:13:36.126Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:02.646Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:02.646Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:03.155Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:03.531Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:03.971Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:04.361Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:04.800Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:05.255Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:05.803Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:06.150Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:06.530Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:32.161Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:32.162Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:32.557Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:32.952Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:33.362Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:14:33.777Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:15:04.187Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:15:04.187Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:15:04.596Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:15:05.025Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`

- 2026-05-17T03:15:05.455Z `agent.thought` handoff `cffa6bef-5fa5-4a4a-a1fc-0a7c9fdb4d7a`


## Pending follow-ups



## Diff against main

```
diff --git a/docs/notes/maestro-continuation-2026-05-17-pm.md b/docs/notes/maestro-continuation-2026-05-17-pm.md
new file mode 100644
index 0000000..053d3b8
--- /dev/null
+++ b/docs/notes/maestro-continuation-2026-05-17-pm.md
@@ -0,0 +1,106 @@
+# Maestro continuation prompt — 2026-05-17 pm
+
+> Paste this whole block into the next session as the kickoff message.
+
+---
+
+You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.
+
+If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start` with `trust_mode: "all"`; hand-code only when the worker/daemon won't boot.
+
+**Execute the First moves checklist (section 6) immediately in efficient order.** Batch independent calls in parallel inside a single message; sequence only the ones whose inputs depend on prior output. Pause only on items with user-visible blast radius (push, dispatch_land, restart hosted services, external messages) or genuine ambiguity. Do not re-litigate the checklist.
+
+## 1. What this session shipped
+
+Eight commits across llamactl on five branches, one in-flight δ-mem sidecar still running, and one explicit constraint from the user: **do not touch penumbra commits** — those are handled in a parallel penumbra session.
+
+### llamactl repo
+
+Five branches, all on top of `main`, none merged into each other:
+
+```
+main             b3e865a  Phase 0 verify — daemon-path reproduces 0.9235 macro-F1
+                 8a29d82  fleet eval extension plan
+                 4eb8892  fix(core/proxy): stabilize tests for body cap + route-cache  [pushed to origin]
+                 e95b3d8  fix(core/proxy): cap JSON bodies and cache model→endpoint map [pushed to origin]
+                 c2ee627  feat(core/proxy): route /v1/* by model field across workloads [pushed to origin]
+plan/fleet-eval-extension       8a29d82  324-line phased plan (Phase 0 done)
+corpus/home-mgmt-classify       e72bb5c  Phase 1 + 1b + 1c (5 commits) — δ-mem null
+vendor/delta-mem-sidecar        2313472  vendored sidecar, openclaw stripped, preamble dropped
+corpus/refiner-eval             f20c669  Phase 2 refiner rubric — 8B beats 3B by +4.5 pp
+```
+
+**Local main is 2 commits ahead of origin/main** (b3e865a + 8a29d82 — Phase 0 + the plan). The other four branches (`plan/`, `corpus/home-mgmt-classify`, `vendor/`, `corpus/refiner-eval`) are local-only.
+
+### Cross-workload model evidence (the through-line)
+
+| Workload | Production model | Best candidate measured | Lift |
+|---|---|---|---|
+| memory-efficacy 4-way | granite-3b-Q8 | (3B is optimal) | — |
+| home-mgmt classify | granite-3b-Q8 (default) | granite-4.1-8B Q4_K_M | +27 pp macro-F1 |
+| dispatch-refiner | granite-3b-Q8 (default) | granite-4.1-8B Q4_K_M | +4.5 pp composite |
+| δ-mem qwen3-4b | (parked) | not deployable for these workloads | null |
+
+The story is consistent: **granite-3b is excellent at the workload it was tuned for (memory-efficacy) and worse than granite-8b at everything else we've tested.** Every workload that resolves through `local`/`PENUMBRA_JUDGE_MODEL`-unset inherits this everywhere. Two production-swap-candidates are now sitting in branches awaiting review.
+
+### Penumbra repo
+
+**Explicitly off-limits this session** — a separate penumbra session handles those commits. The following landed in the EARLIER part of today's work and are NOT part of the new branches above:
+
+- `penumbra@41f4cd2` fix(daemon/routes): skip builtin penumbra in federation-tools route — **deployed via daemon restart; verified silent for 36+ minutes across 6 cron boundaries**
+- `penumbra@b2ba0d1` docs(specs): home-mgmt tick-event writer spec (205 lines)
+
+Local penumbra `main` is at `41f4cd2`, **45 commits ahead of origin/main, not pushed**.
+
+### Config + ops changes (not in git)
+
+- Sidecar `/tmp/delta-mem-smoke/delta-mem-mlx-sidecar-w-openclaw/` cloned, vendored copy lives at `packages/delta-mem-sidecar/`. Sidecar process still running on `:8765` (PID 2208 at session end) with Qwen3-4B-Instruct-2507 + delta-mem MLX adapter loaded. ~1.5 GB RAM. Kill if not needed: `lsof -ti :8765 | xargs kill -9`.
+- HF cache populated at `/Users/acordeiro/DevStorage/cache/huggingface/hub/` with `mlx-community/Qwen3-4B-Instruct-2507-4bit` and `ofthetrees/delta-mem-qwen3-4b-instruct-mlx-adapter`.
+- Gemma-4-26B llama-server at `:8181` is **HTTP 500 "Compute error"** on every chat-completions request. Has been broken since early in this session; was the planned synthesis labeler and cross-judge slot. Worth ops-triaging on session start.
+
+## 2. Live state
+
+- Penumbra daemon + worker: both up; federation fix landed at `41f4cd2`. Zero `federation-tools-listTools-failed` warns since `03:39:35Z` restart, across all three long-lived agents (home-mgmt, task-refiner-{primary,escalation}). 36+ minute verification window.
+- Mac-mini gateway `https://192.168.68.76:7843`: serving `granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf`. PID 50759 (restarted with current llamactl source post-`git reset --hard origin/main`).
+- Local llama-servers: `:8085` granite-3b-Q8 (production memory-efficacy judge + refiner), `:8083` granite-8b-Q4 (long-lived), `:8181` **gemma-4-26b — UNHEALTHY 500**.
+- δ-mem sidecar `:8765`: running Qwen3-4B + adapter, anti-recall preamble disabled. Update count for the hot-pass session-key: `updates: 16` confirmed. Mechanism wires correctly but does not lift on our workloads.
+
+## 3. Open follow-ups
+
+Priority-ordered. Each is independent unless noted.
+
+1. **Phase 3 — dispatch-refine eval.** Per `docs/notes/fleet-eval-extension-plan-2026-05-17.md` Phase 3, this is the same rubric-eval shape as Phase 2 but with raw chain_start prompts pulled from `dispatch_events` (not `handoffs.message`). Should reuse `/tmp/phase2-refiner/eval.py` almost wholesale. ~30 min wall.
+2. **Phase 2 cross-judge.** The 4.5 pp gap between 3B and 8B on the refiner was scored by granite-8b — i.e., the candidate judges itself. Re-score the 50 outputs with a non-granite judge (claude-acp-sonnet via dispatch is the cheapest non-bias path) and settle whether the gap is real or inflated. ~20 dispatches.
+3. **Phase 2 downstream-impact eval.** Take 5 refined-by-3B vs refined-by-8B pairs from `/tmp/phase2-refiner/results.json`, send each through `codex-acp-fast`, count clarification round-trips and net commits. Ground truth the rubric can't see. ~10 dispatches.
+4. **Gemma-4-26B `:8181` ops triage.** It's been returning HTTP 500 "Compute error" since session start. Was the planned synthesis labeler + cross-judge for Phase 1. Diagnose root cause + restart workload; recover the slot. ~10 min if it's a memory or MTP-draft issue.
+5. **Merge branches into main (review order matters):**
+   - `plan/fleet-eval-extension` (just docs, trivially ff)
+   - `corpus/home-mgmt-classify` (corpus + 4 notes, trivially ff)
+   - `corpus/refiner-eval` (one note, trivially ff)
+   - `vendor/delta-mem-sidecar` (2757-line vendor — review for license + adapter compat before merging; not load-bearing)
+6. **Push local main + branches to origin** when ready. Currently +2 (Phase 0 + plan) ahead of origin/main, not blocking but accumulates.
+7. **Production refiner swap.** Both home-mgmt classify (Phase 1) and dispatch-refiner (Phase 2) show 8B beating 3B. The cleanest swap is `PENUMBRA_REFINER_MODEL=local-granite-8b` in the daemon plist + daemon restart. **Held for the penumbra session that owns daemon config.**
+
+## 4. Memories worth reading first
+
+- `project_attention_thesis_eval_2026-05-16` — why granite-3b Q8 won memory-efficacy. The +3.04 pp lift was specific to that corpus; doesn't generalize.
+- `project_fewshot_beats_lora_2026-05-16` — the M-track architectural finding that 3-exemplar prompting beats LoRA. Same in-context-attention principle as δ-mem's claim, but in prompt-space which is cheaper and ships.
+- `reference_jq_false_coalesce_trap` — `if has("k") then .k else empty end` pattern, used in Phase 2 eval's parse_judge.
+- `reference_codex_acp_fast_sandbox_limits` — codex-acp-fast can't bind listening sockets or reach HF. Affects what to dispatch vs hand-run.
+- `feedback_attention_assembly_not_ffn` — frame for why δ-mem null doesn't disprove the architectural bet; just that this specific 8×8 implementation doesn't transfer to structured-classification workloads.
+
+## 5. Decisions not to re-litigate
+
+- δ-mem is parked. Three independent evals all null (Phase 1 cold, 1b hot-vs-cold, 1c favorable trajectory). Mechanism wires correctly per the state-update audit; the technique just doesn't help structured classification at temp=0 with self-contained prompts. The sidecar vendor at `packages/delta-mem-sidecar/` is parked clean for a future revisit if/when a δ-mem-favorable workload (long-form generation, multi-turn dialogue without prompt replay) becomes a priority.
+- Granite-8B is the consistent winner on workloads NOT specifically tuned for granite-3b. Don't re-eval that direction; instead measure which OTHER models (Gemma 4 E4B once `:8181` is healthy, Qwen3-8B if re-enabled) might beat granite-8b on per-workload corpora.
+- Single-judge bias is a known limitation; the cross-judge pass (follow-up #2) is the right next move, not a different judge architecture.
+- Penumbra commits are off-limits this session and the next maestro session should continue to assume so unless told otherwise.
+
+## 6. First moves
+
+1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main..main && git branch -a | head -10`
+2. `mcp__penumbra__handoff_list_pending` → confirm clean
+3. `tail -200 ~/.penumbra/launchd.daemon.out.log | grep -E "federation-tools-listTools-failed" | tail -5` — confirm the federation fix is still silent across more cron boundaries; if any warns appeared, the production `:8085` may have rotated chat templates again.
+4. `curl -s -m 5 http://127.0.0.1:8181/health` and `curl -s -m 10 http://127.0.0.1:8181/v1/chat/completions -d '{"model":"gemma4-26b-a4b-mtp","messages":[{"role":"user","content":"READY"}],"max_tokens":4,"temperature":0}'` — is gemma-4-26b still 500? If yes, this is the blocking item for Phase 1 v0.2 + Phase 2 cross-judge.
+5. `curl -s http://127.0.0.1:8765/health` — sidecar still running? Kill it if not needed: `lsof -ti :8765 | xargs kill -9`.
+6. Pick direction with the user from the open follow-ups (§3). The recommended next thread is **Phase 3 (dispatch-refine eval)** — same shape as Phase 2, reuses the eval driver, adds the third data point to the granite-3b-vs-8b pattern. If user wants a different direction, the cross-judge pass (#2 in §3) settles whether Phase 2's gap is inflated.
diff --git a/docs/notes/phase2-refiner-results-2026-05-17.md b/docs/notes/phase2-refiner-results-2026-05-17.md
new file mode 100644
index 0000000..3666db8
--- /dev/null
+++ b/docs/notes/phase2-refiner-results-2026-05-17.md
@@ -0,0 +1,61 @@
+# Phase 2 — task-refiner generation rubric eval — 2026-05-17
+
+**Status:** complete (n=25, rubric-judged, single-judge bias caveat)
+**Source plan:** `docs/notes/fleet-eval-extension-plan-2026-05-17.md` Phase 2
+**Refiner system prompt:** `penumbra/packages/core/src/services/dispatch-prompt-refiner.ts:4-18` (`REFINER_SYSTEM_PROMPT`, copied verbatim into the eval driver)
+
+## Result
+
+| Candidate | scored | intent | contract | noise | **composite** |
+|---|---|---|---|---|---|
+| Granite-4.1-3B Q8_0 `:8085` (current production refiner) | 25/25 | 2.52 | 2.44 | **2.24** | 0.800 |
+| Granite-4.1-8B Q4_K_M `:8083` | 25/25 | **2.80** | **2.60** | 2.12 | **0.836** |
+
+Composite delta: 8B − 3B = **+0.036 (+4.5 pp)**. Both 25/25 zero parse failures. Wall: 8B 428s vs 3B 356s on the same 25 inputs (~20% slower).
+
+## Pattern that the composite hides
+
+The 3B beats the 8B on `noise_removal` (+0.12) but loses on `intent_preservation` (−0.28) and `contract_clarity` (−0.16). At first read this looks like a clean trade-off — terser vs. more faithful. Sampling the two widest-gap inputs shows the trade-off is asymmetric: **the 3B is over-pruning useful task context, not just preamble.**
+
+Example 1 — workflow-runtime Task 8.4 (gap +0.444):
+- 3B (composite 0.556): "Implement the workflow registry integration into buildServices as described. Extend the Services interface..."  *(no file paths, no constraint section, no test reference)*
+- 8B (composite 1.000): "Implement wiring the workflow registry into the `buildServices` function in `packages/core/src/services.ts` and add a corresponding smoke test in `packages/core/test/services.test.ts`. **Constraints:** Modify only ..."  *(concrete paths, explicit constraints)*
+
+Example 2 — v2-cross-repo-smoke Task 1.1 (gap +0.333):
+- 3B (composite 0.444): "...completion is considered done when the task is marked as complete in the system, with no specific acceptance criteria."  *(vague — invents "no specific criteria" rather than preserving the real plan reference)*
+- 8B (composite 0.778): "...using the specification, tests, and acceptance criteria detailed in `/Volumes/WorkSSD/repos/personal/penumbra/docs/superpowers/plans/v2-cross-repo-smoke.md`..."  *(preserves the plan file reference)*
+
+The 3B's higher noise_removal score is the rubric judge counting "stripped preamble" without penalizing "stripped useful context". The judge scores the **shape** of the output, not whether a downstream ACP agent could execute it without re-asking for the file paths.
+
+## Production implication
+
+**Refiner workload is the second one where the production granite-3b is the worse fit, not the better one** (the first was home-mgmt classify, Phase 1).
+
+| Workload | Production model | Better candidate | Composite delta |
+|---|---|---|---|
+| memory-efficacy (4-way) | granite-3b-Q8 | (3B optimal) | — |
+| home-mgmt classify | granite-3b-Q8 (default) | granite-8b-Q4 | +0.27 (macro-F1) |
+| dispatch refiner | granite-3b-Q8 (default) | granite-8b-Q4 | +0.04 (composite) |
+
+The refiner gap is smaller (4.5 pp vs 27 pp for home-mgmt), but the failure mode — silently dropping file references and constraint sections — affects every downstream coding-agent dispatch the production runs. The composite metric understates the operational cost.
+
+**Recommendation:** swap the refiner from `local` (granite-3b-Q8) to a granite-8b alias before the next production push, OR add a refiner-specific override in the daemon plist (`PENUMBRA_REFINER_MODEL`). Defer the swap if the +20% wall-clock cost matters more than the dispatch-quality lift; quantify by running a couple of recent dispatches through both refined outputs and observing whether the 3B-refined version produced needless clarification round-trips.
+
+## Caveats
+
+- **Single-judge bias.** The judge is `granite-8b` :8083 — the same model as one of the candidates. Granite-8B judges its own outputs. The reported gap is plausibly inflated by ~self-flattering. The bias-corrected delta is unknown without a cross-judge pass (e.g. claude-acp-sonnet rescoring the same outputs).
+- **n=25.** Composite means come with non-trivial standard error. A second 25-row sweep would let us compute confidence intervals.
+- **Rubric judge can't see downstream impact.** The judge scores shape; the real metric is "did the dispatched agent execute correctly after the refiner". That requires a downstream eval (run both refined outputs through codex-acp-fast and compare commit-rate / fix-rate).
+- **Gemma-4-26B `:8181` is still returning HTTP 500 "Compute error"** — couldn't add as a third candidate or as cross-judge. Worth diagnosing as ops triage; the workload was a maestro-bench winner and is sitting unusable.
+
+## Artifacts
+
+- `/tmp/phase2-refiner/inputs.jsonl` — 25 raw chain_start prompts sampled from `~/.penumbra/db.sqlite` `handoffs` table (`status='resolved'`, `parent_handoff_id IS NULL`, `to_agent ∈ {codex-acp-*, claude-acp-sonnet, gemini-acp-pro}`, length 400-4500 chars), randomized
+- `/tmp/phase2-refiner/eval.py` — eval driver (scratch — could promote to `packages/train/scripts/eval-generation-rubric.sh` rewrite)
+- `/tmp/phase2-refiner/results.json` — full per-input refined outputs + judge scores + composite
+
+## Follow-ups (priority-ordered)
+
+1. **Cross-judge pass** with a non-Granite model (claude-acp-sonnet via dispatch, or a temp Gemma 4 E4B once `:8181` is fixed). One pass = 50 judgments. Settles whether the 4.5 pp gap is real or inflated by single-judge bias.
+2. **Downstream-impact eval.** Take 5 refined-by-3B vs refined-by-8B pairs, send through codex-acp-fast, count clarification round-trips and net commits. This is the ground truth the rubric can't see.
+3. **Gemma-4-26B `:8181` ops triage.** It's been returning 500 since session start; root cause + restart could unlock both a third candidate and the cross-judge slot.

```
