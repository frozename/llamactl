# Maestro continuation prompt — 2026-05-17 am-2

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start` with `trust_mode: "all"`; hand-code only when the worker/daemon won't boot.

**Execute the First moves checklist (section 6) immediately in efficient order.** Batch independent calls in parallel inside a single message; sequence only the ones whose inputs depend on prior output. Pause only on items with user-visible blast radius (push, dispatch_land, restart hosted services, external messages) or genuine ambiguity. Do not re-litigate the checklist.

## 1. What this session shipped

Five commits across two repos, plus live config and one workload swap.

### Penumbra repo (4 commits, all dispatched then force-landed)

- **`c97e99b` fix(daemon/sweepers): surface gh task sync failures** — `gh-task-sync` was logging only the aggregate (`linked=N errored=N`) with per-task errors swallowed. Added a `warn`-level log with `{taskId, ghRef, err, code}` in the `syncLinkedTask` catch path. Dispatched to `codex-acp-fast` (1m, accept). Force-landed because the quality-gate had no verdicts yet — diff was 12 lines + a focused test, audited inline.
- **`87b039d` fix(daemon/sweeper): drop gh --jq when paginating comments** — Root cause exposed by `c97e99b`'s new logs: every `gh api .../comments --paginate --slurp --jq …` call was rejected by the current `gh` CLI (`the --slurp option is not supported with --jq or --template`). Fix: drop `--jq` and project the fields in TS (`parseGhIssueComments`). Dispatched to `codex-acp-fast` (`tool_failure_with_end_turn` reliability, but the commit landed; inspected the diff and force-landed). After this commit landed and the daemon restarted, `gh-task-sync` went from `errored=32/32` to `errored=0/32` within one tick cycle.
- **`2823c11` fix(daemon/long-lived): bounded grace wait for federation cold start** — `task-refiner-{primary,escalation}` were firing `federation-tools-listTools-failed` warns every `:00/:15/:30/:45` cron boundary. Fix: introduce `waitForFederationReady()` in `long-lived-federation-tools.ts` that races `mcpPool._state(server).initPromise` against a 5 s timeout. Dispatched to `codex-acp-fast` (`tool_failure_with_end_turn`, recovered with commit). Two regression tests cover cold-start + bounded-wait-still-unhealthy paths. Force-landed.
- **`02fbeca` fix(daemon/t2-judge-pool): plumb caPath into fetch tls.ca** — `t2-judge-pool.ts` typed `caPath` into `JudgeEntry` but never passed it to `fetch` → mac-mini's self-signed cert on `https://192.168.68.76:7843/v1` always failed with `self signed certificate`. Fix mirrors `openai-compat-http.ts:24-46`: `readFileSync(caPath)` at construction, `init.tls = { ca: caPem }` per-request. Dispatched to `codex-acp-fast` (28 s, accept). Force-landed.

### llamactl repo (1 commit, dispatched directly to llamactl main)

- **`c2ee627` feat(core/proxy): route /v1/* by model field across workloads** — The mac-mini gateway proxy was single-workload-per-node: `openaiProxy.proxyOpenAI()` targeted `LLAMA_CPP_PORT` from env regardless of the request's `model` field, so chat-completion requests for `granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf` returned `502 upstream llama-server unreachable` even when granite was running on :8086. Fix: peek `model` from JSON body (`requestedModelFromBody`), iterate `listLocalWorkloads()` + match `state.rel`, route to `http://${state.host}:${state.port}`. Falls back to env endpoint for back-compat (model omitted / unmatched) and for non-JSON bodies. Test fan-out covers all three branches + SSE passthrough. Dispatched to `codex-acp-fast` (3m27s, two retry hops including codex-mini secondary). Landed directly on main since llamactl's dispatch path puts commits straight on the working tree.

### Pre-existing penumbra commit, verified shipped (not this session)

- **`penumbra@2a57160` feat(memory-efficacy): inject 3-exemplar few-shot block** — the M-track ship item from `llamactl@40b90cb` ("Open ship item: wire the 3-exemplar prompt into penumbra's memory_efficacy_* codepath"). Verified present at `packages/core/src/services/memory-efficacy-classifier.ts:49-61`. Marked complete; no new code needed.

### Config + ops changes (not in git)

- `~/.config/agentchat/agentchat.yaml` — two stanza edits:
  - `local-granite-8b`: baseUrl `http://127.0.0.1:8080/v1` → `http://127.0.0.1:8083/v1` (Q4 granite-8b moved port long ago; agent was pointing at a dead port).
  - `granite-mini-8b` → renamed to `granite-mini-3b`; model id `granite41-8b-q4` → `granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf`; caPath `/tmp/llamactl-mac-mini-ca.pem` → `/Users/acordeiro/.llamactl/certs/mac-mini.pem`; `roles:` cycled through `[memory-refiner]` → `[]` (dormant) → `[memory-refiner]` again.
- `~/DevStorage/workloads/granite41-3b-judge-mac-mini.yaml` — new workload manifest (also committed at `templates/workloads/`). Granite-4.1-3B Q8_0 on mac-mini :8086 with `--alias granite-mini-3b --host 0.0.0.0`.
- `llamactl disable qwen3-8b-mac-mini` — mac-mini was RAM-bound (Qwen3-8B holding 10 GB of 16 GB → granite mid-load OOM'd silently). User approved the swap on the grounds the Qwen3-8B slot is up for benchmark-driven replacement anyway. **Home-mgmt's chat-completions wire (model=`Qwen3-8B-…`) is currently rerouted via the new multi-workload proxy to granite-3b** on model omission. Untested behavior — may want re-eval.
- `rsync` `/Volumes/WorkSSD/ai-models/llama.cpp/models/granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf` (3.6 GB) → `macmini.ai:/Volumes/AI-MODELS/llama.cpp/models/granite-4.1-3b-GGUF/` (34 s @ 100 MB/s).
- `rsync` `packages/core/` + `packages/remote/` from local repo → `macmini.ai:/Volumes/AI-DATA/repos/personal/llamactl/` so the mac-mini agent picks up `c2ee627`. Mac-mini's git is otherwise stale (still at `e87202e` from 2026-05-14).
- `~/Library/LaunchAgents/com.llamactl.agent.plist` on mac-mini — `LLAMA_CPP_PORT` flipped 8090 → 8086 (was the single-workload fallback target; now the back-compat fallback for model-omitted requests).

## 2. Live state

- Penumbra daemon + worker: both up; last restart applied all 4 penumbra commits.
- Mac-mini llamactl agent: restarted with new plist env + rsync'd source.
- Mac-mini llama-server: `granite41-3b-judge-mac-mini` PID 48503 listening on `*:8086`; Qwen3-8B disabled.
- Local llama-servers: `granite41-3b-judge-local :8085`, `granite41-8b-long-lived-local :8083`, `gemma4-26b-a4b-mtp-b-1024-local :8181` — all Running.
- Penumbra t2-promotion judge pool: `count=2, names=["granite-mini-3b","local-granite-8b"]` configured. Last `judge failed` event: **02:28:31** (pre-port-fix 502s). Post-fix: no errors, but the worker has been in `skipping high-frequency transcript sample` mode (107 such logs) waiting for a unique rollup — the next non-duplicate session will be the first end-to-end two-judge verification.
- gh-task-sync: stable at `linked=32 pushed=0 pulled=0 errored=0` (was 32/32 before `87b039d`).
- Federation refiner race: fix is landed; the next `:00/:15/:30/:45` cron boundary will be the first chance to confirm zero `federation-tools-listTools-failed` warns. Untested at the boundary as of session end.

## 3. Open follow-ups

1. **Confirm two-judge pool round-trip with a real rollup.** Once a non-duplicate session lands, log should show `t2 promotion: promoted session count=N` with both judges quiet. If granite-mini-3b fails with a *new* error class (not 502, not "self signed", not "socket closed"), inspect at `~/.penumbra/launchd.daemon.out.log` and `/Volumes/AI-DATA/ai-models/local-ai/workloads/granite41-3b-judge-mac-mini/llama-server.log` on macmini.ai.
2. **home-mgmt re-evaluation.** Qwen3-8B mac-mini is disabled. Home-mgmt's POSTs to mac-mini gateway now fall through to granite-3b on model omission, OR route to granite-3b if model matches its rel. Behavior under granite-3b-as-default has not been tested. Likely needs either: (a) re-enable Qwen3-8B mac-mini after a benchmark sweep selects a final model, or (b) update home-mgmt's agentchat entry to target granite-3b explicitly. Defer until benchmarks land.
3. **B-instr (Task #5) — tick-event writer spec.** Multi-session arc per `docs/notes/fleet-eval-scoping-2026-05-16-night.md` lines 32-38. Pattern: mirror `penumbra@eca9e319 memory_verify` auto-fire. ~1 h to spec, ~2 h to implement. Suggest dispatching the spec write first (claude-acp-sonnet or codex-acp-fast on plan_refine), user-review, then implementation dispatch.
4. **t2-promotion staleness.** Granite emits `@@metadata` tags before JSON (project memory entry); the t2-judge-pool's `parseJudgeResponse` may misbehave when granite-mini-3b becomes the active judge. Worth probing the first successful two-judge tick's output payload — if parse fails appear, add a strip-step like `eval-classifier.sh` did.
5. **Verdict gate force-lands.** Four dispatches this session used `force: true` on `dispatch_land` because `reconciler_verdicts` was empty. Probably worth running an adversarial-review pass against the 4 landed diffs (`c97e99b`, `87b039d`, `2823c11`, `02fbeca`, `c2ee627`) once you have a quiet moment.
6. **Mac-mini repo drift.** `/Volumes/AI-DATA/repos/personal/llamactl` is at `e87202e` (90+ commits behind). Only `packages/core` + `packages/remote` were rsync'd. Full `git pull` would be safer; check whether `aimastermind@macmini.ai` has push/pull credentials configured.

## 4. Memories worth reading first

- `reference_penumbra_dispatch_routing.md` — daemon defaults to penumbra repo; for llamactl dispatches use `caller_cwd:/Volumes/WorkSSD/repos/personal/llamactl` (confirmed working this session — `c2ee627` landed on llamactl main).
- `reference_llamacpp_mtp_binaries.md` — mac-mini's atomic llama.cpp binary lives at `/Volumes/AI-DATA/src/llama.cpp-atomic/build-shared-cache/bin/llama-server`; this is what `LLAMA_SERVER_BIN` must point to at apply time.
- `project_multi_workload_shipped_2026-05-13.md` — soft RAM admission docs. Mac-mini's `expectedMemoryGiB: 4` for granite-3b did NOT actually prevent OOM when Qwen3-8B's 10 GB resident left only 116 MB free. The soft-admit threshold may need tightening.
- `feedback_decision_contract_pattern.md` — informs the M-track / B-instr direction.
- `project_attention_thesis_eval_2026-05-16.md` — production-swap candidate ranking; informs the home-mgmt re-eval thread.
- t2 entries: parser enhancement for classification script, granite `@@metadata` tag trap, t2_vec orphan trap.

## 5. Decisions not to re-litigate

- Mac-mini cannot host Qwen3-8B AND granite-3b concurrently on 16 GB — confirmed by mid-load process kill. User accepted the swap.
- Multi-workload routing should peek the JSON body, NOT add a new public API. `c2ee627` is the canonical pattern.
- `granite-mini-8b` was renamed to `granite-mini-3b` because the underlying model size changed (8B → 3B). Penumbra has no hardcoded references to the name (verified before rename).
- `daemon_reload_config` does NOT reinitialize the t2-promotion judge pool — full daemon restart required for agentchat.yaml judge changes to take effect.

## 6. First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `tail -200 ~/.penumbra/launchd.daemon.out.log | grep -E "judge pool|promoted session|judge failed" | tail -10` — confirm first post-restart two-judge promotion has landed
4. `curl -sk -m 5 -H "Authorization: Bearer ll_agt_hhMIvwSymXSysUkGE4g_azFFX1GRRy5P" https://192.168.68.76:7843/v1/models` — confirm mac-mini gateway still exposes granite-3b
5. If two-judge promotion confirmed, mark Task #8 completed and pick next thread: home-mgmt re-eval (#2 in §3 above) or B-instr spec (#3).
