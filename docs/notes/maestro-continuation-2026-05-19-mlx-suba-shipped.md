# Maestro continuation — 2026-05-19 MLX Sub A shipped + bench in flight

> Paste this block into the next session.

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

Follow `AGENTS.md`. Use Penumbra MCP for chain state; never query `~/.penumbra/db.sqlite` directly except for forensics. Repo-facing text is neutral — no AI/tool authorship attribution. Delegate substantive code via `chain_start`; hand-implement only when the worker/daemon won't boot.

Execute First moves (section 6) immediately and in parallel. Pause only for items with user-visible blast radius (push, dispatch_land, restart hosted services, external messages) or genuine ambiguity.

## 1. What this session shipped — MLX Sub A end-to-end

Branch advanced ~30 commits from `dede87c` → `2b918de` (and beyond if the head-to-head bench commit lands by next session). Six waves + manual smoke executed, each gated by an adversarial review, then push.

**Code commits** (oldest → newest, abbreviated):
- Wave 1 (Phase 1.1/1.2/3.1/5.2/6.3): `232d591`, `fcb9d4f`, `988157e`, `d707085`, `edce0e6`
- Wave 1 hardening (3 fix bundles from adversarial review): `a2a947e`, `5fbeca5`
- Wave 2 (Phase 2.1/2.2/2.3/3.2): `761f822`, `42f1b99`, `234fdee`, `01e866b`
- Wave 2 hardening (3 fix bundles + schema unification): `30035f4`, `d7edc3a`, `6794328`
- Wave 3 (Phase 4.1, 4.3): `5ae4834`, `1aa8900`
- Wave 3 hardening (4 fix bundles): `77020e7`, `4386f22`, `70b18d3`, `03ce53a`
- Wave 4 (Phase 6.1, 6.2; 4.2 deferred to A+B unified): `c8ab9e7`, `f0b67b6`
- Phase A+B unified persistence (closed Tasks 4.2 + 5.1 as one architectural piece): `675bb4b`, `d189667`
- Phase A+B hardening (route-map alias collisions, SSRF on sidecar host, /v1/models cache, IPv6, schema strictness): `2ae1b3d`
- oMLX MTP branch pivot then revert to main HEAD: `8abbce5`, then re-pinned in `2b918de`
- Phase 6.4 smoke run integration fixes: `b7f50d2` (CLI ModelHost dispatch), `61c1d9f` (model rel pivot), `2b918de` (final smoke integration bundle)

All branches pushed up to `2b918de`.

## 2. Phase 6.4 manual smoke — PASS

Run on M4 Pro 2026-05-19. Each step:

| Step | Result |
|---|---|
| 1. `tools/install-omlx-from-source.sh` | ✅ Cloned `jundot/omlx@f6f4269` to `/Volumes/WorkSSD/src/omlx/`, `uv venv`, editable install. Entrypoint at `/Volumes/WorkSSD/src/omlx/.venv/bin/omlx` |
| 2. `omlx --help` | ✅ `serve / launch / diagnose` subcommands |
| 3. `llamactl pull lmstudio-community/Qwen3-8B-MLX-4bit` (4.6 GB) | ✅ files at `/Volumes/WorkSSD/ai-models/llama.cpp/models/Qwen3-8B-MLX-4bit/` |
| 4. `tools/smoke-modelhost-omlx.sh` | ✅ Apply manifest → readiness → chat completion (61 chars in 0.64s) |
| 5. `bun packages/eval/src/matrix/cli.ts --models packages/eval/specs/mlx-pilot.json --workloads tool-call-grammar` | ✅ 50/50 rows scored, exact_match 0.48 |
| 6. `tools/omlx.lock` `verified_date` | ✅ Stamped 2026-05-19 |

## 3. Integration gaps caught + fixed during smoke

These were not in the plan; surfaced only at run time:

1. **`mlx-community/Qwen3-8B-MLX-4bit` doesn't exist on HF**. The canonical Qwen3-8B MLX-4bit is published under `lmstudio-community/`. Updated yaml + smoke + spec.
2. **CLI's `apply` had no ModelHost dispatch** — `packages/cli/src/commands/workload.ts` peeked `kind` and routed NodeRun separately, but ModelHost fell through to ModelRunSchema. Added `applyModelHostFromRaw` calling `workloadApply.applyManifest`.
3. **oMLX `feat/speculative-decoding` branch has a GPU-stream bug** (`RuntimeError: There is no Stream(gpu, 0) in current thread` in `scheduler.py#L416`). Reverted lockfile from `24e1bbd2` → main HEAD `f6f4269`. MTP / speculative-decoding on mainline lives as `dflash` (draft-flash), enabled per-model via model settings rather than CLI flags. The user wanted MTP; main HEAD has it via dflash.
4. **Matrix CLI validator hardcoded `gguf_path`** — made engine-aware so omlx specs require `mlx_model_dir` instead.
5. **`buildCompletionRequest` hardcoded `model: 'local'`** — added optional `model` parameter; `ModelSpec.request_model_id` threads it through `runner.ts`. llama.cpp keeps the `--alias local` default; oMLX (multi-model) needs the directory basename (e.g. `Qwen3-8B-MLX-4bit`).
6. **`lifecycle.ts:106` did `basename(model.gguf_path)` unconditionally** — undefined for omlx specs, breaking matrix boot. Now uses `request_model_id` first, then `gguf_path`, then `model.name` fallback.

## 4. Known-deferred to Sub B

1. **ModelHost persistence into the workload store.** `apply` writes `<runtime>/workloads/<name>/modelhost.{pid,state}` sidecars (Phase A in `675bb4b`); discovery via `listLocalRoutes` finds them; the proxy routes through them. But `llamactl disable mlx-host-local` fails because the workload manifest never reached `defaultWorkloadsDir`. The smoke's cleanup trap calls disable best-effort and ignores failure. Sub B wires ModelHost into the canonical desired-state reconcile loop.
2. **Phase 6.4 left an oMLX process orphaned at session end** — manually `pkill -f "omlx serve"` to clean up before next bench (or accept it's just sitting there idle on :8094).
3. **Architectural objection** from `devils_advocate` persona: ModelHost as a parallel system beside ModelRun. Plan accepts this explicitly. Sub B should consider unifying.

## 5. In-flight at session end

**Head-to-head bench**: Qwen3-8B-MLX-4bit (oMLX) vs Qwen3-8B-Q4_K_M (llama.cpp) on `tool-call-grammar` + `memory-recall`. Started in background just before this note was written. Result tail in `/tmp/bench-mlx-llamacpp.log`; report dir `packages/eval/results/2026-05-19-qwen3-8b-mlx-vs-llamacpp/`. Open spec: `packages/eval/specs/qwen3-8b-mlx-vs-llamacpp.json`. Check the log + db when picking up — if the bench finished, the report should be in the results dir.

## 6. First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -10`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `ls -la packages/eval/results/2026-05-19-qwen3-8b-mlx-vs-llamacpp* 2>/dev/null || tail -40 /tmp/bench-mlx-llamacpp.log` — check the bench result
4. `pgrep -fl "omlx serve" || echo "no orphan omlx"` — clean up the smoke run's leftover process if still around
5. `mcp__penumbra__memory_search` for `project_mlx_engine_sub_a_2026-05-18` to refresh the architectural choices
6. Decide direction with user from open work below

## 7. Suggested next directions (pick with user)

- **Sub B kickoff**: persist ModelHost into the workload store so `llamactl list` + `disable` work uniformly. Likely requires `applyOne`-style flow for ModelHost that goes through `defaultWorkloadsDir` write. Substantial — write a spec first via brainstorm or write-plan.
- **Expand MLX fleet**: pull more `lmstudio-community/Qwen3-*-MLX-*` variants, build the full oMLX-vs-llama.cpp comparison matrix.
- **Enable dflash MTP per-model** on the existing MLX pilot, re-bench to measure MTP lift on oMLX (closing the loop on the user's "MTP support" ask).
- **Sub C (mac-mini ModelHost)**: would require the workload store integration from Sub B to dispatch to a remote node via `client.serverStart`-equivalent.
- **Sub D (train-loop integration)**: serve `packages/train/`'s LoRA adapters via oMLX. Highest end-state value per the spec; depends on Sub B.

## 8. Memories worth re-reading

- `project_mlx_engine_sub_a_2026-05-18` — original Sub A pick + spec + plan pointers
- `reference_penumbra_dispatch_routing` — every chain_start needs `use_worktree: false` + explicit `cd`
- `feedback_model_selection_mtp_first` — MTP-first qualifier (generation/ranking yes, classification no)
- `reference_dispatch_stall_trap` — codex-acp-fast may edit cleanly but stall before committing; we hit this twice this session, both times the changes were ready and just needed manual commit
- `reference_adversarial_review_big_diff_truncation` — N persona reviews truncate on big diffs; we ran 4 adversarial reviews this session, all 8/8 personas completed
