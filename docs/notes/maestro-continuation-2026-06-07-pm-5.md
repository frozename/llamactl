# Maestro continuation prompt — 2026-06-07 pm (part 5)

> Paste this whole block into the next session. Supersedes -pm-4 (adds the 4B-safety, lfm2-workload, and atomic-fork-retirement threads). Follow `AGENTS.md`; neutral repo text (no AI attribution); Penumbra MCP for chain state; delegate via `chain_start`, hand-code for correctness-critical/live-debug work.

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

## State at handoff (verified)
- llamactl `main` @ **`4fdba90`** — 2 commits landed this session: `e47f82d` (eval: recall5 metric + lenient parser + MoQ specs + repoint specs) and `4fdba90` (session notes). NOT pushed (origin behind at f7169b1).
- **Mainline llama.cpp @ `f0156d140` (v9550)** is the SOLE/canonical llama.cpp (`/Volumes/WorkSSD/src/llama.cpp`, 1.5G). Has native `qwen35` + `lfm2moe` + upstreamed Gemma4-MTP (#23398) + unified `--spec-type draft-mtp`. `llama-server`/`llama-bench`/`llama-mtmd-cli` rebuilt at v9550.
- **Atomic forks DELETED** (`llama.cpp-atomic` + `-atomic-qwen`, 1.5G reclaimed). Recoverable via re-clone from `frozename/atomic-llama-cpp-turboquant` (recipe: `tools/llama-cpp-mtp-atomic/`). See `[[atomic-fork-retired-2026-06-07]]`.
- Services up: controller / node-agent / fleet-supervisor / internal-proxy / penumbra daemon. **Coder 80B `:8086` UP**, granite judge `:8083` UP. New disabled workload `lfm2-8b-a1b-generator-local` (`:8185`, mainline binary).
- No pending handoffs. Working tree clean (only old untracked notes from prior sessions remain).

## What shipped this session (8 t2 memories)
**MoQ eval** (`[[moq-sweep-2026-06-07]]` `[[moq-rolefit-2026-06-07]]` `[[moq-vs-ud-ab-2026-06-07]]`): benched 4 MoQ GGUFs (Qwen3.5-4B/9B, Qwopus-Coder-MTP, LFM2.5-8B-A1B) at /Volumes/WorkSSD/ai-models/llama.cpp/models/. Findings: qwen35-4b-moq best tool-call (0.96 > gemma 0.86); lfm2 best+fastest generator (0.983 @ 113tps); gemma still recall king (recall5 0.94, but WORST writer). **MoQ "+10% over UD" REFUTED** — at matched BPW, Unsloth-Dynamic beats MoQ ~5%. Skill split: retrieval≠generation, pick by ROLE.
**Forks/MTP** (`[[mainline-ge-atomic-retire-fork-2026-06-07]]` `[[mtp-net-negative-m4pro-2026-06-07]]`): mainline ≥ atomic on every prod dim (turbo3 inert on standard quants; SWA-TTFT + Gemma4-MTP upstreamed) → fork retired. MTP net-negative on M4 Pro (−6% to −26%).
**4B safety** (`[[qwen35-4b-safety-echo-2026-06-07]]`): the maestro-bench "safety 2/4" is echo-on-refusal (model IS safe — refuses + dispatches nothing); a no-echo MAESTRO_SYSTEM cue lifts 31→32/36 (reverted from bench; belongs in the REAL penumbra maestro prompt).
**Eval infra**: recall5 (order-insensitive) + fallback parser landed (`e47f82d`); 3 specs repointed atomic→mainline; lfm2 fast-generator workload created+validated (disabled).

## NEXT FOCUS (pick with user)
1. **Port the no-echo safety cue to the REAL penumbra maestro prompt** (not the bench) — turns qwen35-4b-moq into a deployable fast TRIVIAL/STANDARD-tier tool-caller (0.96 tool-call @ 45tps).
2. **lfm2 fast-generator**: find a real consumer (bulk/draft generation); `llamactl enable lfm2-8b-a1b-generator-local` when RAM allows (single heavy workload per node — evict coder first).
3. **MoQ reasoning-suite A/B**: MoQ's claim is on LiveCodeBench/MMLU-Pro/Math/GPQA — bench those to see if MoQ wins where its per-layer bits are tuned (our refutation is scoped to tool/retrieval).
4. **Push `main` to origin** (2 commits ahead + the prior L4 work; origin at f7169b1).
5. Optional: prune the git-tracked MTP templates/specs that now reference the deleted fork (kept as resurrection path — low priority).

## First moves
1. `git -C /Volumes/WorkSSD/repos/personal/llamactl log --oneline -3` (expect 4fdba90); `git -C /Volumes/WorkSSD/src/llama.cpp rev-parse --short HEAD` (f0156d140).
2. `launchctl list | grep -E 'llamactl|penumbra'`; `curl -s :8086/v1/models`; `mcp__penumbra__handoff_list_pending`.
3. `mcp__penumbra__memory_search` the slugs above; pick a NEXT FOCUS with the user.
