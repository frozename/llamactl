# Maestro continuation prompt — 2026-05-15 am

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

This session was hand-implemented end-to-end (long multi-step diagnostic + fix loop on mac-mini infra). Some of that work crossed into the `penumbra` repo (commit `8a7c69e`), see below.

## What this session shipped

### llamactl repo (8 commits)

**`83f7683` chore(gitignore): ignore `.penumbra/`**
Housekeeping: the daemon writes runtime state under `.penumbra/` in any repo it touches; nobody wants that in git.

**`a2867b0` bench(memory-efficacy): `-lcd` +15% finding does NOT reproduce**
Hand-implementation. Falsified my own May-13 reading (commit `9082548`) — applied granite41-8b-bench workload on M4 Pro :8093 -np 1 ctx 8192, ran 100-finding memory-efficacy bench with and without `--lookup-cache-dynamic <file>`. Both came in at 71.5s / 0.42 fps within 0.3% of each other. The original +15.7% was a measurement artifact. Killed the high-acceptance-workload follow-up the May-14 retrospective had queued; updated `project_shared_ngram_cache_2026-05-14.md` memory with the falsification.

**`500d363` bench: 5-model sweep validates Qwen3-8B production choice**
Hand-implementation. Full 470-finding memory-efficacy corpus against Qwen3-8B, Llama-3.1-8B, Qwen3.5-4B, Phi-4-mini, Qwen3.5-9B on M4 Pro :8093 ctx 32768 -np 2 grammar-constrained. Qwen3-8B is the only model that scores non-zero F1 on **missed_registration** AND **recall_miss** — the rare classes the classifier exists to catch. Qwen3.5 (both sizes) + Llama-3.1 are *headline-misleading* majority-class predictors. Phi-4-mini sees memory issues everywhere (opposite bias). `memory_ignored` is unreachable across all 5 — gold n=4 likely too small.

**`56db0b8` bench: report macro F1 + balanced accuracy**
Hand-implementation. After the user pushed back ("isn't 4B the winner since smaller?"), added macro_f1 + balanced_accuracy to `tools/memory-efficacy-bench/run-bench.ts` so future bench reads aren't dominated by majority-class collapse. The metrics tell a clearer story: Qwen3-8B macro_f1 30.7% (4-9 pp ahead), and Phi-4 ranks #2 on balanced_accuracy (37.9%) — its recall is genuine, only precision collapses.

**`7e0bfcf` fix(daemon): dedupe args when spawning llama-server**
Hand-implementation. **Root cause**: `launchBackground` in `packages/core/src/server.ts` unconditionally prepended `-m, --alias, --host, --port, -ngl`, plus `startServer` always pushed `serverProfileArgs('default')` (`-fa on -b 2048 -ub 512`), BEFORE the user's `extraArgs`. So a manifest with `--host 0.0.0.0 -ub 1024 ...` produced a doubled cmdline. Last-wins on modern llama-server resolves the dupes, but older builds hang or crash. New helpers: `hasFlag` + `filterProfileArgs`. Verified live on M4 Pro local-node apply — clean 18-token cmdline, no duplicates.

**`aeaa559` bench(tool-calling): 3-model comparison on penumbra fixtures**
Hand-implementation. Built `tools/eval-driver/run-tool-calling.ts` as a standalone driver around `packages/eval/src/runners/tool-calling.ts`. Result: Qwen3-8B 12/12 (production baseline), Qwen3.5-4B 12/12 (viable swap on OpenAI-compat path), **Phi-4-mini 4/12** — refuses every tool call with "I'm sorry, but I cannot assist with that". Safety-tuning is over-aggressive. Disqualifies Phi-4 for home-mgmt regardless of accuracy.

**`c04f8e9` fix(daemon): mDNS env-var escape hatch + mac-mini 4B workload**
Hand-implementation. After committing `7e0bfcf` I deployed it to mac-mini and the daemon-managed apply still hung. Hours of debugging surfaced two compounding issues:

1. **bonjour-service v1.3.0** synchronously `console.log(new Error("Service name is already in use"))` from inside a dgram data handler when a stale mDNS announcement is still on the LAN. Bun upgrades that to a fatal that wedges the event loop WITH the TCP socket still LISTENing — apply requests "connect but never respond." The existing service-level `error` listener doesn't catch it because the library bypasses event emission. Fixed by adding `LLAMACTL_DISABLE_MDNS=1` env-var escape hatch in `packages/remote/src/server/serve.ts`.

2. **mac-mini launchd plist** was missing USER, TMPDIR, LANG, and `/Users/aimastermind/.bun/bin` in PATH for the bun runtime to make it past its startup file-open phase. `sample`-on-stuck-process showed main thread parked at `openat$NOCANCEL` before `startAgentServer` even ran. Patched plist via PlistBuddy on mac-mini (live edit, not in repo).

End-to-end verified: `llamactl apply -f templates/workloads/qwen3-8b-mac-mini.yaml` spawns clean; `llamactl disable/enable` swaps in place; new `templates/workloads/qwen35-4b-mac-mini.yaml` ships as the swap target.

**`ffb9d3b` fix(workloads/mac-mini): bump ctx + pin atomic-fork binary**
Hand-implementation. First home-mgmt smoke test against daemon-managed mac-mini revealed context-overflow: home-mgmt prompt is ~30K tokens, but ctx 32768 / -np 2 = 16K/slot wasn't enough. Bumped Qwen3-8B template to ctx 65536 (= 32K/slot, matches prior SSH-launched). Qwen3.5-4B template to 131072 (= 64K/slot, since 4B weights are smaller). Also added `spec.binary` pinning both to `/Volumes/AI-DATA/src/llama.cpp-atomic/build-shared-cache/bin/llama-server` (May-13 atomic-fork with shared-cache patch) — without the pin, daemon falls back to the LLAMA_CPP_BIN default which on mac-mini is May-7 vanilla upstream (slower).

The atomic-fork binary on mac-mini had its rpath baked to `/Volumes/WorkSSD/...` (because I rsync'd from M4 Pro). Fixed live with `install_name_tool -delete_rpath ... -add_rpath /Volumes/AI-DATA/src/llama.cpp-atomic/build-shared-cache/bin` on the binary + each `.dylib` — that's a mac-mini-side fix, not in repo.

### penumbra repo (1 commit)

**`8a7c69e` fix(agentchat/stdio-acp): let user-provided PENUMBRA_MCP_TOOL_ALLOWLIST pass through**
Hand-implementation. Investigating the home-mgmt prefill regression (claimed ~17K post-May-13 optimization, observed 30K live), traced through llama-server log → `failed to parse grammar` followed by GBNF for every penumbra MCP tool (agent_rank, workflow_run, worktree_*, etc.) — including tools NOT in home-mgmt's `mcp_allowlist`. Root cause: penumbra-mcp DOES have a `PENUMBRA_MCP_TOOL_ALLOWLIST` env knob (since `4937134`-era), but agentchat's stdio-acp adapter at `packages/agentchat/src/adapters/stdio-acp.ts:87` had `PENUMBRA_MCP_TOOL_ALLOWLIST` in its `PENUMBRA_MCP_INJECTED_ENV_KEYS` strip list and only re-injected for `long_lived_tick` dispatches. Manual `chain_start` tests (and any non-cron path) got NO allowlist. Removed from the strip list. The adapter's own injection still runs for cron ticks AFTER the user-provided entry, so last-wins keeps dispatch-side semantics intact.

Verified live: home-mgmt prefill **30,581 → 13,765 tokens** (-55%, recovering the May-13 `b6cae24` ~17K target). Tick wall time **6-min watchdog timeout → 1m42s completion**.

## Live state

**M4 Pro (`local`):**
- node-agent runs from source via launchd (`com.llamactl.node-agent`); my edits to `packages/core/src/server.ts` + `packages/remote/src/server/serve.ts` are live since the last `launchctl unload+load`.
- Workloads running: `gemma4-26b-a4b-mtp-warmup-on-local` (:8181, PID was 21567 at start), no other long-lived servers.

**mac-mini:**
- node-agent at PID **13199** running source-via-bun (`launchctl kickstart -k gui/$(id -u)/com.llamactl.agent` brought it up after a plist switch from compiled binary). Plist still has `--dir=/Users/aimastermind/.llamactl-agent`.
- Plist now sets `USER=aimastermind`, `TMPDIR=/var/folders/m3/.../T/`, `LANG=en_US.UTF-8`, `LLAMACTL_DISABLE_MDNS=1`, plus prepends `/Users/aimastermind/.bun/bin` to PATH.
- :8090 served by **daemon-managed `qwen3-8b-mac-mini`** (PID 3455 last I checked) — Qwen3-8B Q4_K_M, ctx 65536 -np 2, atomic-fork May-13 binary. Disabled twin `qwen35-4b-mac-mini` ready for future swap via `llamactl enable/disable`.
- penumbra agentchat-worker at PID **13199** (kickstarted after the stdio-acp.ts edit).

**Live edits not in any git repo:**
- `~/.config/agentchat/agentchat.yaml` — added `PENUMBRA_MCP_TOOL_ALLOWLIST` to home-mgmt's mcpServers env. Used canonical names (`memory.search`, not `memory_search`) to match penumbra-mcp's registry.
- `~/Library/LaunchAgents/com.llamactl.agent.plist` on mac-mini — env vars + program-args swap (bun source-run).
- `/Volumes/AI-DATA/src/llama.cpp-atomic/build-shared-cache/bin/{llama-server,*.dylib}` on mac-mini — `install_name_tool` rpath fix.

## Open follow-ups

1. **Anthropic-compat tool-call failures on Qwen3-8B daemon-managed path.** Home-mgmt's last successful tick still had `agent.tool_call.failed` event — model emitted a tool call but claude-agent-acp didn't parse it. Tool calls eventually succeed in retries but ~1 attempt per turn fails. Worth investigating because the SSH-launched Qwen3-8B previously had "zero tool_call.failed across 50+ tool calls." Suspects: different binary build (May-13 atomic-fork vs the prior shared-cache May-14 SSH binary) OR a Jinja chat-template difference. Check `tail llama-server.log` for raw output during a tool-call failure to see the actual emitted format.

2. **`PENUMBRA_MCP_TOOL_ALLOWLIST` canonical-name mismatch in long_lived_tick path.** My fix lets user-provided env pass through, but the AUTO-injected version (from `buildLongLivedMcpEnv` in `packages/agentchat/src/adapters/stdio-acp.ts:90-113`) feeds `session.mcp_tool_allowlist` raw — entries like `penumbra:memory_search` — and penumbra-mcp's `canonicalToolId` converts that to `penumbra.memory_search`, which still doesn't match the registry key `memory.search`. For now the manual env override in `agentchat.yaml` works around this. The proper fix: either (a) the adapter canonicalizes to registry names before joining, or (b) penumbra-mcp's `canonicalToolId` strips the `penumbra.` prefix when matching. Worth fixing before relying on cron-tick prefill shrink.

3. **Schema-level vs runtime-dispatch filter alignment.** The `mcp_allowlist` in agentchat.yaml controls runtime dispatch (model can only CALL these tools), but historically did NOT control schema injection (model SEES all MCP tools). My fix wires schema-injection to a separate env var. Worth a docs note or a single field that drives both.

4. **Gold-set imbalance still unresolved.** Across the 5-model 470-corpus sweep, 456/470 (97%) of gold is `not_memory_related`. Rare-class F1 differences hinge on 1-2 correct predictions. Won't distinguish models reliably until gold for `memory_ignored` (gold n=4) and `missed_registration` (gold n=2) is expanded. Considered but not actioned this session.

5. **launchd-managed mac-mini agent crash-loops** (chronic). Each agent kill triggers a launchd respawn that races; stderr accumulates "Failed to start server. Is port 7843 in use?" entries. The currently-running PID is fine; this is just log noise. Could be tamed by widening agent.ts's port-conflict catch OR by making the agent acquire a launchd-friendly singleton lock.

## Memories worth reading

- `project_daemon_arg_dedup_2026-05-15.md` — the launchBackground dedup fix + the mDNS escape hatch + the mac-mini env-var requirements. Single document covering the whole daemon thread.
- `project_qwen_5model_sweep_2026-05-15.md` — 5-model bench results + the macro_f1/balanced_acc framing that supersedes the misleading bucket_accuracy headline.
- `project_shared_ngram_cache_2026-05-14.md` — updated mid-session with the +15% falsification. Reading this first prevents re-pursuing dead ngram-cache optimization paths.
- `project_spec_draft_granite_no_win_2026-05-14.md` — companion to the above: speculative decoding is fleet-wide negative on M4 Pro Metal across 3 architectures. Don't propose `--spec-draft-model` as a first-lever.
- `feedback_bun_mdns_test_collisions.md` — the bonjour-service v1.3.0 bug that wedged my entire afternoon. Worth surfacing earlier next time the agent goes silent on the wire.

## First moves

1. `git status --short && launchctl list | grep llamactl && git log --oneline origin/main -10`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. `curl -sf http://192.168.68.76:8090/v1/models | jq '.models[0]'` → confirm mac-mini :8090 daemon-managed Qwen3-8B is still serving
4. `llamactl get workloads` → cross-check declared vs running (note: this currently shows only `local` node entries; mac-mini state must be checked via `ssh macmini.ai ps aux | grep llama-server` or the daemon's per-workload runtime dir at `/Volumes/AI-DATA/ai-models/local-ai/workloads/`).
5. If picking up follow-up #1 (Anthropic-compat tool-call failures): `mcp__penumbra__chain_start initial_agent=home-mgmt message="ha_pulse and report briefly"` then immediately `ssh macmini.ai "tail -200 /Volumes/AI-DATA/ai-models/local-ai/workloads/qwen3-8b-mac-mini/llama-server.log | grep -E 'tool|generated'"` to capture the raw output of a failed call.
