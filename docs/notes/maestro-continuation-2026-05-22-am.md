# Maestro continuation prompt — 2026-05-22 am

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## TL;DR of the last session

Long arc covering MLX/oMLX upstream patches second wave → gains exploration → cross-node spawn regression debug → memory cleanup automation. Net deliverables:

- **5 oMLX patches PR-ready** on `frozename/omlx` branches (A.3 + C.1 [+prefill +cascade-safe] + C.2 + per-model-perf-knobs + admission-pause-refinement). Patch files + PR descriptions in `docs/upstream-patches/omlx-*.{patch,md}`.
- **1 MLX branch promoted** (`feat/stream-generation-counter`, A.1 standalone).
- **Workload-routing finding validated at c=4 mcr=4**: memory-recall + task-refiner-rubric → 35B-A3B local (+7.9 pp / +8.9 pp NDCG); tool-call-grammar + memory-efficacy-4way stay on mac-mini iso (qwen3-8b/granite-3b win 4-8 pp).
- **dflash shelved** — no quality lift on either short ranking or long-gen workloads in our corpus.
- **Bun canary** (1.4.0) on both nodes; backups at `~/.bun/bin/bun-1.3.13.backup`.
- **Mac-mini iso spawn regression RESOLVED** with deep root cause analysis. See `project_mac_mini_iso_spawn_regression_2026-05-21` memory.

## What's on the forks (oMLX)

| Branch | SHA | Status |
|---|---|---|
| `feat/max-completion-batch-size` | 26a2033 | already pushed |
| `feat/recovery-on-metal-error` | d779299 | local, with decode + prefill + cascade-safe cleanup |
| `feat/per-model-concurrency` | 2bdc21b | local |
| `feat/per-model-perf-knobs` | 7a44410 | local (on top of per-model-concurrency) |
| `feat/admission-pause-refinement` | 2a8cf0b | local (on top of per-model-concurrency) |
| `validate/all-omlx` | 3aa3cd3 | local, all 5 stacked for live testing |

## What's on the forks (MLX)

| Branch | SHA | Status |
|---|---|---|
| `fix/exception-safe-completion-handler` | 8c514a1a + 982ef62d | pushed (v3 + back-pressure) |
| `feat/stream-tag-field` | 20221bc8 | local (B.1) |
| `feat/per-stream-residency-set` | 127905b8 | local (B.3) |
| `feat/stream-generation-counter` | 996f6dd6 | local (A.1, promoted this session) |
| `validate/all-mlx` | — | local combined |

## Mac-mini operational state

- Compiled bun single-file agent binary at `/Users/aimastermind/.local/bin/llamactl-agent` (built via `tools/install-agent-macos.sh`, commit `d1eefff`). Adhoc-signed with proper identifier.
- Persistent agent runs via Login Item: `/Users/aimastermind/.llamactl-agent/start-agent.sh` (self-detaching, single-instance guard, full env exec). Registered via `REGISTER-LOGIN-ITEM.sh` on the mac-mini Terminal locally.
- Launchd plist `com.llamactl.agent` is **disabled** to prevent it from competing on reboot (`launchctl bootout` + `launchctl disable`).
- Three iso ModelHosts up + serving expected model_ids:
  - 8194 → `granite-4.1-3b-4bit`
  - 8195 → `granite-4.1-8b-nvfp4`
  - 8196 → `Qwen3-8B-MLX-4bit`
- New: `com.llamactl.memory-cleanup` LaunchAgent runs every 15 min, kills macOS background daemons (mediaanalysis, photoanalysis, photolibrary, siri*, spotlight*, sirittsd, TextThumbnailExtension, iconservicesagent) when free pages < 130000 (~2 GB). Logs at `~/.llamactl-launchd-logs/memory-cleanup.log`. Commit `8e20729`.

## Open follow-ups for next session

1. **Wire production routing for 35B-A3B**: send memory-recall + task-refiner-rubric requests to local `:8096` (gains-host-35b-local). Currently the bench routes correctly; the production gateway / agentchat.yaml hasn't been updated.
2. **Open the upstream PRs**: 5 oMLX + 3-4 MLX patches PR-ready in `docs/upstream-patches/`. User said "ignore PRs for now" earlier this week — re-confirm before opening.
3. **MLX-1 + MLX-4 (encoder tracking bounds)**: shelved as speculative. MLX-1 had a safety concern (dropping entries could miss `waitForFence`). Profile under load if symptoms appear.
4. **Land the validate/all-omlx prefix-knobs commit on origin**: the new oMLX patches are local-only; nothing's been pushed to `frozename/omlx`.
5. **Bench dflash on a true long-gen workload**: our memory-recall and task-refiner-rubric corpora don't exercise the long-gen regime dflash was designed for. If we find one, retest.

## Memory entries to read

- `project_gains_2026-05-21` — 35B-A3B routing win + dflash shelved + mcr=4 ceiling on M4 base
- `project_upstream_patches_2026-05-21` — full state of MLX/oMLX patch set
- `project_mac_mini_iso_spawn_regression_2026-05-21` — full diagnostic chain for the TCC-blocked launchd spawn → Login Item fix

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `ssh macmini.ai 'pgrep -af llamactl-agent; lsof -iTCP -P -sTCP:LISTEN 2>/dev/null | grep -E ":(7843|819[456])"'` — confirm mac-mini agent + 3 iso procs alive (auto-spawned by Login Item on boot)
4. `ssh macmini.ai 'tail -20 ~/.llamactl-launchd-logs/memory-cleanup.log'` — verify cleanup LaunchAgent has been firing every 15 min
5. Pick a direction from open work above.
