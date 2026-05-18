# Maestro continuation — 2026-05-17 night (full matrix harness session)

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`. Follow `AGENTS.md`. Use Penumbra MCP for chain state; do not query sqlite directly. Keep commits and repo-facing text neutral, no AI/tool attribution. Delegate via `chain_start` with `trust_mode: "all"`; hand-code only when the worker/daemon won't boot.

**Execute the First moves (§7) immediately in efficient order. Batch independent calls in parallel. Pause only on items with user-visible blast radius.** Do not re-litigate the checklist.

## 1. What this session shipped

16 commits across two repos plus three big pivots: a working fleet-eval matrix harness, an MTP-first model-selection policy in `AGENTS.md`, and a multi-model bench reproducing prior baselines byte-perfectly.

### Penumbra (2 commits)

- `ef37e33` `docs(specs): tick_event_writer auto-fire on long-lived tick close` — landed via dispatch (codex-acp-fast spec write, 55 s, clean). The instrumentation step for B-instr (home-mgmt classify corpus). Sits next to `2026-05-16-memory-verify-auto-fire.md` and mirrors that pattern.
- `0fa5769` `Revert "docs(specs): fleet-eval matrix harness (model x workload)"` — cleanup of a misplaced commit (the fleet-eval matrix spec was dispatched to penumbra by mistake because the worktree manager is penumbra-scoped — memory `reference_penumbra_dispatch_routing` warned about this; v1.4+ uses `use_worktree:false` per the same memory).

### llamactl (14 commits on `corpus/refiner-eval`)

Full evolution of the fleet-eval matrix harness at `packages/eval/src/matrix/`:

| Commit | Scope |
|---|---|
| `601ee45` | docs(specs): fleet-eval matrix harness (model x workload) |
| `9415bef` | feat(eval/matrix): **v0 skeleton** — types, sqlite store, stub runner, cli, tests |
| `a897aca` | fix(eval/matrix): v0 review fixes — runner_version, runId uuid, validator, todos |
| `26e4d08` | feat(eval/matrix): **v1.1 memory-efficacy-binary runner** — real inference + scoring |
| `7ede88d` | fix(eval/matrix): v1.1 review fixes — JSONL tolerance, log split, repo-root anchor, test cleanup |
| `663814a` | feat(eval/matrix): **v1.2 markdown + csv report rendering** |
| `1d23971` | fix(eval/matrix): v1.2 review fixes — csv/md escape (RFC-4180), cellKey helper |
| `efd0601` | feat(eval/matrix): **v1.3 memory-efficacy-4way workload** |
| `fbaf75b` | refactor(eval/matrix): factor classifier workloads via `buildJsonClassifierWorkload` |
| `f03b418` | fix(eval/matrix): point 4way workload at fewshot corpus (caught 0.4952 vs 0.9235 baseline mismatch) |
| `54f338f` | feat(eval/matrix): add memory-efficacy-4way-balanced workload |
| `e5fa1f2` | feat(eval/matrix): **v1.4 model lifecycle** — serial boot/teardown |
| `310c35f` | fix(eval/matrix): v1.4 review fixes — stderr buffer in boot error + exit cleanup hook |
| `46e6ef6` | fix(eval/matrix): strip markdown code fences before JSON parse (caught gemma4 parse-fail) |
| `1ab5ab3` | docs(agents): **add Model selection preferences (MTP-first for Gemma 4 + Qwen 3.6)** |
| `17b2150` | feat(eval/matrix): **v1.5 task-refiner-rubric workload** — judge-scored generation |

### Fork branch repairs (no commit, but real ops)

- `/Volumes/WorkSSD/src/llama.cpp-atomic` (gemma fork) **switched** from `fix/shared-ngram-cache-dynamic` (a negative-result branch) to **`fix/gemma4-swa-full-cache-reuse-steady-state`** (3.5× wall improvement per memory `reference_swa_full_cache_reuse_fix`). Rebuilt.
- `/Volumes/WorkSSD/src/llama.cpp-atomic-qwen` (qwen fork) **switched** from detached `4198d94f8` to **`b1-mtp-qwen-rebase`** (has the Qwen NextN coherent-output fix + async pipeline). Rebuilt.
- Confirmed: granites use upstream `llama.cpp` `master` (correct — no MTP path).

### Memory / docs (not in git)

- `~/.claude/projects/-Volumes-WorkSSD-repos-personal-llamactl/memory/feedback_model_selection_mtp_first.md` — saved MTP-first preference with `[[reference-llamacpp-mtp-binaries]]` link.
- `MEMORY.md` index updated.
- AGENTS.md (committed at `1ab5ab3`) added a 40-line "Model selection preferences" section after the Workloads section. The authoritative source for: prefer MTP variants, quant ladder by architecture, KV cache defaults, context size, and fork binary expectations.

## 2. The matrix harness — what it does, today

**Code:** `packages/eval/src/matrix/` (extends `packages/eval`, not greenfield).
- `types.ts` — `ModelSpec`, `WorkloadEval` (async or sync scorer; optional `judge_model`), `CellRow` (includes `runner_version`).
- `store.ts` — sqlite `matrix_runs` with upsert via `ON CONFLICT(...) DO UPDATE`.
- `runner.ts` — `runMatrix({models, workloads, db})`. Per (model, workload) cell: ensure candidate serving → ensure judge serving (per workload) → load corpus (per-row JSONL parse tolerance) → for each row {fetch /v1/chat/completions → await scorer} → aggregate → insertCellRow → teardown judge → teardown candidate.
- `report.ts` — pivot CellRows to markdown/CSV. `latestCellByModelWorkload` dedupes by (model, workload) using `finished_at`. Handles `mixed` heading when workloads use different primary metrics.
- `lifecycle.ts` — spawn/teardown llama-server per model with `managed:true`. Buffered stderr surfaces on boot fail. Process-exit hook kills owned procs.
- `workloads/common.ts` — `buildJsonClassifierWorkload` factory + `stripCodeFences` helpers.
- `workloads/memory-efficacy-binary.ts`, `memory-efficacy-4way.ts`, `memory-efficacy-4way-balanced.ts` — thin factory instantiations.
- `workloads/task-refiner-rubric.ts` — judge-scored generation. Uses penumbra `REFINER_SYSTEM_PROMPT` verbatim. Judge model is granite-8b-Q4 on :8083.
- `cli.ts` — `--models <json> --workloads <names> --out-db <path> [--report md|csv|both] [--report-out <path>]`.

**20 tests, all passing.** Run via `cd packages/eval && bun test --filter matrix`.

## 3. Bench results (5+ live models × 4 workloads, 32 cells in `/tmp/matrix.db`)

```
| Model                    | mem-eff-4way | mem-eff-4way-balanced | mem-eff-binary | task-refiner |
|--------------------------|--------------|-----------------------|----------------|--------------|
| gemma4-26b-a4b-mtp       |   0.8688     |       0.7381          |    0.8655      |     —        |
| granite-3b-Q8            |   0.9235  ⭐  |       0.4485          |    0.7811      |  0.8089  ⭐   |
| granite-8b-Q4            |   0.6721     |       0.7545  ⭐       |    0.8330      |     —        |
| qwen3-8b-Q4              |   0.8931     |       0.6611          |    0.8655      |  0.7200      |
| qwen3.6-27b-MTP-Q4KM     |   0.0   ❌    |       0.0   ❌         |    0.0   ❌     |     —        |
| qwen3.6-27b-UDQ4KXL      |   0.9202(*)  |       0.0   ❌         |    0.8887  ⭐   |     —        |
| qwen3.6-35b-A3B-UDQ4KXL  |   1.0  (4/60)|       0.0   ❌         |    0.7980      |     —        |
```

**Baseline reproductions (matrix proves the harness is sound):**
- granite-3b-Q8 / 4way-fewshot = **0.9235** — byte-identical to `project_attention_thesis_eval_2026-05-16` (the 12-config eval anchor).
- qwen3-8b-Q4 / 4way-fewshot = **0.8931** — byte-identical to the same anchor.
- granite-3b-Q8 / task-refiner-rubric = **0.8089** — within 1 pp of Phase 2 offline `0.800` (memory `project-bench-2026-05-11-post-evolution` line of work).

**Throughput:**
- gemma4-26b-a4b-mtp (atomic fork + MTP head): **53-56 tps** ← MTP draft acceptance ~85% on a probe.
- granite-3b-Q8: 50 tps. granite-8b-Q4: 30 tps. qwen3-8b-Q4: 35 tps.
- Qwen3.6-35B UDQ4KXL: 28-35 tps (on the cells that completed).
- Qwen3.6-27B UDQ4KXL: 5-9 tps (no MTP path — much slower).

**Report files:** `/tmp/final-matrix-report.md` + `/tmp/final-matrix-report.csv`. Renderer at `/tmp/render-cumulative.ts` (calls the matrix package directly with all DB rows, no run_id filter).

## 4. Live state at handoff

- Penumbra daemon + worker: up. `mcp__penumbra__handoff_list_pending` is clean as of session end.
- llama-servers running:
  - `granite41-3b-judge-local` :8085 (re-enabled at handoff)
  - `granite41-8b-long-lived-local` :8083 (re-enabled at handoff — penumbra t2-judge dep)
- gemma4-26b-a4b-mtp workload variants on :8181: **port-collision** between `gemma4-26b-a4b-mtp-b-1024-local` and `gemma4-26b-a4b-mtp-b-4096-local`. Pre-existing — both claim :8181 in their YAML. Llamactl reports `enable: port collision`. Decide which variant to keep enabled.
- Fork branches: atomic on `fix/gemma4-swa-full-cache-reuse-steady-state`, atomic-qwen on `b1-mtp-qwen-rebase`. Both rebuilt 2026-05-17 19:19 + 19:21.
- Test DB: `/tmp/matrix.db` has 32 cell rows. `/tmp/matrix-models-*.json` files are the model spec fixtures used per phase.
- Working branch: `corpus/refiner-eval`. `git log --oneline main..corpus/refiner-eval` shows the 14 llamactl commits not yet on main.

## 5. Open follow-ups (carry-forward)

### Bench gaps (resume the matrix work)

1. **Qwen3.6-27B-MTP-Q4KM total failure** (180/180 inference errors). The `--spec-type nextn --model-draft <same gguf>` config didn't produce any inferences. Need to (a) capture stderr from the binary on first failed request, (b) check whether `b1-mtp-qwen-rebase` actually has the NextN code path enabled by default, (c) try adding `--reasoning off` removal or `override_arch` env var.
2. **Qwen3.6-35B partial errors on 4way + total failure on 4way-balanced** — Metal OOM during longer prompts. Try (a) ctx-size 8192, (b) `-ctk q4_0 -ctv q4_0` to halve KV again, (c) smaller `-b` and `-ub`.
3. **gemma4-26b-a4b-mtp on task-refiner-rubric not benched** — port-conflict (judge on :8083 vs gemma's default). Fix: edit `workloads/task-refiner-rubric.ts` to put judge on a non-conflicting port (8094) and have models.json provide the judge model spec with that port + managed:true.
4. **granite-8b-Q4 on task-refiner-rubric not benched** — same port-conflict (candidate AND judge would both want :8083). Solve by moving the judge port (per #3 above).

### Code follow-ups (v1.6 candidates)

5. **`--run-id <id>` CLI continuation** — currently each `runMatrix` invocation generates a new runId, so multi-phase benches need post-rendering via a small ad-hoc script (`/tmp/render-cumulative.ts`). Add a `--run-id` flag and a `--report-all-runs` flag to the CLI.
6. **Per-cell host constraint** — `runMatrix` currently always spawns serially even when models could fit concurrently. Add an `expected_memory_gib?: number` on `ModelSpec` and a scheduler that runs RAM-fitting cells in parallel.
7. **Better /health probe** — gemma4 returned 200 on /health while every /v1/* endpoint 500'd (Metal compute error). Add an optional `--boot-probe` tiny inference call before declaring "owned" or "healthy".
8. **Workload-level pre-flight** — the matrix should detect port conflicts between candidate models and `workload.judge_model` and emit a clear error instead of silently running with the wrong server on the port.

### Spec / workload-corpus blockers (need separate effort)

9. **home-mgmt classify path** — blocked on tick-event corpus accumulating (~7 days of B-instr ticks). Spec at `penumbra@ef37e33`. Once corpus exists, add a workload analog of memory-efficacy-binary that loads tick rows.
10. **memory recall scoring (re-rank)** — need to find the call site in penumbra (`fleet-eval-scoping-2026-05-16-night.md` says "inspect first"). Different shape from classifier (NDCG@K or MRR against gold ranking).
11. **dispatch-refine workload** — same shape as task-refiner-rubric but different corpus. Easy add once #5/#8 cleared up.
12. **tool-call-grammar workload** — corpus exists (`packages/train/corpora/tool-call-grammar/test.jsonl` n=2). K-track frozen but bench-able. Different shape — must compare emitted tool_calls vs expected (set-equality of (name, arg-shape)).

### Ops hygiene

13. **Gemma4 workload port-collision** between `b-1024-local` and `b-4096-local` (both claim :8181). User decides which to keep.
14. **Bench leftover JSON files at `/tmp/matrix-models-*.json`** + `/tmp/matrix.db`, `/tmp/final-matrix-report.md/csv` — keep or rotate.

## 6. Memories worth reading first

- `reference_llamacpp_mtp_binaries.md` — fork paths + which binary for which family.
- `reference_swa_full_cache_reuse_fix.md` — the SWA-full branch's actual fix (server-context.cpp `may_have_checkpoints` refactor). 3.5× wall.
- `reference_penumbra_dispatch_routing.md` — daemon defaults to penumbra repo; for llamactl dispatches use `use_worktree:false` + `caller_cwd` + explicit `cd` in prompt. (Bit me twice this session — spec landed in wrong repo, had to revert.)
- `feedback_model_selection_mtp_first.md` — NEW this session. Prefer MTP variants for Gemma 4 + Qwen 3.6. Codified in AGENTS.md.
- `project_attention_thesis_eval_2026-05-16.md` — the 12-config baseline (granite-3b-Q8 = 0.9235 macro-F1). Now byte-reproduced by the matrix.
- `reference_dispatch_stall_trap.md` — applied once this session (silent-success-no-commit on first task-refiner dispatch; recovered via re-dispatch with anti-brainstorm framing).
- `reference_adversarial_review_workflow_cwd.md` — workflow can't run against llamactl cwd; got HTTP 404. Hand-reviewed instead. (Fix landed in penumbra@133bb12 per memory, but llamactl-cwd workflow still broken on this session's daemon.)

## 7. First moves

1. `git status --short && git log --oneline -5 && launchctl list | grep penumbra && mcp__penumbra__handoff_list_pending`
2. `cd packages/eval && bun test --filter matrix 2>&1 | tail -10` — confirm 20/20 still green
3. `llamactl get workloads | head -15` — confirm granite-3b + granite-8b still Running; resolve gemma4 port-collision (decide b-1024 vs b-4096) before any gemma bench attempts
4. `pgrep -fl llama-server` — confirm 2 expected processes (granites); decide whether to start gemma4 for any follow-up bench
5. **Pick a thread:**
   - Diagnose Qwen3.6-27B-MTP nextn failure (§5.1) — quick: spawn the binary by hand with `--spec-type nextn` and capture stderr from /v1/chat/completions
   - Resolve port-conflict for task-refiner-rubric so gemma4 + granite-8b can be benched (§5.3-4) — small refactor + re-run
   - Move on to corpus-blocked workloads (§5.10-12) — needs research time

## 8. Decisions not to re-litigate

- The matrix lives at `packages/eval/src/matrix/` (extension), not greenfield. The `packages/eval` framework already had store/sqlite, runners, score, report — we extended it.
- `runner_version: 0` = v0 placeholder, `runner_version: 1` = real inference. Sentinel ensures mixed DBs are decodable. Don't change.
- The `latestCellByModelWorkload` dedup uses `finished_at` lex-sort on ISO strings. Works because ISO is lex-sortable. Don't switch to numeric without checking the call sites.
- Atomic fork (gemma) is on `fix/gemma4-swa-full-cache-reuse-steady-state`; atomic-qwen is on `b1-mtp-qwen-rebase`. Don't switch back.
- AGENTS.md "Model selection preferences" is the authoritative source for default model picks. The `feedback_model_selection_mtp_first.md` memory points at it. Edit AGENTS.md for canonical updates.
- The classifier factory `buildJsonClassifierWorkload` (`workloads/common.ts`) is the right pattern for new classifier workloads — new ones are ~5 lines each (`memory-efficacy-4way-balanced.ts` proves it).
- Task-refiner-rubric uses an **async** scorer + judge_model. This required extending `WorkloadEval.scorer` to allow `Promise<...>`. Don't revert to sync-only.
- Reports filter by `runId` only when present in opts; passing `{}` renders the cross-run latest-by-(model,workload). The CLI defaults to filtering; `/tmp/render-cumulative.ts` is the workaround until §5.5 lands.
