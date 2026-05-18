# Maestro continuation prompt — 2026-05-15 am (late)

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate substantive code via `chain_start`; hand-code only when the worker/daemon won't boot.

This was a long, productive session that landed seven commits across three repos plus a substantial amount of live yaml + on-host work. Major outcome: **the home-mgmt long-lived agent on Qwen3-8B now runs the full standing-brief protocol end-to-end** (ha_pulse + state_get + state_set with the correct short-circuit message). The generic chokepoint that unblocked this — a stdio MCP allowlist proxy — is in penumbra@56969ef and applies to any future cheap-LL-agent + chatty-MCP combo.

## What this session shipped

### penumbra repo (6 commits)

**`7ef9684` fix(agentchat,mcp,core): strip penumbra prefix; drop Zod .datetime() patterns**
Dispatched to codex-acp-fast. Started from a fresh diagnosis of why home-mgmt was 32K-prefilling and tool-call-failing. Two compounding bugs surfaced: (a) the cron-tick auto-injected `PENUMBRA_MCP_TOOL_ALLOWLIST` was emitting `penumbra:foo` entries that penumbra-mcp's `canonicalToolId` mangled to `penumbra.foo`, not matching the bare registry keys — fix strips the `penumbra:` prefix in `buildLongLivedMcpEnv`; (b) Zod's `z.string().datetime()` expands to a leap-year-aware regex with `\d` that llama.cpp's GBNF parser rejects — drop `.datetime()` from the three offending schemas (`cost-recent`, `cost-quota-status`, `agent-performance` AgentRankInputSchema). Dispatch was flagged untrustworthy (4 tool failures) but produced clean diff; verified 38/38 tests + typecheck before landing.

**`c6b3ff7` fix(core,mcp): restore runtime datetime validation via Zod refine**
Dispatched to codex-acp-fast after adversarial review of 7ef9684 flagged a HIGH-sev RangeError reachability: dropping `.datetime()` left `agent-routing.ts:327,343` calling `new Date(input.since).toISOString()` unguarded → invalid input → 500 on `/agents/rank`. Restored validation via `.refine(Date.parse)` — refines aren't serialized by `zod-to-json-schema` so they don't reach llama.cpp's GBNF parser. 47/47 tests pass.

**`b8faf93` refactor(mcp): standardize tool registry keys on underscore (MCP wire convention)**
Dispatched to claude-acp-sonnet. User observed the inconsistency: most tools used dot-namespace (`memory.search`, `agent.rank`) but 24+ tools used bare-underscore (`long_lived_*`, `shell_*`, `chain_send_message` outlier). User asked for "the correct convention for mcp tools" — MCP wire format only allows `[a-zA-Z0-9_-]+`, so dot was always an internal-only convention that leaked inconsistently and caused the allowlist matching bugs. 62 dotted keys renamed; `canonicalToolId` simplified to strip both `penumbra:` and `mcp__penumbra__` prefixes uniformly. 32 files changed; agent flagged untrustworthy but verified clean: zero dotted keys remain, typecheck passes, 16 test fails on worktree ≤ 36 on main (no regressions). The fix-forward `605b4e0` cleaned up two `memory.search` strings the dispatch missed in `packages/daemon/test/routes/workflows.test.ts:327,345`.

**`605b4e0` test(daemon): update workflow test fixtures to use memory_search after rename**
Hand-implemented after adversarial review on `b8faf93` caught the missed test fixtures. Single-character substitution × 2 — tests 19/19 pass.

**`56969ef` feat(agentchat): generic stdio MCP allowlist proxy for cheap-model agents**
Dispatched to claude-acp-sonnet. Built `packages/agentchat/src/mcp-allowlist-proxy.ts` — a stdio MCP shim that wraps any upstream MCP server, filters its `tools/list` response + rejects `tools/call` for non-allowlisted tools. Config via two env vars: `MCP_PROXY_UPSTREAM` (shell-arg-split command for upstream) + `MCP_PROXY_ALLOWLIST` (comma list of bare tool names). All other env passes through to upstream. Drop-in replacement for `mcpServers` entries in agentchat.yaml.

**Why this was the right chokepoint:** `claudeCodeAllowedTools` in claude-agent-sdk filters what the MODEL sees in the system prompt but does NOT filter the wire-level tools array passed to llama-server. So GBNF grammar still covered every registered tool (78K grammar rule lines including off-allowlist `chain_cancel`, `agent_rank`, etc.). The proxy at the MCP-protocol level ensures claude-agent-acp itself never sees the disallowed tools. Grammar is focused → cheap models (Qwen3-8B class) can emit constrained tool calls reliably. Pattern works for any MCP server.

**`3996502` fix(agentchat/mcp-allowlist-proxy): batch bypass + defensive hardening**
Dispatched to codex-acp-fast after adversarial review on the proxy flagged: HIGH-sev batch JSON-RPC bypass (`[{tools/call:forbidden}, ...]` array payloads bypassed the per-tool check), MED duplicate request-id handling, LOW unbounded `pendingMethod` map. Fixed all three — whole-batch rejection (simpler than per-element synthesis), `-32600` for duplicate ids, FIFO eviction at cap 256. 16/16 tests pass.

### atomic-fork llama.cpp (2 commits on `fix/json-schema-grammar-d-shorthand` at `frozename/atomic-llama-cpp-turboquant`)

**`75b2f820e` json-schema-to-grammar: translate \d \D \s \S \w \W to char classes**
Hand-implemented on mac-mini (cross-host work — daemon's worker can't reach mac-mini's `/Volumes/AI-DATA/src/llama.cpp-atomic` tree). Added an `else if` branch to `_visit_pattern`'s literal-accumulator that translates regex character-class shorthand to GBNF char classes (`\d` → `[0-9]`, `\s` → `[ \t\n\r\f\v]`, etc.). Patch script at `/tmp/patch-jsg.py` on M4 Pro and mac-mini is idempotent. Rebuild via `cd /Volumes/AI-DATA/src/llama.cpp-atomic/build-shared-cache && cmake --build . --target llama-server -j 8`.

**`ba90278ed` json-schema-to-grammar: use \x0C/\x0B in \s and \S char classes**
Hand-implemented fixup after adversarial review found my initial `\s`/`\S` mapping used `\f` and `\v` which `parse_char` in `src/llama-grammar.cpp` rejects (only x/u/U/t/r/n/\\/\"/[/] are valid). Replaced with `\x0C` (form feed) and `\x0B` (vertical tab) — both supported. Live-verified zero parse errors on the new build.

Both pushed to `frozename/atomic-llama-cpp-turboquant` (not the AtomicBot upstream — that fork is where we keep local patches). Pushed via M4 Pro's clone after fetching from mac-mini over SSH (mac-mini doesn't have github SSH keys; HTTPS auth failed; M4 Pro has gh-authenticated git as `frozename`).

### llamactl repo (1 commit)

**`e23bf3b` docs(workloads/mac-mini): record ctx-size bumps tried and why 65536 stuck**
Hand-implemented. Comment in `templates/workloads/qwen3-8b-mac-mini.yaml` documents: 131072 (64K/slot) Metal-OOM'd; 81920 (40K/slot, matching Qwen3-8B's training context) Metal-OOM'd under load; the real fix wasn't ctx bumping but reducing prefill via the allowlist proxy. Comment prevents a future reader from re-trying the same bumps.

## Live edits (not in any git repo)

These are in `~/.config/agentchat/agentchat.yaml` — the user's config file. Treat them as canonical until they're committed somewhere.

**home-mgmt agent (lines ~1303-1480):**
- `long_lived_config.hosted_mcp_servers.ha`: wrapped with the MCP allowlist proxy. Command is now `bun /Volumes/WorkSSD/repos/personal/penumbra/packages/agentchat/src/mcp-allowlist-proxy.ts`; original `uvx ... ha-mcp` is in `MCP_PROXY_UPSTREAM` env; `MCP_PROXY_ALLOWLIST: "ha_pulse,ha_get_state,ha_call_service"`. (Note: hosted_mcp_servers is consumed by daemon's mcpPool, not by claude-agent-acp directly — the model reaches these tools via FEDERATION through penumbra-mcp.)
- `long_lived_config.mcp_allowlist`: added `"penumbra:chain_start"` to the existing 6 entries; also fixed `memory_search` (underscore, post-refactor) form.
- `long_lived_config.bounds.max_sub_dispatches`: bumped from `0` to `1` (enables sub-dispatch).
- `long_lived_config.standing_brief`: appended a Tier-2 escalation protocol describing how to dispatch a `penumbra:chain_start` to `codex-acp-deep` for plan-only diagnosis when an open_thread has not progressed across multiple ticks. Records the returned handoff_id in the open_thread's `dispatched_handoff_id` field.
- `options.mcpServers.penumbra`: wrapped with the proxy; `MCP_PROXY_ALLOWLIST="long_lived_self_state_get,long_lived_self_state_set,long_lived_self_pending_actions,memory_search,chain_start,ha.ha_pulse,ha.ha_get_state,ha.ha_call_service"`. **CRITICAL note for future-you:** the `ha.*` entries are the FEDERATED tool names penumbra-mcp dynamically registers from the daemon's mcpPool — they MUST be in this proxy's allowlist or the model can't see them. Discovered via the `/long-lived/agents/<id>/federation-tools` daemon route (`packages/daemon/src/routes/long-lived-federation-tools.ts`) which returns `{server}.{tool}` names.
- `options.claudeCodeAllowedTools`: present but the proxy supersedes it for filtering. Left in place as defense-in-depth.

`daemon_reload_config` was called after each yaml edit to re-sync.

## Live verification (key data points)

- **Prefill**: 32,819 tokens (pre-fix, overflow) → ~17–20K stable (post-proxy)
- **Grammar surface**: 78,760 rule lines (pre-fix) → focused on the 8 allowed tools post-restart
- **GBNF parse errors**: hundreds in old log → zero on the b9108-75b2f820e binary
- **End-to-end tick on Qwen3-8B**: tick `37b23981` at 06:04 ran the full protocol and wrote `intent_summary: "no change since pulse 2026-05-14T22:30:00.007Z; no anomalies"` — that's the canonical short-circuit per the standing brief, proving ha_pulse + state_get + state_set all worked

The chain_start dispatch path was NOT exercised in the live test — Qwen3-8B correctly short-circuited on a clean pulse and never reached the escalation protocol. An `inject_goal` attempt to force the diagnostic path was ignored by the model.

## Live state at session end

- penumbra daemon: PID 87343, up
- penumbra worker: bootouted at end of session (intentional, to halt orphan retry storm)
- home-mgmt: **paused** (status: paused). Resume + tick to continue testing.
- mac-mini llama-server (Qwen3-8B): PID 865 on `b9108-75b2f820e` binary, ctx-size 65536 -np 2 = 32K/slot. Endpoint http://192.168.68.76:8090. Workload yaml at `templates/workloads/qwen3-8b-mac-mini.yaml` is the source of truth.
- ha-mcp upstream: spawned per-tick by the proxy via daemon's mcpPool. Many orphan ha-mcp instances are reparented to launchd (cosmetic clutter; not blocking).

## Adversarial reviews completed

- `b8faf93` (underscore refactor): HIGH actioned via `605b4e0`; MED+LOW declined for single-user codebase.
- llama.cpp `75b2f820e`: HIGH actioned via `ba90278ed`; MED `\d` inside `[...]` left as known gap.
- `7ef9684` (datetime drop): HIGH actioned via `c6b3ff7`; security clean.
- `56969ef` (proxy): HIGH+MED+LOW actioned via `3996502`; architectural premise declined.

The `cq:cq-reflect` / `superpowers:requesting-code-review` skills weren't used — relied on the project's `adversarial-review` workflow instead.

## Open follow-ups

1. **Exercise the chain_start dispatch path live.** The architecture is plumbed and verified through the short-circuit case. To prove home-mgmt → codex-acp-deep actually delivers a remediation plan: either (a) modify `home-mgmt.working_memory.last_pulse_id` to a stale value (forcing `snapshot_id != last_pulse_id` on the next pulse) — bypasses the short-circuit naturally; or (b) bring up Gemma 4 26B-A4B at :8181 as a temporary home-mgmt brain — bigger model is more responsive to `inject_goal` directives.

2. **Daemon-side orphan-tick retry-loop bug.** The stale-handoff-sweeper marks a handoff `failed` but does NOT terminate the in-flight subprocess OR prevent re-dispatch — observed multiple times this session (PIDs respawning every ~30s with the same `PENUMBRA_HANDOFF_ID`). Workaround is `long_lived_pause` + `launchctl bootout` of the worker. Real fix is in penumbra's stale-sweeper / worker dispatch reactor — find via grep for `stale_force_resolve`. Worth filing as a daemon bug.

3. **Tasks still pending in TaskList**: only #4 (launchd-respawn crash-loop log noise on mac-mini node-agent — log polish, not blocking).

4. **Cosmetic stragglers from underscore refactor**: ~50 dotted references remain in test name descriptions, code comments, and docs (e.g., `test('memory.search ...'` labels). All cosmetic; behavior unaffected; left as cosmetic follow-up sweep.

5. **The dispatched `cffc40ae` and `d7ad957e` handoffs** show `dispatched` status in DB without `completed_at` set — these are the orphan ticks. Stale-sweeper will eventually mark them failed; no action needed unless they're blocking future ticks (which they shouldn't with home-mgmt paused).

## Memories worth reading first

- **`project_qwen_tool_grammar_2026-05-15.md`** — the master memory for this whole investigation. Diagnosis of `\d`/grammar, allowlist mismatches, proxy design, federation discovery, and live verification. Read this first.
- **`project_home_mgmt_prefill_shrink_2026-05-15.md`** — the earlier session's `\d` and prefill investigation that this session built on.
- **`project_daemon_arg_dedup_2026-05-15.md`** — the May-14 daemon work that brought home-mgmt under daemon-managed dispatch in the first place.
- **`reference_llamacpp_mtp_binaries.md`** — which binary for which model; the atomic-fork is now at `frozename/atomic-llama-cpp-turboquant@ba90278ed`.
- **`reference_penumbra_dispatch_routing.md`** — how `chain_start` resolves repo context when called from a non-penumbra cwd.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Bring worker back up: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.penumbra.worker.plist && sleep 5 && pgrep -lf agentchat-worker`
4. To resume the chain_start dispatch test: either modify `home-mgmt.working_memory.last_pulse_id` (via long_lived_state_set with an old date) OR swap home-mgmt's `ANTHROPIC_BASE_URL` to gemma4-26b-a4b at `http://127.0.0.1:8181` for a stronger model, then `mcp__penumbra__long_lived_resume id=home-mgmt && mcp__penumbra__long_lived_tick id=home-mgmt`.
5. To pick up the unrelated launchd-noise polish (task #4): `ssh macmini.ai "launchctl list | grep llamactl"` to look at the crash-loop pattern, then either widen `agent.ts`'s port-conflict catch or add a launchd-friendly singleton lock.
