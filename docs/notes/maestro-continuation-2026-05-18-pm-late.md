# Maestro continuation — 2026-05-18 pm-late

> Paste this whole block into the next session as the kickoff message.

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

Follow `AGENTS.md` (present in this repo). Use Penumbra MCP for chain state; do not query `~/.penumbra/db.sqlite` directly except for forensics. Keep commits and repo-facing text neutral — no AI/tool authorship attribution. Delegate coding via `chain_start`; hand-code only when the worker/daemon won't boot.

Execute the **First moves** checklist (section 6) immediately in efficient order — batch independent calls in parallel — without asking for permission per item. Pause only for items with user-visible blast radius (push, dispatch_land, restart hosted services, external messages) or genuine ambiguity. The user has already authorized the checklist.

## 1. What this session shipped — 7 commits in narrative order

All commits hand-coded by me in-session; no chain dispatches were used for any of this session's code work (the dispatch summaries in the workflow output are all from background long-lived agents, not from this session's plan execution).

1. **`a4dd404`** — *fix(eval/matrix): tool-call multi-call tier — replace sequential/conditional rows with parallel.* The PM-session diagnostic (`82377ce`) found all 4 fleet models scoring 0/11 on `tier-multi.jsonl`. I inspected all 11 rows; the failure was corpus design, not model deficit. Three flavors: 7 sequential-dependent (gold has call-2 args before call-1 returns), 2 conditional, 2 exclusive-OR. Replaced with 11 fan-out scenarios (same-tool parallel for 9, cross-tool parallel for 2). Regenerated `test.jsonl` as the concatenation. Unit tests stayed green; the actual fleet re-bench is open (see §4 follow-ups).

2. **`8631067`** — *feat(workloads): granite-3b-Q8 long-lived agent — supersedes 8b-Q4 on :8083.* Cross-workload evidence had piled up: memory-recall NDCG@5 ties 8B strong-gold + beats it +15 pp on n=105 weak-gold; memory-efficacy +3.04 pp at 2.6× fewer params; tool-call single-tier 0.8485 vs ~0.74. User confirmed "full swap on :8083" via AskUserQuestion (the live worker change was worth confirming before touching). Sequence: `llamactl disable 8b` → port :8083 frees → `llamactl apply` 3b yaml → `/v1/chat/completions` returns "SWAP-OK". Rollback documented in the commit body.

3. **`2061961`** — *docs(AGENTS): MTP-first rule — add workload qualifier (generation/ranking yes, classification no).* The MTP-first preference was overgeneralized. Direct evidence: memory-recall +3.4 pp (helps), task-refiner-rubric 0.8711 top score (helps), memory-efficacy 4way −7.9 pp (hurts). Split the rule into "prefer MTP for generative/ranking, skip for classification". Per-workload-class decisions avoid the future model-pick regression.

4. **`56b28b8`** — *feat(eval/matrix): CLI DX — --corpus-override + loud-fail on empty inputs.* The two matrix-CLI gotchas from the PM-late session (per `reference_matrix_cli_gotchas_2026-05-18`). Added `--corpus-override workload=path[,...]` parsed into Map and plumbed via `runMatrix({corpusOverrides})`. Added `models.length === 0 || workloads.length === 0` throw both in CLI and `runMatrix`. 6 new tests; full 80 pass / 0 fail.

5. **`618942b`** — *docs(specs): MLX engine support — Sub A design (engine abstraction + oMLX adapter).* The user signaled "next big feature: MLX support". I researched the landscape (WebSearch + WebFetch on jundot/omlx and waybarrios/vllm-mlx), picked **oMLX** as the "llama.cpp equivalent" (continuous batching, SSD-tiered KV cache for stable agent prefixes, multi-model serving in one process, OpenAI/Anthropic/embeddings/rerank in one binary, source-buildable). User direction surfaced via AskUserQuestion: architectural shape "Shape 2 — ModelHost kind", yaml schema "best long term" (I picked `kind: ModelHost`), pull path "best long term" (I picked extending `llamactl pull` with MLX-format detection), first slice "full scope" (I decomposed into Subs A/B/C/D), then "Sub A only this session". Wrote 445-line spec across 11 sections with measurement-gate "not applicable" recorded.

6. **`89a21d7`** — *docs(plans): MLX engine support — Sub A executable phased TDD plan.* Invoked `writing-plans` skill. 14 tasks across 6 phases, each with per-task `yaml meta` block (preferred_agent / fallback_agent / file_scope / depends_on / parallel_with / task_size / risk_class). Agent picks driven by `agent_recommend` data: substantial→codex-acp-fast (96 samples, 49% success, 155s avg) / codex-acp-deep fallback; small→codex-acp-fast (109 samples, 51%) / oc-deepseek-v4-pro fallback; docs_mechanical→claude-acp-sonnet / codex-acp-fast. Initial validator failure: "no yaml meta blocks found" — root cause was a `---` separator line between Tech Stack and Phase 1 that opened a YAML header block and swallowed the rest. Removed it; validator went to exit 0. Per-task content includes failing-test code, implementation, green-test command, and a quoted-heredoc commit message body.

7. **`bcac159`** — *docs(plans): MLX Sub A — flatten cross-phase deps into 6-wave schedule.* User asked for the optimal cross-phase parallelism. I walked the full `depends_on` graph and surfaced a 6-wave schedule: Wave 1 fires 5 parallel (1.1, 1.2, 3.1, 5.2, 6.3), gated waves 2-5 follow, Wave 6 is the manual smoke on M4 Pro. Critical path is `1.1 → 2.1 → 4.1 → 4.2 → 5.1` (5 substantial dispatches end-to-end). Cross-phase wins noted: 3.1/3.2 chain runs in Wave 1-2 shadow; 5.2/6.3 land in Wave 1 instead of waiting for Phase 5/6; 4.3 finishes one wave earlier because it doesn't need 2.3.

## 2. What was *not* done (and why)

- **Re-bench of the fixed tool-call multi-call tier (commit a4dd404)** — would tie up the M4 Pro for 10-15 min spinning up 4 llama-server instances. I committed the corpus fix and moved on instead. The validation belongs in the next session's open work.
- **Sub A implementation work** — explicitly deferred; this session was design + plan, not implementation. The user said "Full design + plan, ship in next session".

## 3. Live state

- **Daemon + worker**: both up at session start, both up at session end. `launchctl list | grep penumbra` shows `dev.penumbra.daemon` PID 11634 and `dev.penumbra.worker` PID 11648 (set at session start; no restart this session).
- **Live workloads** (verified via `llamactl_workload_list`):
  - `granite41-3b-long-lived-local` — **Running** PID 61382 on `127.0.0.1:8083` (the swap). Model: `granite-4.1-3b-Q8_0.gguf`, ctx 65536.
  - `granite41-3b-judge-mac-mini` — **Running** PID 48503 on `127.0.0.1:8086` (unchanged from pre-session).
  - `granite41-8b-long-lived-local` — **Stopped** (disabled by `llamactl disable` step of the swap; manifest is preserved for rollback).
  - All other manifests (gemma4 variants, qwen3-8b-local, qwen3-8b-mac-mini, qwen35-4b-mac-mini, granite41-3b-judge-local) are Disabled/Stopped — unchanged from session start.
- **Filesystem state outside git**:
  - `~/DevStorage/workloads/granite41-3b-long-lived-local.yaml` was created by `llamactl apply`. The canonical source lives in the repo at `templates/workloads/granite41-3b-long-lived-local.yaml` (committed in `8631067`).
- **No `daemon_reload_config`** was invoked this session.
- **No `dispatch_land`, push, or external messages** were sent.
- **Quotas**: no chain_start dispatches this session; cost quota unchanged.

## 4. Open follow-ups (concrete, with first moves)

1. **Validate the new tool-call multi-call tier (commit a4dd404).** Re-run the 4-model fleet bench against `packages/eval/corpora/tool-call-grammar/v0/test.jsonl` using `packages/eval/specs/tool-call-tier-fleet.json`. Expected: real model differentiation on the n=11 multi-call tier (yesterday's diagnostic had all 4 models at 0/11 on the broken corpus). Command sketch: `bun packages/eval/src/matrix/cli.ts --models packages/eval/specs/tool-call-tier-fleet.json --workloads tool-call-grammar --out-db packages/eval/results/2026-05-19-tool-call-multi-fix.db --report md --report-out packages/eval/results/2026-05-19-tool-call-multi-fix`. Then add to memory if granite-3b-Q8 holds its single-tier lead on the now-meaningful multi-tier.

2. **MLX Sub A — execute Wave 1.** Subagent-driven mode confirmed. 5 parallel `chain_start` dispatches for tasks 1.1, 1.2, 3.1, 5.2, 6.3. Each prompt should:
   - Reference both paths: `docs/superpowers/specs/2026-05-18-mlx-engine-sub-a-design.md` and `docs/superpowers/plans/2026-05-18-mlx-engine-sub-a-plan.md`.
   - Set `use_worktree: false`.
   - Prepend `cd /Volumes/WorkSSD/repos/personal/llamactl` to the prompt body.
   - Pull the exact failing-test code, implementation, green-test command, and commit-message body from the task's section in the plan.
   - Use the `preferred_agent` from the task's yaml meta block (codex-acp-fast for 1.1/1.2/3.1/6.3; claude-acp-sonnet for 5.2).
3. **Sub B/C/D brainstorms** — only after Sub A lands. Sub D (train-loop adapter integration) is the highest-value end-state; Sub B (multi-model hosting + REST hot-load) unlocks oMLX's full value; Sub C (mac-mini deployment) is parallelizable with B.

4. **Push.** Branch is now 7 ahead of `origin/main` after the today's work. Not pushed; user did not request it.

## 5. Memories worth reading first

- `reference_matrix_cli_gotchas_2026-05-18` — the two CLI gotchas this session fixed in commit 56b28b8. Now somewhat misleading (the gotchas are resolved); consider updating to "fixed via 56b28b8".
- `project_granite_q8_vs_q4_weak_gold_2026-05-18` — primary evidence for the 8b→3b swap (8631067).
- `project_mtp_35b_atomicchat_2026-05-18` — evidence for the MTP-first qualifier (2061961).
- `project_tool_call_gold_tier_2026-05-18` — the diagnostic that surfaced the multi-call corpus bug (now fixed in a4dd404).
- `reference_penumbra_dispatch_routing` — every Wave-1 dispatch needs `use_worktree: false` + explicit `cd`.
- `feedback_decision_contract_pattern` — relevant if Sub A hits a measurement question that needs a contract before more experiments.

## 6. First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -10`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `mcp__penumbra__memory_search` for `reference_penumbra_dispatch_routing` (snapshot the worktree/cd rule before the first chain_start)
4. `mcp__penumbra__agent_recommend` for `implement_small` and `implement_substantial` (sanity-check picks against today's data: codex-acp-fast had 109/96 samples respectively with ~50% success)
5. Skim `docs/superpowers/plans/2026-05-18-mlx-engine-sub-a-plan.md` "Execution scheduling" section + Wave 1 task bodies (lines covering tasks 1.1, 1.2, 3.1, 5.2, 6.3)
6. Fire Wave 1 — 5 parallel `chain_start` dispatches (in a **single** message with multiple tool-use blocks so they run concurrently). Each prompt is self-contained: paste the failing-test code, implementation, green-test command, and commit message body from the plan.
7. After Wave 1 returns, `worktree_inspect` each agent branch + verify the worktree state matches the plan task before FF-merging.
8. Run `bun test packages/core packages/remote packages/eval` from the integration branch before triggering Wave 2.
