# Maestro continuation prompt — 2026-06-06 pm

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; don't query sqlite except for forensics. Keep commits/repo text neutral (no AI attribution). Delegate coding via `chain_start`; hand-code when the worker/daemon won't boot or for correctness-critical changes you fully understand.

## State at handoff (verified)

- `main` == `origin/main` == `b67bbee` (oMLX ModelHost proxy stabilization burst). Clean of code; untracked = session notes + new bench artifacts (below).
- **Branch `fix/modelhost-visibility-in-budget-and-list` = `eab693a` (L6 fix, NOT pushed)** — committed off `main`, 18 tests + remote/mcp/app-web typechecks green. Land decision pending.
- llamactl agents are **launchd-managed**: `com.llamactl.internal-proxy` (the openaiProxy, `agent serve --port=7944`), `com.llamactl.node-agent`, `com.llamactl.controller`, `com.llamactl.fleet-supervisor`. The internal-proxy started before the last 2 commits (`bc05a4f`/`b67bbee`) — `launchctl kickstart -k` it to pick up HEAD if needed.
- **Model root** = `~/DevStorage` (symlink→`/Volumes/WorkSSD`) `/ai-models/llama.cpp/models` = `$LLAMA_CPP_MODELS`. (`~/.llamactl/ai-models` is a stale partial copy — ignore.)
- **oMLX venv is uv-managed** (no pip): `/Volumes/WorkSSD/src/omlx/.venv`. **mlx-vlm upgraded 0.5.0 → 0.6.2** this session (transformers 5.8.1→5.10.2 + minor web deps). Rollback snapshot: `/tmp/omlx-venv-freeze-pre-mlxvlm-2026-06-06.txt`.
- **User's 80B** `mlx-qwen3-coder-next-local` (Qwen3-Coder-Next, `qwen3_next` arch) is RUNNING on `:8086`, verified working on the upgraded stack. Do not disturb without permission unless benching (user gave full stop/modify permission this session, but re-confirm).
- `granite41-3b-long-lived-local` judge running on `:8083`.

## What shipped this session

- **L2 oMLX ModelHost live-verify** ✅ — proxy routes oMLX ModelHosts end-to-end (`:7944` → oMLX `:8086`, returned content); 88 burst unit tests green. Finding: the "apply rejected 45 GiB" was CORRECT admission (counts ModelHosts); only the read-back views didn't show them → L6.
- **L6 ModelHost visibility fix** ✅ committed (`eab693a`) — `nodeBudget` + `workloadList` (router) + the MCP `workload.list` handler now count/list ModelHost workloads with a `kind` discriminator; `modelHostStore` exported from the remote barrel. Was inconsistent with admission (`listAnyWorkloadsForAdmission`). **Push/land pending.**
- **L3 Gemma 4 12B — fully benched** (packages/eval matrix):
  - llama.cpp family: `Q4_K_M` wins — beats 26B-A4B incumbent on memory-recall (0.849) + tool-call (0.720); QAT-Q4_0 ≉ better than PTQ on Metal. (memory `91b2f13e`)
  - **Engine comparison: MLX-4bit (oMLX) > llama.cpp Q4_K_M on quality** — tool-call 0.90 vs 0.72, recall 0.872 vs 0.849; ~25-30% slower. (memory `9f2f544b`) Enabled by the mlx-vlm 0.6.2 upgrade (gemma4_unified arch).
- **L5 t2-recall verify** ✅ — `title_plus_concise` fix working: 18 previously-buried (pre-2026-06-01) t2 memories surfaced in the 122-recall post-window; all-time never-retrieved still 63% (small window). Reusable probe + method in memory `bfc206d8`.
- Hygiene: 5/5 orphan penumbra worktrees GC'd. Memories: `34400a96` `91b2f13e` `bfc206d8` `567687fc` `9f2f544b`.

## Open work

- **L4 — re-enable oMLX KV in the proxy slot cache** (reverse `4e101c7`). Scoped + validated + REVERTED (clean). Live oMLX confirmed `api_version:2, supports_request_handle:true` so it engages for real. Reverted because re-enabling adds a `/v1/slots/capabilities` probe that breaks 5 routing tests in `openaiProxy.test.ts`. **Full completion recipe in memory `567687fc`** (2 source edits + filter slot-probes from 5 routing assertions + flip eligibility test + add positive-path test + live round-trip). Land on its own branch off `main`.
- **Land L6** — push `fix/modelhost-visibility-in-budget-and-list` + merge (re-runs live after an agent restart show ModelHosts in node_budget/workload_list).
- **Untracked bench artifacts** to commit if wanted: `packages/eval/specs/gemma4-12b-vs-family-2026-06-05.json` (ports 8140-8143), `packages/eval/specs/gemma4-12b-engine-cmp-2026-06-06.json`, results `packages/eval/results/gemma4-12b-{clean,engine-cmp-v2}.{md,csv,db}`.
- **Idea**: promote MLX-4bit 12B to a production oMLX ModelHost workload (it wins quality). Template: `templates/workloads/mlx-host-local.yaml` pattern; mind the node budget (36 GiB; 80B reserves 28).

## First moves

1. `git status --short && git branch -vv | grep -E 'main|modelhost' && launchctl list | grep llamactl && git log --oneline -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean.
3. Verify 80B + stack: `curl -s 127.0.0.1:8086/v1/models` and `/Volumes/WorkSSD/src/omlx/.venv/bin/python3 -c "import mlx_vlm;print(mlx_vlm.__version__)"` (expect 0.6.2).
4. Pick: land L6, complete L4 (recipe `567687fc`), or promote MLX-4bit 12B — decide with the user.
