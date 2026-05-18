# Maestro continuation prompt — 2026-05-15 pm

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate substantive code via `chain_start`; hand-code only when the worker/daemon won't boot.

This session attempted to live-validate the home-mgmt Tier-2 chain_start escalation path that the prior session's continuation note left as the headline open question. We found three significant things plus a narrower picture of the parser bug.

## What this session shipped

### penumbra repo (uncommitted, ready for commit)

**`daemon-client.ts:206` + `daemon-client.test.ts`** — `longLivedStateSet` MCP route was sending the partial object directly as the request body, but the daemon route expects `{partial: {...}}`. Every state mutation via MCP returned HTTP 400. Fixed: wrap `partial` in the daemon-client. Regression test added (11 pass). Verified live via direct curl (HTTP 200, intent_summary persisted into agent row).

**`packages/mcp/src/tools/chain-start-simple.ts` (new) + registry entry + import** — Built a 2-field wrapper for `chain_start` to test the schema-complexity hypothesis. Takes only `initial_agent` + `message`, hardcodes `task_class=STANDARD, task_type=debug_diagnose, use_worktree=false, max_hops=2, trust_mode=config`. Registered as `chain_start_simple` in TOOL_REGISTRY (99 tools, registered). Live test result: **schema complexity is NOT the bug** — the simplified wrapper still fails ACP parsing with null tool_name (1× retry vs 3× for full chain_start; schema width only affects retry count, not the underlying parse).

### Live config (uncommitted, in `~/.config/agentchat/agentchat.yaml`)

- **home-mgmt standing_brief gained a Priority-0 step** ahead of the per-tick protocol: read `pending_goals` first via `state_get`; if non-empty, follow the first goal's `text` verbatim and skip the short-circuit. Verified working — Qwen3-8B obeyed the directive on the next tick and went straight for chain_start without first calling ha_pulse.
- **chain_start_simple added to 3 allowlists**: `mcp_allowlist`, `claudeCodeAllowedTools`, and the proxy's `MCP_PROXY_ALLOWLIST`.
- Backup of the pre-session yaml saved at `~/.config/agentchat/agentchat.yaml.bak-2026-05-15-pm`.

## The headline finding

**Local-model chain_start dispatch is blocked at the ACP-adapter layer for every brain in the fleet.** Both Qwen3-8B (validated for ha_pulse/state_set short-circuit) and Gemma 4 26B-A4B-MTP (validated for the same May-14) fail claude-agent-acp's tool-call parser when the target is `chain_start` or `chain_start_simple`. The failure is identical: `tool_call_update {status: failed, title: undefined, kind: undefined}` → penumbra logs `agent.tool_call.failed {tool_name: null, output: null}`.

Critical safety signal: **Qwen3-8B confabulates a fake `handoff_id` in its final text response when the parser rejects its tool call.** Two cases observed: `83529167-4598-4d6a-85d5-732f87f6b190` and `6b4ebbd6-7794-455a-b68a-8a9110e3cab4`. Neither handoff was ever in the DB. Both came back wrapped in a perfectly-formed `{action_status: executed, result: {...}}` envelope. Don't trust Qwen's intent_summary or text reports when the underlying tool calls failed.

Memory captured at `project_gemma_acp_tool_call_incompat_2026-05-15.md` (named for the original Gemma test; now broadened to cover all local models). Three test rows in the results table, root-cause analysis updated.

## What's next session's job

1. **Capture llama-server verbose during a failing chain_start_simple tick AND a successful ha_pulse tick.** Both on Qwen3-8B :8090. Diff the JSON-RPC tool_use chunks at the wire layer. Hypothesis worth checking: penumbra-native tools emit as `mcp__penumbra__chain_start_simple` vs federated tools as `mcp__ha__ha_pulse`; the claude-agent-acp `toolUseCache[chunk.id]` lookup may fail for one shape but not the other. Verbose llama-server output is the cheapest path to ground truth.

2. **Validate the dispatch plumbing end-to-end** by running a one-off cloud-Sonnet tick (Path C from this session's plan; user deferred earlier). $0.05-0.15. If Sonnet emits clean chain_start tool_use chunks, the home-mgmt → codex-acp-deep handoff actually fires and we get a real plan back. This decouples "is the plumbing wired right" from "do local models emit the right wire shape" — two separate engineering questions.

3. **Commit the two penumbra deliverables**: state_set 400 fix + chain_start_simple wrapper. Both are isolated, tested, and useful regardless of how the parser bug resolves. The chain_start_simple wrapper is genuinely useful for any future cheap-model agent that needs a sub-dispatch and only knows two pieces of context to pass.

4. **Existing follow-ups still pending** (from prior continuation):
   - **Daemon stale-sweeper bug.** Orphan ticks pile up across the session; only worker bootout cleans them. Real fix is in penumbra's stale_force_resolve sweeper. Three orphans were created this session (the Gemma chain that hit watchdog, the Qwen chain that hit chain_cancel, and the test chain at end of session that ended cleanly anyway). Sweeper running at boot worked correctly each time but doesn't run mid-life.
   - **Underscore-refactor cosmetic stragglers** (~50 dotted references in test names/comments).
   - **mac-mini launchd-respawn noise (task #4)**.

## Live state at session end

- penumbra daemon: PID 87343, up
- penumbra worker: PID 57690, up (bounced 3× this session to clear orphans)
- home-mgmt: **paused** at session end. To resume the parser-trace investigation, leave paused and tick manually for control.
- mac-mini llama-server (Qwen3-8B): :8090, healthy, ctx 65536 -np 2
- M4 Pro llama-server (Gemma 4 26B-A4B-MTP): :8181, healthy, ctx 65536 -np 1 (still running from the failed Path B test — fine to leave)
- home-mgmt working_memory: stale `last_pulse_id` ("sha256:stale-injected-2026-05-10") + the chain_start_simple-targeted pending_goal still in place. Either revert via `long_lived_state_set` or just resume and let it re-test.

## Memories worth reading first

- **`project_gemma_acp_tool_call_incompat_2026-05-15.md`** — full results table, root-cause narrowing, code trace into claude-agent-acp + penumbra/stdio-acp.ts:719. Read this first.
- **`project_home_mgmt_long_lived_flow_2026-05-14.md`** — the prior session's Granite-vs-Gemma comparison that established the May-14 validated config.
- **`project_qwen_tool_grammar_2026-05-15.md`** — the morning session's investigation that this evening built on.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Review penumbra uncommitted diff: `cd /Volumes/WorkSSD/repos/personal/penumbra && git diff packages/mcp/`. Three files changed: `src/daemon-client.ts`, `src/tools/registry.ts`, `src/tools/chain-start-simple.ts` (new), plus the test file `test/daemon-client.test.ts`. Commit these.
4. To start the parser trace: kill the running Qwen3-8B and restart with `--verbose` (and ideally `--log-disable` removed if set). Then resume home-mgmt + tick once; capture the request body that produces the null tool_name. Then immediately tick a second time after clearing pending_goals to capture a working ha_pulse request body. Diff.
