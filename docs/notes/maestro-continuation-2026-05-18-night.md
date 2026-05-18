# Maestro continuation — 2026-05-18 night

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`. Follow `AGENTS.md`. Use Penumbra MCP for chain state. Keep commits and repo-facing text neutral, no AI/tool attribution. Delegate via `chain_start` with `trust_mode: "all"` when possible — note that today the worker stalled on 2 dispatches before recovering on a third; if `chain_status` reports "approved on unassigned" past ~30s, the dispatch may still complete silently. Verify by `git log` and `bun test`, not by chain status alone.

## 1. What this session shipped

**14 commits on `main` (now at `dede87c`, 26 ahead → pushed to origin).** Plus 22 commits FF'd from `corpus/refiner-eval` earlier in the day.

Code:
- `cc19bdc` task-refiner judge port collision (judge moved to :8094, URL derived from spec).
- `b0914c6` `/v1` boot-probe in lifecycle — durable fix for "boots green, infers red" failure mode.
- `5d74321` `--run-id` + `--report-all-runs` CLI flags for multi-phase report consolidation.
- `9d3f0d0` HF token propagation in `packages/core/src/pull.ts` — fixes "unauthenticated, rate-limited, restart from byte 0" failure mode.
- `d727a88` tool-call-grammar workload (set-equality of (name, sorted arg_keys)).
- `976681f` `mean_exact_match` aggregator (informative on small corpora).
- `136aef2` memory-recall workload scaffold (NDCG@5) + 5-row seed corpus + spec.
- `dede87c` accumulated 28 session-summary / continuation notes + 1 mac-mini template.

Memories saved (in `~/.claude/projects/-Volumes-WorkSSD-repos-personal-llamactl/memory/`):
- `project_qwen36_27b_mtp_nextn_resolved_2026-05-18.md` — supersedes the "failed" claim; was Metal compute starvation.
- `project_a3b_beats_mtp_dense_2026-05-18.md` — A3B-MoE beats 27B-dense+MTP on M4 Pro (4× tps, ≥ quality).
- `project_mtp_35b_atomicchat_2026-05-18.md` — MTP-35B wins task-refiner generative, regresses on classification.

Tests: 39/39 matrix tests passing.

## 2. Bench artifacts at handoff

- `/tmp/matrix.db` — 60+ cells across Tiers A-F + tool-call + memory-recall.
- `/tmp/final-matrix-report.md|csv` — consolidated 56-cell report at last render. Re-render via `bun /tmp/render-cumulative.ts`.
- Per-workload winners as of session end:
  - mem-eff-4way: `qwen3.6-35b-A3B-UDQ4KXL` = 0.9313
  - mem-eff-4way-balanced: `qwen3.6-27b-UDQ4KXL` = 0.7976
  - mem-eff-binary: `qwen3.6-27b-MTP-Q4KM` = 0.8887 (slow at 9 tps)
  - task-refiner-rubric: `qwen3.6-35b-A3B-MTP-UDQ4KXL` = 0.8711
  - tool-call-grammar (n=8): `gemma4-26b-a4b-mtp` = 5/8 = 0.625
  - memory-recall (n=5 seed): `gemma4-26b-a4b-mtp` = 0.974 ≈ ties `qwen3.6-35b-A3B-UDQ4KXL` 0.971
- Model spec fixtures preserved at `/tmp/matrix-models-{tier-a,tier-b,tier-c-refiner,tier-d,tier-e,tier-f,toolcall}.json`.

## 3. Atomic-qwen fork audit findings

- `tools/server/server-context.cpp:2236` — `TAG_SERVER_SPEC_REWORK` TODO: per-slot draft context not shared. Multi-slot perf opportunity; doesn't bite at `-np 1`.
- `tools/server/server-context.cpp:725-746` — shared-model NextN doesn't explicitly copy `n_gpu_layers` from `params_spec` to `params_dft`. Defensive clarity issue; doesn't change bench numbers (verified by Tier F: same args ± `-ngld 999` produced identical wall-time throughput because prompt-processing dominates).
- WIP commit `86ffbdae1` ("B1 NextN baseline target sampling regression") — bug fixed at `1a1ffa639`. Resolved.
- No test coverage for async NextN pipeline (`4e88713e3`). Risk surface.
- Verdict: 27B-MTP at 5-9 tps is a fundamental cost of running 27B dense + verification per token, not fixable via fork patches. Use 35B-A3B variants for production where MoE active-params (3B) saturate Metal compute much sooner.

## 4. Open follow-ups (carry-forward)

### Memory-recall corpus expansion (high priority — biggest pending value)

Spec at `docs/specs/2026-05-18-memory-recall-workload.md`. Decisions locked by user:
- Hybrid 50 mined + 50 synth (target n=100).
- Candidates: BM25 top-10 from penumbra's real `search()`.
- Task: rank-order; metric: NDCG@5.

**Penumbra DB state:**
- 327 t2 memories total (`mcp__penumbra__memory_status`).
- 363K t0_events, 8K t1 rollups.
- `t2_memory_verification_events` records *which* memory was verified but NOT *what query* triggered the retrieval.
- 1 existing corpus (`acp-features`) is empty.

**Mining recipe options for the 50 logged-real half:**
- (A) Pull recent `verifyMemory` audit-trail entries — they should record memory_id + session_id; join to t0_events in same session to pick a representative agent question; treat that as `query`. Gold = the verified memory. Run penumbra `search()` to fill candidates.
- (B) Use t1 → t2 promotion lineage: for each of 50 t2 memories, find the original t1 rollup; treat the rollup body as `query`; gold = the promoted t2 (and any verified neighbors).
- (C) Sample 50 distinct memory_search queries from t0_events `tool_call` records where `tool_name='memory_search'` — and use the matching agent decision as gold proxy.

**For the synthetic 50:**
- Sample 50 t2 bodies across obs_types.
- For each, prompt a labeler (qwen3-8B with `--jinja` per `reference_qwen3_jinja_tool_call_gold_standard`, or granite-8b which scored 0.93 NDCG when it parsed in the seed test) with: "Write one question this memory would answer + 3 near-miss questions."
- BM25 top-10 candidates per generated question.

**Then:**
- Write `packages/eval/corpora/memory-recall/v0/test.jsonl` (combined, shuffled, n=100).
- Update `packages/eval/src/matrix/workloads/memory-recall.ts` `corpus_path` to point at the new file.
- Bench across 6-8 models on the quiet machine.

### Tool-call-grammar corpus expansion (medium priority)

`packages/train/corpora/tool-call-grammar/uncommon-v0/splits/test.jsonl` is n=8. Even with `mean_exact_match` metric, that's only 8 graded steps per cell. Target: n=30+ for stable readings. Source: penumbra `t0_events` `tool_call` records (record both the call shape AND the surrounding `messages`/`tools` for replay).

### Optional fork PR (low priority)

Add explicit `params_dft.devices = params_spec.devices; params_dft.n_gpu_layers = params_spec.n_gpu_layers;` at `tools/server/server-context.cpp:725-746` (or just-after, depending on the conditional). Defensive only — doesn't affect current bench numbers. Send upstream to atomic-qwen fork.

### Ops hygiene

- The 28 docs/notes that got auto-tracked via `git add -A` could be moved into a `docs/notes/archive/` subdir to declutter the listing. Not urgent.
- `gemma4-26b-a4b-mtp-b-1024-local` ↔ `b-4096-local` :8181 port collision is unresolved — only one can run at a time. Pick one and `disable` the other for good (or assign distinct ports).

## 5. Machine state at handoff

- Penumbra daemon + worker: up. `handoff_list_pending` clean.
- `llamactl controller` was unloaded during bench runs; re-loaded at session end. It auto-respawns `granite41-8b-long-lived-local` on :8083 every 15s — that's by design for the t2-judge dependency.
- Branch: `main` at `dede87c`, pushed to origin.
- `corpus/refiner-eval` still exists; can be deleted now that everything merged. Working branch convention is whatever you prefer for the next session.

## 6. First moves

1. `git status --short && git log --oneline origin/main..main && launchctl list | grep penumbra && mcp__penumbra__handoff_list_pending`
2. `cd packages/eval && bun test --filter matrix 2>&1 | tail -10` — confirm 39/39 still green.
3. Pick a thread:
   - **Memory-recall corpus build** (§4 above) — biggest payoff. Start with mining recipe (A) above for the logged-real half.
   - **Tool-call corpus expansion** — smaller, quicker.
   - **Fork PR** — defensive cleanup.

## 7. Decisions not to re-litigate

- MTP-first rule needs two qualifiers: (a) prefer MTP for **dense** Qwen 3.6 variants only when throughput beats non-MTP A3B; (b) for **A3B/MoE** families, plain MoE beats dense+MTP because active-params are already tiny. Both qualifiers captured in `project_a3b_beats_mtp_dense_2026-05-18.md`.
- `-ngld 999` doesn't change matrix bench numbers (prompt processing dominates wall-time tps for our corpora). Don't waste time chasing it.
- Boot-probe is in lifecycle (`packages/eval/src/matrix/lifecycle.ts`). Don't remove or weaken it — it's the only signal we have for "boots green, infers red" failures.
- `mean_exact_match` and `mean_ndcg5` are the right metrics for sub-30-row corpora. `macro_f1` floor-pegs on small unique-class counts.
- Worker stall mode is real: chain_status "approved on unassigned" past ~30s may still complete; check git log before re-dispatching.
- `llamactl pull` fix in `9d3f0d0` reads `~/.cache/huggingface/token` (or `$HF_HOME/token`); don't remove that helper.

## 8. Memories worth reading first

- `project_a3b_beats_mtp_dense_2026-05-18.md` — production model selection.
- `project_mtp_35b_atomicchat_2026-05-18.md` — workload-shape sensitivity of MTP.
- `project_qwen36_27b_mtp_nextn_resolved_2026-05-18.md` — quiet-machine necessity for bench reliability.
- `feedback_model_selection_mtp_first.md` — the original MTP-first rule; now needs the qualifiers above.
- `reference_fork_branches_correct_2026-05-17.md` — fork → branch → binary mapping.
