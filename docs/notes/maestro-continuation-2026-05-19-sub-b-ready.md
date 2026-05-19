# Maestro continuation — 2026-05-19 evening: Sub B ready to execute

> Paste this block into the next session.

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

Follow `AGENTS.md`. Use Penumbra MCP for chain state; never query `~/.penumbra/db.sqlite` directly. Repo-facing text is neutral. Delegate substantive code via `chain_start`; hand-implement only when the worker/daemon won't boot.

Execute First moves (section 6) immediately, in parallel where independent. Pause for items with user-visible blast radius (push, dispatch_land, external messages) or genuine ambiguity. The user has authorized the checklist by handing you this note.

## 1. What today's session shipped

Branch advanced `dede87c → f8dcfdd` (~40 commits). MLX Sub A shipped end-to-end (6 phases + adversarial-review hardening + Phase 6.4 manual smoke pass on M4 Pro), then this evening:

- `f5896cc` feat(eval/matrix): rolling DB default + diff CLI
- `1bb5a74` feat(eval/matrix): MLX fleet bench n=3 — Qwen3-8B/14B + Qwen3.6-35B-A3B vs llama.cpp baseline
- `ef5b281` docs(specs): MLX engine support — Sub B design (ModelHost workload-store integration)
- `f8dcfdd` docs(plans): MLX Sub B — executable phased TDD plan

All pushed to origin/main.

## 2. Fleet bench headline (n=3 MLX-4bit on oMLX vs 2026-05-18 llama.cpp baseline)

| Workload | Best quality | Best throughput |
|---|---|---|
| memory-recall (n=105) | **Qwen3-14B-MLX 0.7311** NDCG@5 (11 tps) | **Qwen3.6-35B-A3B-MLX 43.7 tps** (0.6433 NDCG@5) |
| tool-call (n=50) | **Qwen3-14B-MLX 0.92** exact_match (16 tps) | **Qwen3.6-35B-A3B-MLX 47.2 tps** (0.82 exact) |

llama.cpp comparisons:
- Qwen3-8B: oMLX beats llama.cpp Q4_K_M on every metric (memory-recall +20pp, tool-call +21pp, tps +81%).
- Qwen3.6-35B: oMLX matches llama.cpp UD-Q4_K_XL quality at 1.6× tps; llama.cpp MTP still narrowly wins NDCG@5 (+5.7 pp) until oMLX dflash is wired.
- `disable_thinking: true` is **mandatory** for Qwen3 family on oMLX (no `--reasoning off` flag); without it the scorers fail on chain-of-thought.

Data in `packages/eval/results/matrix.db`. Render via `bun packages/eval/src/matrix/diff.ts --db packages/eval/results/matrix.db --workloads memory-recall,tool-call-grammar`.

## 3. Sub B ready to execute

- Spec: `docs/superpowers/specs/2026-05-19-mlx-engine-sub-b-design.md`
- Plan: `docs/superpowers/plans/2026-05-19-mlx-engine-sub-b-plan.md` (868 lines, 9 tasks, 5 phases, 7 waves)

Wave schedule (sequential — Sub B is more interconnected than Sub A):

| Wave | Tasks | Note |
|---|---|---|
| 1 | 1.1 | parseModelHost + store helpers |
| 2 | 1.2 | union loader for kind-agnostic commands |
| 3 | 2.1 | applyOneModelHost converger |
| 4 | 2.2 | node tRPC surface (modelHostStart/Stop/Status) |
| 5 | 3.1 | reconciler mixed-kind |
| 6 | 4.1 ∥ 4.2 | CLI kind-aware enable/disable + list |
| 7 | 5.1 | manual integration smoke |

Each task in the plan is paste-ready (failing-test code, implementation, green-test command, commit message body, agent picks). Use `subagent-driven-development` skill for execution.

**Three spec §11 files have zero plan-task mentions**: `state.ts`, `workloadRuntime.ts`, `openaiProxy.ts`. The plan absorbs their coverage into reconciler tests at Task 3.1. Worth a sanity check before Wave 5 — confirm regression tests for restart/reconcile cover the route-map and ModelHost state sidecar paths.

## 4. Sub B unblocks

- `llamactl disable mlx-host-local` (currently fails — store gap)
- `llamactl list` showing ModelHost rows
- mac-mini ModelHost dispatch (Sub C)
- Reconciler reapply after controller restart
- train→infer loop (Sub D — depends on Sub B + Sub C)

## 5. Open follow-ups not in Sub B scope

1. **dflash MTP on oMLX** — needs separate draft-model checkpoint + `~/.omlx/model_settings.json` config. Per-model setting, not CLI flag. See `reference_omlx_mtp_via_dflash.md`. Will close the +5.7 pp NDCG@5 gap llama.cpp MTP still holds.
2. **memory-efficacy 4way on MLX fleet** — classification workload. Per the MTP-first qualifier (`feedback_model_selection_mtp_first`), MTP/dflash should hurt classification; vanilla 4-bit may match Granite-3B-Q8 baseline.
3. **8-bit MLX variants** — pull `mlx-community/Qwen3-8B-8bit` etc. to test quant-arch interaction (dense Q8>Q4 pattern from attention-thesis eval may not transfer to MLX-8bit).

## 6. First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -10`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `pgrep -fl "omlx serve" || echo "no orphan omlx"` — clean if needed
4. `mcp__penumbra__memory_search` for `project_mlx_sub_a_shipped_2026-05-19` to refresh state
5. Skim `docs/superpowers/plans/2026-05-19-mlx-engine-sub-b-plan.md` "Execution scheduling" section + Wave 1 task body
6. Confirm direction with user: Sub B execution Wave 1, or pivot to dflash measurement, or memory-efficacy 4way on the new MLX fleet
7. If Sub B execution: fire Wave 1 (task 1.1 only) via `chain_start` — single substantial task at the head of the chain; subsequent waves unblock as each lands

## 7. Memories worth re-reading before non-trivial action

- `project_mlx_sub_a_shipped_2026-05-19` — Sub A landed + integration gaps caught
- `project_mlx_fleet_bench_2026-05-19` — fleet bench result + production swap candidates
- `project_omlx_vs_llamacpp_qwen3_8b_2026-05-19` — initial 1-model head-to-head
- `reference_omlx_mtp_via_dflash` — MTP on oMLX is `dflash`, per-model settings
- `reference_penumbra_dispatch_routing` — every chain_start needs `use_worktree:false` + explicit `cd`
- `reference_dispatch_stall_trap` — codex-acp-fast sometimes edits cleanly but stalls before committing; we hit this 3-4 times today; mitigation is HARD STOP language + manual commit
