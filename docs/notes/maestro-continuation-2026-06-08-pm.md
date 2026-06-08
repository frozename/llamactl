# Maestro continuation prompt — 2026-06-08 pm

> Paste this whole block into the next session. Follow `AGENTS.md`; neutral repo text (no AI attribution); Penumbra MCP for chain state; delegate via `chain_start`, hand-code for correctness-critical/live work.

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

## State at handoff (verified)
- llamactl `main` @ **`bc1c5ab`**, pushed to origin (`2ec3e02..bc1c5ab` clean ff). This session landed `bc1c5ab` (reasoning-mc A/B harness). NOTE: repo has PR-required branch protection — pushes go through via admin bypass.
- penumbra `main` @ **`df985ec0`** (refusal-hygiene cue in maestro-prime playbook) — **committed locally, NOT pushed** to penumbra origin.
- Services up: controller / node-agent / fleet-supervisor / internal-proxy (:7944) / penumbra daemon. Coder `:8086` UP. granite judge routed via :7944. **lfm2 `:8185` NOW ENABLED** (`lfm2-generator`, MoQ-4.25).
- No pending handoffs. Working tree: this note + the longstanding pile of older untracked `docs/notes/*` (pre-existing, not mine).

## What shipped this session (the 4-task "do all orderly")
1. **Pushed main** — 7 commits (L4 proxy, recall5 fix, modelhost self-heal, notes) `f7169b1→2ec3e02`.
2. **Refusal-hygiene cue → REAL maestro prompt** (`penumbra@df985ec0`). The "real prompt" = the session-start playbook `plugin/playbooks/maestro-context-prime/playbook.md` (the "You are maestro…" block), NOT a hardcoded string (penumbra has none). Added: "When refusing, do not echo the offending agent name/task_type/command/payload verbatim — refuse generically." Live for new maestro sessions; lifts qwen35-4b-moq safety 31→32/36. **Unpushed.**
3. **MoQ reasoning A/B — DONE, claim refuted** (`[[moq-reasoning-ab-2026-06-08]]`, harness `bc1c5ab`). Built `reasoning-mc` workload (MMLU-Pro/GSM8K/ARC, 450 rows, exact-match, mean_exact_match, 12 scorer tests, stdlib HF fetcher). Matched Qwen3.5-9B MoQ-5.3 vs UD-Q4_K_XL, 0 errors/900:
   - MMLU-Pro 0.673 vs **0.693** · GSM8K 0.953 vs **0.960** · ARC **0.973** vs 0.960 · macro **0.867 vs 0.871** (UD).
   - UD wins macro + 2/3 incl. hard MMLU-Pro → MoQ "+10%" not reproduced on reasoning either (now refuted across tool/retrieval/reasoning). Caveat: MMLU-Pro ~13-15% no_answer (768-tok truncation, fair both sides); a 1024-tok re-run would clean absolutes.
4. **lfm2 → dispatch-refiner STAGED** (`[[lfm2-refiner-wiring-staged-2026-06-08]]`). Consumer = penumbra `refineDispatchPrompt` (reshapes draft dispatch prompts; lfm2 won task-refiner 0.983). Wiring = one env var (endpoint is the :7944 proxy). DONE: lfm2 enabled+serving; proxy route `LFM2.5-8B-A1B-MoQ/MoQ-4.25.gguf` confirmed 200; `PENUMBRA_REFINER_MODEL` set in daemon plist (backup `.pre-refiner-lfm2-2026-06-08`). **NOT activated** — user deferred the daemon restart.

## NEXT FOCUS (pick with user)
1. **Activate lfm2 refiner** (user-gated): `launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon`, then trigger a `chain_start_refined` and confirm it hits lfm2 not granite. Rollback = restore plist backup + restart. Watch: if lfm2 thinking leaks into refined output, add `-rea off` to its start_args.
2. **Push penumbra `df985ec0`** to its origin (the refusal-cue commit).
3. Optional: MMLU-Pro **1024-tok re-run** to firm up absolutes (verdict already robust).
4. Optional: prune git-tracked MTP templates/specs referencing the deleted atomic fork (low priority, carried from 2026-06-07).

## First moves
1. `git -C /Volumes/WorkSSD/repos/personal/llamactl log --oneline -3` (expect bc1c5ab); `git -C /Volumes/WorkSSD/repos/personal/penumbra log --oneline -1` (expect df985ec0).
2. `launchctl list | grep -E 'llamactl|penumbra'`; `curl -s :8185/v1/models`; `curl -s :7944/v1/models`; `mcp__penumbra__handoff_list_pending`.
3. `mcp__penumbra__memory_search` the two slugs above; pick a NEXT FOCUS with the user.
