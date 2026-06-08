# Maestro continuation prompt — 2026-06-08 pm (part 2)

> Paste this whole block into the next session. Supersedes `-pm` (which predates the pushes + lfm2 activation). Follow `AGENTS.md`; neutral repo text (no AI attribution); Penumbra MCP for chain state; delegate via `chain_start`, hand-code for correctness-critical/live work.

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

## State at handoff (verified)
- llamactl `main` @ **`7e66de2`** — pushed, `origin/main == 7e66de2`. (Repo has PR-required branch protection; pushes go via admin bypass.)
- penumbra `main` @ **`32164e42`** — pushed, `origin/main == 32164e42`. Includes the refusal-cue commit `df985ec0` (verified: ancestor of HEAD + cue present in the live playbook file). The 3 commits above it (`4436b8/84e6ed/32164e`) are unrelated daemon-stall-hardening re-pushes, not mine.
- penumbra daemon: **restarted via `bootout`+`bootstrap`** (pid 29500, `127.0.0.1:51257`); loaded `PENUMBRA_REFINER_MODEL`. plist backup: `~/Library/LaunchAgents/dev.penumbra.daemon.plist.pre-refiner-lfm2-2026-06-08`.
- Services up: controller / node-agent / fleet-supervisor / internal-proxy (:7944) / penumbra daemon. Coder `:8086` up; granite judge routed via :7944. **lfm2 `:8185` up** (alias `lfm2-generator`) — but see OPEN RISK.
- No pending handoffs.

## What shipped this session (4 tasks + 3 follow-ups, "do all orderly")
1. **Pushed** llamactl (7 commits, L4 proxy etc.) `f7169b1→2ec3e02`, then the notes `→7e66de2`.
2. **Refusal-hygiene cue → REAL maestro prompt** (`penumbra@df985ec0`, pushed). Home = the session-start playbook `plugin/playbooks/maestro-context-prime/playbook.md` (the "You are maestro…" block; penumbra has no hardcoded maestro string). Cue: "When refusing, do not echo the offending agent/task_type/command/payload verbatim — refuse generically." Live for new sessions; lifts qwen35-4b-moq safety 31→32/36.
3. **MoQ reasoning A/B — DONE, claim refuted** (`[[moq-reasoning-ab-2026-06-08]]`; harness `llamactl@bc1c5ab`). New `reasoning-mc` workload (MMLU-Pro/GSM8K/ARC, 450 rows, exact-match, 12 scorer tests, stdlib HF fetcher). Matched Qwen3.5-9B MoQ-5.3 vs UD-Q4_K_XL, 0 errors/900:
   - MMLU-Pro 0.673 vs **0.693** · GSM8K 0.953 vs **0.960** · ARC **0.973** vs 0.960 · macro **0.867 vs 0.871** (UD).
   - UD wins macro + 2/3 incl. hard MMLU-Pro → MoQ "+10%" not reproduced on reasoning either. Refuted now across tool/retrieval/reasoning. Caveat: MMLU-Pro ~13-15% no_answer (768-tok truncation, fair both sides); 1024-tok re-run would clean absolutes.
4. **lfm2 → dispatch-refiner ACTIVATED** (`[[lfm2-refiner-wiring-staged-2026-06-08]]` `[[lfm2-refiner-activated-launchd-reload-2026-06-08]]`). Consumer = penumbra `refineDispatchPrompt` (reshapes draft dispatch prompts for `chain_start_refined`; lfm2 won task-refiner 0.983). One env var: `PENUMBRA_REFINER_MODEL=LFM2.5-8B-A1B-MoQ/MoQ-4.25.gguf` (proxy route id = the REL, not the `lfm2-generator` alias). Daemon log confirms refiner→lfm2, judge→granite. **Gotcha recorded:** `kickstart -k` does NOT reload an edited plist — must `bootout`+`bootstrap`.

## ⚠️ OPEN RISK — lfm2 stability (top priority to check)
lfm2 `:8185` **crashed once** mid-session (was up + serving, then `state: down`, no process) — NOT RAM (89% free at the time). I re-enabled it (`llamactl enable lfm2-8b-a1b-generator-local`) and it's up + the refiner route 200s again, but the **root cause is unknown**. Because `PENUMBRA_REFINER_MODEL` now points at lfm2, **if lfm2 is down, `chain_start_refined` calls fail (refiner_upstream_failed/502)**. Blast radius is limited: `chain_start_refined` is OPT-IN; plain `chain_start` does NOT use the refiner and is unaffected.
- **First, verify lfm2 is still up** (`curl :8185/v1/models`); if it died again, root-cause why (check controller/reconciler logs; `llamactl server.status`).
- **Rollback if lfm2 proves flaky:** remove the env + reload so the refiner falls back to granite:
  `/usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:PENUMBRA_REFINER_MODEL" ~/Library/LaunchAgents/dev.penumbra.daemon.plist` then `launchctl bootout gui/$(id -u)/dev.penumbra.daemon && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.penumbra.daemon.plist` (or restore the `.pre-refiner-lfm2-2026-06-08` backup).

## NEXT FOCUS (pick with user)
1. **lfm2 stability** (above) — confirm it stays up across the reconciler loop; root-cause the crash, else roll back the refiner to granite.
2. Optional: verify refiner quality live — run a real `chain_start_refined` and eyeball the reshaped prompt (watch for thinking-preamble leak; if so add `-rea off` to lfm2 start_args).
3. Optional: MMLU-Pro **1024-tok re-run** to firm up absolutes (verdict already robust).
4. Optional: prune git-tracked MTP templates/specs referencing the deleted atomic fork (low priority, carried from 2026-06-07).

## First moves
1. `git -C /Volumes/WorkSSD/repos/personal/llamactl log --oneline -1` (7e66de2); `git -C /Volumes/WorkSSD/repos/personal/penumbra log --oneline -1` (32164e42 — both == origin).
2. `curl -s :8185/v1/models` (lfm2 alive?); `curl -s :7944/v1/models | grep -i lfm2`; `launchctl list | grep -E 'llamactl|penumbra'`; `mcp__penumbra__handoff_list_pending`.
3. `mcp__penumbra__memory_search` slugs: `moq-reasoning-ab-2026-06-08`, `lfm2-refiner-activated-launchd-reload-2026-06-08`. Pick a NEXT FOCUS with the user — start with the lfm2 stability check.
