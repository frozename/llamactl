# Maestro continuation prompt — 2026-06-07 pm (part 4)

> Supersedes -pm-3. Adds the "do-all" follow-up: recall-scorer fix, MoQ-vs-UD A/B, 4B maestro bench, generative bench, spec migration. Follow `AGENTS.md`; neutral repo text; Penumbra MCP for state.

## State at handoff (verified)
- llamactl `main` @ `9452398` (no code commits landed; eval scorer changes + specs are UNCOMMITTED in working tree — see below). Mainline llama.cpp @ `f0156d140` (v9550). Coder 80B `mlx-qwen3-coder-next-local` **re-enabled** (:8086 up). granite judge :8083 up.
- **Uncommitted working-tree changes** (decide whether to commit): `packages/eval/src/matrix/workloads/memory-recall.ts` + `runner.ts` (recall5 + fallback parser); 3 specs repointed atomic→mainline (`gemma4-26ba4b-qat-cmp-2026-06-06.json`, `gemma4-e4b.json`, `fleet-fill-2026-05-18.json`); new specs `moq-sweep`, `moq-recall-ab`, `moq-vs-ud-matched`; result DBs.

## Findings (6 t2 memories total)
**Forks** `[[mainline-ge-atomic-retire-fork-2026-06-07]]`: mainline ≥ atomic on every production dim → retire atomic fork. **MTP** `[[mtp-net-negative-m4pro-2026-06-07]]`: net-negative on M4 Pro.
**MoQ sweep** `[[moq-sweep-2026-06-07]]` + **role-fit** `[[moq-rolefit-2026-06-07]]` + **A/B** `[[moq-vs-ud-ab-2026-06-07]]`:
- tool-call: qwen35-4b-moq **0.96** (beats gemma 0.86); recall5: gemma **0.941** dominates (no MoQ close); generative: lfm2 **0.983 @ 113tps** wins, gemma LAST (0.905).
- **MoQ-vs-UD matched BPW: UD beats MoQ ~5% on both tool-call + recall → "+10% over UD" claim REFUTED on our eval** (caveat: author benches reasoning suites, not tool/retrieval).
- maestro bench: qwen35-4b-moq **31/36 (86%)** vs gemma 34/36; weak safety 2/4.
- SKILL SPLIT: retrieval≠generation. gemma=recall king/worst writer; lfm2=best writer/worst recall; 4b=best tool-call/worst recall. Pick by ROLE.
- recall-scorer fixed: added order-insensitive recall5 + ID-appearance fallback (salvaged coder 0.0→0.495, lfm2 0.0→0.36).

## NEXT FOCUS
1. **Decide: commit the eval changes?** (recall5 scorer + repointed specs are genuinely useful; the new MoQ specs/DBs are session artifacts — maybe .gitignore the DBs).
2. **qwen35-4b-moq as fast tool-caller** — wire structured safety cues (raise safety 2/4) then re-bench; could be a TRIVIAL/STANDARD-tier router.
3. **lfm2.5-8b-a1b as a fast bulk generator** workload (0.983 briefs @ 113 tps) — needs mainline binary (lfm2moe).
4. **Retire atomic fork**: repoint/translate the 5 remaining local MTP specs OR mark deprecated; remove `/Volumes/WorkSSD/src/llama.cpp-atomic*` once nothing references it.
5. MoQ gated repo `w-ahmad/Qwen3.5-9B-GGUF-MoQ` (note the `-MoQ` suffix) needs hf auth; have MoQ-4.3/5.3.

## First moves
1. `git -C /Volumes/WorkSSD/repos/personal/llamactl status --short`; `git -C /Volumes/WorkSSD/src/llama.cpp log --oneline -1` (f0156d140).
2. `launchctl list | grep -E 'llamactl|penumbra'`; `curl -s :8086/v1/models`; `mcp__penumbra__handoff_list_pending`.
3. Decide on committing the eval changes + pick a NEXT FOCUS with the user.
