# Maestro continuation prompt — 2026-06-07 pm (part 3)

> Supersedes -pm-2. Session focus: MoQ eval + llama.cpp fork unification (mainline vs atomic). Follow `AGENTS.md`; neutral repo text; Penumbra MCP for state; delegate via `chain_start`.

## State at handoff (verified)
- llamactl `main` @ `9452398` (unchanged — no code commits this session; eval specs/results are untracked artifacts). NOT pushed.
- **Mainline llama.cpp rebuilt: `/Volumes/WorkSSD/src/llama.cpp` @ `f0156d140` (v9550)** — fast-forwarded +780 commits, `cmake --build` with Metal. Now has native `qwen35` (Qwen3.5 GDN+MoE+VL) + `lfm2moe` + upstreamed Gemma4 MTP (#23398) + unified `--spec-type draft-mtp`. `llama-server`/`llama-bench`/`llama-mtmd-cli` rebuilt at v9550.
- Coder 80B (`mlx-qwen3-coder-next-local`) **disabled for clean benching, then RE-ENABLED** — serving :8086 again. granite judge :8083 up.
- 4 MoQ GGUFs downloaded to `/Volumes/WorkSSD/ai-models/llama.cpp/models/`: Qwen3.5-4B-MoQ, Qwen3.5-9B-MoQ (+mmproj), Qwopus3.5-9B-Coder-MTP-MoQ, LFM2.5-8B-A1B-MoQ (~4.2-4.5 BPW each).

## Findings (3 t2 memories written)
1. **MoQ sweep** `[[moq-sweep-2026-06-07]]`: **qwen35-4b-moq-4.25 = 0.96 tool-call-grammar, BEATS gemma qat-mxfp4 (0.86) at 1/6 params.** lfm2.5-8b-a1b = 109 tps (A1B). memory-recall ndcg ≈0 is a SCORING CONFOUND (lfm2 parse_error; qwen35-9b retrieves correct set, wrong order) — NOT a capability gap. spec: `packages/eval/specs/moq-sweep-2026-06-07.json`, db `packages/eval/results/moq-cmp.db`.
2. **MTP net-negative on M4 Pro** `[[mtp-net-negative-m4pro-2026-06-07]]`: Coder mainline plain 41.5 tps; `draft-mtp` 30.7 (−26%, 68% accept); atomic `nextn` 36.9 (−6%, 78%). MTP loses on M4 Pro even at high accept. Plain wins.
3. **mainline ≥ atomic — retire fork** `[[mainline-ge-atomic-retire-fork-2026-06-07]]`: Gemma tg128 52.75 (main) vs 52.51 (atomic) = parity; SWA cache-reuse TTFT 65ms = identical (mainline upstreamed it); turbo3 inert on standard quants. **Nothing to forward-port; standardize on mainline; retire atomic fork** (keep only for future TurboQuant-FORMAT eval).

## NEXT FOCUS (open threads)
1. **Fix memory-recall scoring** (set-overlap metric, not order-sensitive ndcg) then re-judge MoQ — the 0.0s are artifacts. Then **MoQ-vs-UD A/B** (matched-BPW UD quant of same base) to verify the "+10% over Unsloth-Dynamic" method claim on our eval.
2. **qwen35-4b-moq as a fast tool-call / maestro candidate** — 0.96 @ 43 tps is compelling; bench on the maestro bench (tools/maestro-bench/bench-maestro.py) vs the gemma qat-mxfp4 incumbent.
3. **Standardize on mainline binary** across workloads/specs that point at the atomic fork; decide whether to keep atomic-qwen / build-shared-cache trees.
4. Generative-quality dimension: run project-brief-gen (granite judge :8083) on the MoQ set for a non-structured signal.

## First moves
1. `git -C /Volumes/WorkSSD/repos/personal/llamactl status --short && git -C /Volumes/WorkSSD/src/llama.cpp log --oneline -1` (expect f0156d140).
2. `launchctl list | grep -E 'llamactl|penumbra'`; `curl -s :8086/v1/models`; `mcp__penumbra__handoff_list_pending`.
3. Pick a NEXT FOCUS thread with the user.
