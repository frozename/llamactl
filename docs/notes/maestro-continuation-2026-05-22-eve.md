# Maestro continuation prompt — 2026-05-22 eve

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## TL;DR of the last session

Massive day. Three threads landed:

1. **Production routing for 35B-A3B fully wired**: `gains-host-35b-local` workload on M4 Pro :8096 (oMLX MLX-4bit), penumbra `PENUMBRA_JUDGE_BASE_URL` + `PENUMBRA_JUDGE_MODEL` pointed at it, dreaming-judge + memory-refiner + brief-synthesizer pool agents added to agentchat.yaml. Thinking-mode forced off via `~/.omlx/model_settings.json`.

2. **dflash permanently shelved**: built `project-brief-gen` long-gen workload (30-row corpus from real penumbra t2_memories), benched against 35B-A3B vanilla vs +dflash. Vanilla wins quality + throughput (0.945/70tps vs 0.897/53tps). Combined with prior data, dflash regresses across all our workload shapes on MoE. Decision-contract memory entry written.

3. **Fleet supervisor package shipped** (`packages/fleet-supervisor/`): L1 observability (vm_stat node-probe + workload HTTP probe + jsonl journal + heartbeat) + L2 reactive (SMA-hysteresis pressure detection emitting transitions + eviction proposals; per-workload degradation detection emitting restart proposals) + L5 predictive admission (`projectAdmissionHeadroom` wired into `apply.ts`, standalone `llamactl admit` dry-run verb). CLI: `llamactl supervisor {serve,tick}` + `llamactl admit <name>`. Adversarial-review fan-out caught 16 real findings, 13 fixed in one batch. **37 tests / 90 assertions all green.**

## What's on main

```
208a039 fix(fleet-supervisor): adversarial-review findings batch
8ab8169 feat(cli): llamactl admit — predictive admission dry-run (L5)
c20f4c0 feat(cli): llamactl supervisor — fleet observability verb
e25bc2a feat(fleet-supervisor): Phase 7 — per-workload degradation policy (L2)
d48b0be feat(fleet-supervisor): Phase 6 — pressure detection wired into loop (L2)
48fae2a feat(fleet-supervisor): Phase 4 — one-tick supervisor loop (L1)
ec9e0f8 refactor(fleet-supervisor): deduplicate; consolidate on packages/fleet-supervisor
9c30772 feat(fleet-supervisor): Phase 1 — admission preflight + snapshot types        [autonomous]
74147eb feat(fleet-supervisor): Phase 4 — policy engine                                [autonomous]
c6109ab feat(fleet-supervisor): Phase 1-3 — package scaffold + probes + journal        [autonomous]
34a97cc docs(notes): session journal 2026-05-18 through 2026-05-22
d1d9acf docs(superpowers): MLX upstream patches + fleet-supervisor specs/plans
4aecb34 eval(results): project-brief-gen + 2026-05-21 stress-L fleet benches
543c789 feat(workloads): gains-host-35b-local — 35B-A3B MLX production ModelHost
```

The autonomous commits came from a runaway `adversarial-plan` workflow cascade that fired ~10× before I killed it. They produced real, useful code (`packages/fleet-supervisor/` Phases 1-3 + the admission preflight wire in `apply.ts`); the `ec9e0f8` cleanup consolidated two parallel implementations the cascade created.

## Fleet state (live)

- **M4 Pro local**: oMLX 35B-A3B on :8096 (gains-host, managed, mcr=4, thinking-off via central model_settings.json), llama-server granite-3b-Q8 on :8083 (long-lived judge), penumbra daemon on :51257.
- **Mac-mini iso**: oMLX granite-3b-mlx on :8194, granite-8b-nvfp4 on :8195, qwen3-8b-mlx on :8196. All mcr=4.
- **agentchat role pools** (after this session's audit + bench-informed wiring):
  - `memory-refiner` = local-granite-3b-q8 + mac-mini-granite-3b-mlx-iso (Q8 GGUF + MLX 4bit diversity)
  - `dreaming-judge` (≥2 quorum) = above two + local-qwen36-35b-a3b-mlx (quality tie-breaker)
  - `brief-synthesizer` = local-qwen36-35b-a3b-mlx (primary) + mac-mini-qwen3-8b-mlx-iso (fallback)
- **Penumbra worker is DISABLED** via `launchctl bootout` + `disable gui/$UID/dev.penumbra.worker`. Daemon (PID may have changed) still up. **To re-enable for next session**: `launchctl enable gui/$UID/dev.penumbra.worker && launchctl bootstrap gui/$UID /Users/acordeiro/Library/LaunchAgents/dev.penumbra.worker.plist`.

## What's deferred (the fleet-supervisor follow-ons)

From the 16 review findings: 13 closed in `208a039`. Still open:

1. **#5 (deeper)** — admission relies on `spec.resources.expectedMemoryGiB` from YAML. Memory `[mac-mini RAM admission underestimate 2026-05-17]` documents that YAML can underestimate by ~30%. Real fix is probing actual model load (e.g., `llama-server --dry-run` or oMLX `omlx serve --load-only`). Larger work.

2. **#6 (architectural half)** — supervisor is propose-only; proposals get written to jsonl and nothing acts on them. The Phase 5 of the plan calls for a severity-gated executor (tier-2 auto, tier-3 manual `--execute=<id>`). Not started.

3. **#9** — `appendFileSync` on the tick hot path. Fine at 30s default; will matter if anyone drops the interval. Add an async variant.

4. **launchd plist** for `llamactl supervisor serve` — currently runs only in the foreground via the CLI verb. Production wiring as a per-node launchd service is a follow-on.

5. **MCP federation** — Phase 6 in the plan (`llamactl.fleet.*` tools via `@llamactl/mcp`). Not started.

6. **`mac-mini-granite-8b-nvfp4-iso` has roles: []** — agentchat entry added for visibility but no production role assigned. Bench it if a heavier mac-mini judge becomes useful.

7. **mac-mini Q8 GGUF judge (`granite41-3b-judge-mac-mini`)** is `Stopped`. Mac-mini at 16GB can't fit Q8 GGUF + the 3 iso models. Acceptable — `mac-mini-granite-3b-mlx-iso` (MLX 4bit) covers the role.

## Memory entries to read first

- `project_fleet_supervisor_landed_2026-05-22` — what the supervisor delivers + re-entry conditions + plan ref
- `project_dflash_long_gen_shelf_2026-05-22` — dflash decision-contract; don't re-bench unless workload shape changes
- `project_gains_2026-05-21` — 35B-A3B routing rationale + bench data
- `[oMLX vs llama.cpp Qwen3-8B 2026-05-19]` — engine comparison context

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. **Re-enable the agentchat-worker** (it was disabled to stop a cascade):
   ```
   launchctl enable gui/$UID/dev.penumbra.worker
   launchctl bootstrap gui/$UID /Users/acordeiro/Library/LaunchAgents/dev.penumbra.worker.plist
   ```
4. Verify daemon + worker:
   ```
   launchctl list | grep penumbra
   pgrep -af "agentchat-worker"
   ```
5. `mcp__penumbra__memory_search query="fleet-supervisor 2026-05-22"` to load the supervisor memory.
6. Pick a direction from the deferred list (likely candidates: launchd plist for `supervisor serve` → continuous production observability; or Phase 5 executor → make proposals actionable).

## Operational notes

- **`adversarial-plan` cascade trigger is still unknown.** When I dispatched once at 17:26 it never reached terminal (synthesizer timed out), and every daemon restart re-fired the workflow_run. Cancelled all stuck runs via DB UPDATE. If new ones appear: `sqlite3 ~/.penumbra/db.sqlite "UPDATE workflow_runs SET status='cancelled' WHERE status='running' AND workflow_name='adversarial-plan'"`.
- **Synthesizer reliability is bad on this surface.** Two adversarial fan-outs this session — both stalled at the synthesizer step despite individual persona dispatches completing fine. The persona outputs themselves were high-quality + actionable.
- **The `adversarial-plan` workflow's `architect` + `test-first` personas can produce empty outputs** when the daemon worker connection drops mid-run. Saw this twice. If you re-run a fan-out, confirm all 5 persona .md files have substantive content before relying on them.

## Untracked-in-repo (intentional)

- `.claude/scheduled_tasks.lock` — session state
- `templates/workloads/stress-fleet-L-mac-mini.yaml.bak` — operational backup

Nothing else uncommitted.
