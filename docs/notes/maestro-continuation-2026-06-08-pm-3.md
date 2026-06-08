# Maestro continuation — 2026-06-08 pm (part 3)

> Paste into the next session. Focus this session on **stability / performance /
> closing open threads** (user's explicit ask). Follow `AGENTS.md`; neutral repo
> text (no AI attribution); Penumbra MCP for chain state; delegate via
> `chain_start`, hand-code for correctness-critical/live work.

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

## State at handoff (verified)
- llamactl `main` @ **`a3f70f2`** — pushed, `== origin`. (PR-protected; pushes via admin bypass.)
- penumbra `main` @ **`4ec214e3`** — pushed, `== origin`. (Includes my `f2fb9bd0` refiner-timeout fix + the concurrent agentchat single-poller work, both landed.)
- Services up: controller (pid 56971) / node-agent / fleet-supervisor / internal-proxy (:7944) / penumbra daemon (**pid 24964 — restarted this afternoon**). lfm2 `:8185` + granite `:8083` both healthy (refiner + judge). No pending handoffs.

## OPEN THREADS — stability / performance (prioritized)

1. **Activate the two committed fixes in the running daemons** (both are stability/perf; committed+pushed but the live daemons may run old dist):
   - **Controller reconcile-clobber fix** (`llamactl@41e724c`): controller pid 56971 was last restarted for the lfm2 fix and predates this commit → still has the bug where `llamactl enable/disable` (or a manual manifest edit) is silently reverted if it lands mid-reconcile-pass. Rebuild `packages/remote` dist + restart the controller (`launchctl bootout`+`bootstrap gui/$(id -u)/com.llamactl.controller`) so enable/disable persists reliably.
   - **Refiner 90s timeout** (`penumbra@f2fb9bd0`): daemon pid 24964 restarted after the commit landed, so it MAY already be active. **VERIFY**: grep the daemon's dispatch-refine "judge endpoint resolved" log for `timeoutMs:90000`, or run a `chain_start_refined` and confirm it doesn't 30s-timeout on a large input. If stale, rebuild penumbra `packages/{config,core,daemon}` dist + restart `dev.penumbra.daemon`.

2. **Reconcile loop poisoned by the dead mac-mini judge** (perf — affects ALL fleet ops): every controller pass BLOCKS ~4 min on `granite41-3b-judge-mac-mini` serverStart timing out (mac-mini node down/unreachable — confirmed still failing at 16:45Z). This stretches a ~15s reconcile interval to ~5 min, slowing every enable/disable/apply. **Fix**: either restore mac-mini connectivity or `llamactl disable granite41-3b-judge-mac-mini` (+ the other mac-mini workloads if the node is truly down) to restore fast reconciles. Biggest single perf win for fleet responsiveness.

3. **omlx orphan-on-stop** (stability): the matrix eval left an orphan `omlx` server holding Metal/RAM after `TaskStop` (had to hand-kill pid). The matrix omlx lifecycle (`packages/eval/src/matrix/lifecycle.ts`) likely doesn't kill its managed omlx child on abnormal exit. Worth a cleanup-on-exit / signal-trap fix so eval kills don't leak GPU memory.

4. **lfm2 refiner** — durably up now (`spec.enabled:true` persisted in the manifest; root cause was a persistence bug, NOT instability — see memory). Healthy. Just confirm it survives reconciles and isn't evicted when co-located with granite. Activation of its 90s timeout = item 1.

## OPEN THREADS — lower priority (carried)
5. **Borderline atomic-fork eval specs** still reference the deleted fork binary: `packages/eval/specs/{gemma4-vs-qwen35-headtohead,tool-call-tier-fleet,memory-recall-fleet,mac-mini-*}.json` + `templates/workloads/gemma4-e4b-vanilla-local.yaml`. Re-point to the unified `/Volumes/WorkSSD/src/llama.cpp` binary or delete.
6. **`AGENTS.md` still references the atomic fork** as model-selection guidance (stale post-unification). Update.
7. **Cost-quota-tracker false positives** (penumbra) — over-reports subscription exhaustion; rewrite pending (see `[[project_cost_quota_tracker_false_positives_2026-05-27]]`).
8. Optional eval completeness: gemma QAT family only ran **MMLU-Pro** (ARC/GSM8K skipped for time); reasoning-moq-vs-ud only re-ran MMLU-Pro at 1024. Run the other two suites if you want clean macros.

## What shipped this session
- Fixes: controller reconcile-clobber (`41e724c`), penumbra refiner-timeout configurable+90s (`f2fb9bd0`), reasoning-mc 768→1024 (`ca6e3b3`), pruned dead MTP/atomic config (`c157f45`).
- lfm2 refiner made **durable** (manifest enabled:true + controller restart) — was misdiagnosed as "crashes," actually a persistence bug.
- **Gemma 4 QAT family eval** (`a3f70f2` + notes `docs/notes/2026-06-08-gemma4-qat-family-eval-and-mtp-metal.md`): MMLU-Pro 31B 0.858 > 12B 0.780 ≈ 26B-A4B 0.773 > E4B 0.680 > E2B 0.447. **MTP draft-spec does NOT transfer to Metal** (12B 0.99×, 26B 1.10×, 31B 0.59× vs CUDA 1.64/1.18/1.83×). Bench harness: `tools/mtp-bench/`.

## First moves
1. `git -C /Volumes/WorkSSD/repos/personal/llamactl log --oneline -1` (a3f70f2); `git -C /Volumes/WorkSSD/repos/personal/penumbra log --oneline -1` (4ec214e3) — both == origin; `launchctl list | grep -E 'llamactl|penumbra'`; `mcp__penumbra__handoff_list_pending`.
2. `curl -s :8185/v1/models` (lfm2) + `curl -s :8083/health` (granite). Tail `~/.llamactl/logs/controller.stdout.log` — confirm the mac-mini-judge `serverStart timed out` is still poisoning reconciles (item 2).
3. `mcp__penumbra__memory_search` slugs: `enable-clobber-and-refiner-timeout-fixed-2026-06-08`, `gemma4-qat-family-mmlu-and-mtp-metal-2026-06-08`, `lfm2-not-flaky-persistence-bug-and-always-thinks-2026-06-08`.
4. Pick from the stability/perf list with the user — recommend **item 2 (mac-mini reconcile poisoning, biggest fleet-wide perf win)** then **item 1 (activate the two fixes)**.
