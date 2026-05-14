# Maestro continuation — 2026-05-14 am

> Paste this into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

`AGENTS.md` is the source of truth. Use Penumbra MCP for chain state (`handoff_list_pending`, `chain_status`, `chain_wait`); do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral — no AI/tool attribution. Delegate substantive code via `chain_start`; hand-code only when the worker/daemon won't boot **or when the user explicitly says "do it by hand"** (which they did this session for the entire memory-efficacy bench harness work — see notes below).

## What this session shipped

This session ran two threads end-to-end: **(A) Gemma 4 E4B re-eval** and **(B) Granite mac-mini tuning + memory-efficacy bench**. Plus a side investigation into Granite-specific llama.cpp opportunities triggered by user pushback. 12 commits, all on `main`, none pushed to origin yet (14 commits ahead of `origin/main` total including the prior session's `c25ce40` and `96bde03`).

### A. Gemma 4 E4B re-eval

- **`0c748c6 docs(bench): record gemma e4b re-eval`** — Partial work from a dispatched `claude-acp-sonnet` worker. They MTP-benched E4B and committed Phase 1 result (22/36 pass) but couldn't bring up a vanilla control server. **Superseded by `ab76b20`**.
- **`ab76b20 bench(e4b): vanilla 35/36 vs MTP 22/36 — add e4b-vanilla workload`** — Hand-implemented. Reproduced the worker's failed vanilla control on the same atomic-fork binary with standard args (no `--mtp-head`, no `--spec-type`). It works fine — the worker's failure was specific to their arg shape, not infra. Found vanilla E4B = 35/36 (0.972) at 44 tps, MTP E4B = 22/36 (0.611) — MTP catastrophically degrades E4B on planning/edge/memory/handoff_mgmt/workflow_plan (all 0/N vs 100% vanilla). Added `templates/workloads/gemma4-e4b-vanilla-local.yaml` at port 8182, `spec.enabled=false`. **E4B vanilla is 26B-grade quality at 1/3 the RAM.**
- **`5867c4b bench(e4b): append mac-mini sweep — ub 256 composite 0.767 (stable)`** — Ran `tools/eval/tune-gemma-e4b.sh` (existing script). Mac-mini agentic-eval composite stayed at 0.767 (vs 0.766 prior — within noise). Production :8090 not restarted because it currently hosts Granite (the task-#2 subject).

**Two dispatches in this thread, both `claude-acp-sonnet`:**
1. First (`22d2e967`) stopped pre-flight with a partially-correct premise objection — they correctly flagged that the 2026-05-08 E4B baseline was on mac-mini not M4 Pro, but they were wrong that the fused `-mtp.gguf` doesn't exist locally (they searched only `/Volumes/WorkSSD/ai-models/`, missing `~/.llamactl/ai-models/` which is a separate store). Cost ~$0.89; useful — saved us hours of running the wrong workload.
2. Second (`dd2e30a6`) ran a nested sub-dispatch to `codex-acp-fast` for the actual bench work; that completed Phase 1 (committing `0c748c6`) but the maestro stalled with `stdio-acp: no wire activity for 300000ms` waiting for the result. We canceled the stuck parent and finished by hand.

### B. Granite mac-mini tuning + memory-efficacy bench

This was the bigger thread. Hand-implemented entirely after the user said "do it by hand" on the third dispatch attempt (one earlier `claude-acp-sonnet` dispatch returned only "Model set to `claude-opus-4-7[1m]`. Ready when you are." — wire-level handshake confusion).

- **`5ac8992 bench(memory-efficacy): corpus + gold labels + harness scaffolding`** — Built `tools/memory-efficacy-bench/` from scratch. Extracted 481 findings from 44 of 49 review syntheses at `penumbra/.penumbra/reviews/`. Critical side discovery: **penumbra's `parseFindings` regex doesn't match the real synthesis format** — it expects `[High] Title` but reality is `**High — Title**`. The production memory-efficacy classifier has **0 jobs and 0 cache rows ever** in `~/.penumbra/db.sqlite`. Gold-labeled 470 findings via `codex-acp-spark` chain_start (Claude Opus 4.7 routing). **Class distribution is 97% `not_memory_related`** — bench accuracy is a misleading primary metric; per-bucket F1 is the signal.
- **`771ecb8 bench(memory-efficacy): granite mac-mini baseline + sweep driver`** — Baseline of current production config (Granite 4.1 8B Q4_K_M on mac-mini :8090, `-ub 512 -np 2 -ctk q8_0 -ctv q8_0`). Got 94.8% accuracy, 40% F1 on recall_miss and memory_ignored, 0% on missed_registration. **33% drop rate** — Granite 8B silently truncates batches mid-array. Authored `tools/memory-efficacy-bench/sweep.sh` to vary 8 configs on mac-mini :18190 over ssh.
- **`b162cbd bench(granite): raw llama-bench speed sweep on M4 Pro`** — `llama-bench` ub × KV-quant matrix. Clean winners: ub=256 q8/q8 → 40 tps decode; ub=2048 q8/q8 → balanced. Documented that **mac-mini's vanilla llama.cpp has all the upstream Granite/Mamba/GDN work**; atomic fork has no Granite-specific gap.
- **`9082548 bench(granite): dynamic lookup cache A/B — +15% throughput, -45% p95`** — On M4 Pro with `-np 1`, `--lookup-cache-dynamic` gave +15% throughput and nearly halved p95 batch latency on repeatable JSON output. **Did NOT generalize to mac-mini under `-np 2`** (see `e6f23a0`).
- **`0afa156 bench(granite): 3B vs 8B at Q4/Q5/Q6/Q8 — architecture matters more than quant`** — Downloaded 3B Q5/Q6/Q8 + 8B Q5/Q6/Q8 quants from Unsloth. Full bench on M4 Pro. Headline: **3B is blind to recall_miss at every quant (0% F1)** while 8B catches 40%. **8B higher quants HURT** — Q8 has 64% drop rate (vs Q4's 32%) because precision increases response verbosity past the token budget.
- **`e6f23a0 bench(granite): mac-mini 8-config sweep + lookup-dynamic A/B + writeup`** — Full mac-mini sweep. 7 of 8 configs are bit-identical at temperature=0. Only `kvf16` produced different output (-6% wall, +4pp RM F1, +5pp drop rate — lateral). Plus lookup-dynamic A/B on mac-mini: bit-identical to baseline. Main writeup at `docs/notes/session-summary-2026-05-13-pm-granite-tuning.md`.
- **`e1781f3 docs(handoffs): penumbra memory-efficacy — parser fix + verbosity guard`** — Initial handoff to penumbra team covering the parser bug + 33% drop rate. Updated later by `12ef6d3` to add the parallel-batch finding.
- **`12ef6d3 bench(memory-efficacy): parallel-batch dispatch — +34% throughput`** — User pushed back on "nothing more to do for mac-mini" framing. Investigation revealed the bench harness is **sequential** while mac-mini Granite has `-np 2`. Added `--concurrency` flag to `run-bench.ts`. Wall went **1091s → 816s (-25%), throughput +34%, zero quality cost**. Output bit-identical (309 preds both, 94.8% acc both). **This is the real ship-now win** — penumbra's `buildMemoryEfficacyCache` (`packages/core/src/readers/memory-efficacy.ts:222`) walks batches sequentially; wrapping in `Promise.all(N=2)` is a ~10-line change. Handoff updated with diff sketch.
- **`680e340 bench(granite): UD-Q4_K_XL regresses memory_ignored F1 (40% → 0%)`** — Final optimization test. UD-Q4_K_XL OOM'd at production shape on mac-mini's 12 GB Metal budget; retried at ctx=8192 np=1. Even with the more-permissive config, memory_ignored F1 dropped 40% → 0%. UD's per-tensor precision schedule helps with output bulk (28% drops vs 33%) but trades away rare-class signal. Not worth deploying.

## Live state

- **Daemon**: `dev.penumbra.daemon` PID 15247, `dev.penumbra.worker` PID 95152 (per launchctl).
- **Running llama-servers**:
  - M4 Pro `:8181` — Gemma 4 26B-A4B + MTP, PID 31185, atomic-fork binary, 65k ctx, `-np 1` (production maestro). Running since 2026-05-13T19:39:07Z.
  - mac-mini `:8090` — Granite 4.1 8B Q4_K_M, vanilla llama.cpp, `--ctx-size 32768 -np 2 -ctk q8_0 -ctv q8_0 -b 2048 -ub 512` (penumbra's `local` memory-refinement agent). Untouched throughout session.
- **Down**: M4 Pro `:8083` — `granite41-8b-long-lived-local` workload reports `Running` PID 20376 but the process is dead and the port is closed. Reconciler should restart per `restartPolicy: Always` but isn't. **This is a real llamactl bug worth filing.**
- **SSH tunnels**: `ssh -fN -L 18090:127.0.0.1:8090 macmini.ai` PID 19736 still alive — tunnel into mac-mini :8090 from M4 Pro :18090. Safe to leave or kill.
- **Git**: 14 commits ahead of `origin/main`. Nothing pushed. One uncommitted file: `docs/notes/session-summary-2026-05-13-pm.md` (modified at session start from a prior session, not by me — leave it for the previous session's author).
- **New downloads on disk** (gitignored — ~20 GB):
  - `/Volumes/WorkSSD/ai-models/llama.cpp/models/gemma-4-E4B-it-assistant-GGUF/gemma-4-E4B-it-assistant.Q4_K_M.gguf` (79 MB)
  - `granite-4.1-3b-GGUF/granite-4.1-3b-{Q5_K_M,Q6_K,Q8_0}.gguf`
  - `granite-4.1-8b-GGUF/granite-4.1-8b-{Q5_K_M,Q6_K,Q8_0}.gguf`
  - `mac-mini:/Volumes/AI-MODELS/llama.cpp/models/granite-4.1-8b-GGUF/granite-4.1-8b-UD-Q4_K_XL.gguf` (5.1 GB)

## Open follow-ups

Ordered by value × actionability:

1. **Penumbra: parallel-batch dispatch in `buildMemoryEfficacyCache`** — +34% throughput, ~10-line `Promise.all` change. Handoff at `docs/superpowers/handoffs/2026-05-13-penumbra-memory-efficacy-handoff.md` section 3 has the diff sketch. **Blocking dependency: also fix the parser (next item) — model tuning is moot if the pipeline never runs.**
2. **Penumbra: fix `parseFindings` regex** — `packages/core/src/readers/memory-efficacy.ts:103-140`. Should accept `**High — Title**` (em dash inside bold) and `**High** — Title` formats, not just `[High] Title`. Mirror logic in `tools/memory-efficacy-bench/extract-corpus.ts` if useful. Currently extracts 0 of 49 syntheses; with the fix it'll get ~44/49.
3. **Penumbra: reduce classifier batch size 10 → 5** in `classifyFindings` (`memory-efficacy-classifier.ts:56`) OR tighten `reason: <short>` prompt OR raise siriusChat max_tokens. Granite 8B silently drops ~33% of batch entries.
4. **Llamactl bug: stale `granite41-8b-long-lived-local` workload PID** — Reconciler not restarting. Workload reports Running PID 20376 but process is dead, :8083 closed. File against `packages/remote` reconciler. Needs root-cause.
5. **llama.cpp code investigation (open question)**: Why does `-lcd` give +15% throughput on M4 Pro `-np 1` but 0% on mac-mini `-np 2`? Reading `tools/llama-server/server.cpp` slot scheduling against `common/ngram-cache.cpp` would tell us if there's a fixable scheduler ordering bug. If so, mac-mini gets the same +15% on top of the +34% parallel-batch win.
6. **Untested code-level lever**: `--grammar` or `-j schema.json` sampling-constrained output for the classifier. Would eliminate JSON parse failures AND batch truncation (model can't truncate mid-array if grammar forbids it). Quick feature test; would require a grammar file for the 4-bucket schema. Risk: forcing schema compliance may suppress useful reasoning.
7. **Push the 14 commits to origin/main** when you're ready. Coordinate with whoever owns the prior-session uncommitted `docs/notes/session-summary-2026-05-13-pm.md` mod.

## Memories worth reading

These are in `~/.claude/projects/-Volumes-WorkSSD-repos-personal-llamactl/memory/`:

- `project_granite_efficacy_bench_2026-05-13.md` — full picture of this session's Granite findings + parallel-batch win
- `project_e4b_reval_2026-05-13.md` — E4B vanilla vs MTP regression
- `feedback_maestro_prompt_form.md` — v2 compacted prompt convention used in maestro-bench
- `reference_swa_full_cache_reuse_fix.md` — atomic fork SWA fix (corrected in this session: lives at `/Volumes/WorkSSD/src/llama.cpp-atomic`, not the GitHub repo name)
- `reference_llamacpp_mtp_binaries.md` — which build for which model
- `reference_penumbra_dispatch_routing.md` — `use_worktree: false` + explicit cd from llamactl dispatches

## First moves

```
1. git status --short && launchctl list | grep penumbra && git log --oneline origin/main..HEAD
2. mcp__penumbra__handoff_list_pending   # confirm clean
3. curl -fsS http://127.0.0.1:8181/health && ssh macmini.ai 'curl -fsS http://127.0.0.1:8090/health'
4. Decide: push to origin/main? penumbra handoff implementation? llama.cpp -lcd investigation? Granite long-lived reconciler bug? Pick one with the user.
```
