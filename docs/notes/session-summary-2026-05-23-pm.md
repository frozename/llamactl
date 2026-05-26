# Session summary — 2026-05-23 pm

Project: `llamactl`. Session started: `2026-05-23T13:08:03.510Z`.

## What was learned / observed

Recent t2 observations (promoted from this session's t0 events). Conventional-commit prefix on the matching commits below tells you whether each item was built (`feat:`), fixed (`fix:`), or refactored (`refactor:`).


- **Session 2026-05-23 pm-late: firecrawl fix + Antigravity cancel + WTB#6 verify + orphan retire + P1 dedup root-cause** — Continuation of 2026-05-23 pm session. Started on Antigravity ACP bridge planning (adversarial-plan fan-out at `.penumbra/reviews/2026-05-23T19-53-46.526Z/`); user cancelled mid-stream for ToS reasons. Pivoted to firecrawl cost-leak (user s

- **P1 dream dedup uses exact (title,body) match; semantically-equivalent maestro rollups bypass it** — `packages/daemon/src/dreaming/cycle.ts:198-216` dedups promotion candidates with `SELECT FROM t2_memories WHERE title=? AND body=?`. Exact-string match on body. Confirmed on 2026-05-23 by inspecting 3 rows with title='Agent branch naming co

- **Worker-token split-brain RESOLVED — stable workerId is live (was [[project_worker_token_rotation_split_brain_2026_05_22]** — Update to `[[project_worker_token_rotation_split_brain_2026_05_22]]` (memory_id e6073427-c8c6-49e9-be05-541c12c826f2).

**WTB #6 (stable workerId) is implemented and live as of 2026-05-22 12:21 UTC.**

Verified state 2026-05-23 pm:
- `~/.pe

- **Retired 187 synthetic-hash orphan t2 memories 2026-05-23** — Retired all 187 t2_memories rows under synthetic project hashes `991c9dfbd58ff7da:.` (170 rows) and `cda5c3ba20718a78:.` (17 rows) via `UPDATE t2_memories SET retired_at = now*1000 WHERE project_id IN (...) AND retired_at IS NULL`. 171 newl

- **projects.yaml: inline `# comment` after enum value gets included in the parsed string** — `~/.penumbra/projects.yaml`: writing `research_provider: off  # disabled pending fix` causes the project-registry loader to read the value as the literal string `off  # disabled pending fix` and reject it with `unsupported dreaming research

- **Brief: llamactl (d1b8b6bf)** — # Project Brief: llamactl

## Executive Summary
The `llamactl` project is currently focused on refining the engine registry and correcting synthetic data handling within the corpus. Recent work has established a robust Test-Driven Developme

- **Dream P5 research cache key mismatch bled Firecrawl credits every cycle (fixed 2026-05-23)** — Bug: `runP5Phase` in `packages/daemon/src/dreaming/research.ts` looked up `dream_research_cache` with `hashQuery(query, resolvedUrl)` where `resolvedUrl = urlFromPayload ?? query` (so for SEARCH actions, key = `hashQuery(query, query)`). On

- **Do not route penumbra through Antigravity via unofficial means** — User explicitly killed the Antigravity ACP bridge work on 2026-05-23 pm. Do not resurrect either the bundle-patch technique (`[[project_antigravity_acp_bridge_technique_2026_05_23]]`) or the agy --print shim approach unless one of these con

- **Antigravity ACP bridge plan synthesized; supersedes agy-acp-shim** — Synthesized from adversarial-plan fan-out (architect + simplifier + risk personas) at `.penumbra/reviews/2026-05-23T19-53-46.526Z/`. Canonical plan lives at `docs/superpowers/plans/2026-05-24-antigravity-acp-bridge-plan.md` (702 lines; arch

- **Next-session focus: implement Antigravity ACP bridge for Gemini 3.5 Flash + Claude 4.6** — Set by user at end of 2026-05-23 pm session after Phase 7 memory-redesign cutover completed.

**Goal**: unlock Gemini 3.5 Flash (currently only reachable via agy CLI, chat-only) AND Claude 4.6 (via Antigravity subscription) for the penumbra

- **SQLite UNIQUE treats NULL as distinct — use COALESCE in index expression to enforce uniqueness across nullable scope col** — **Trap**: SQLite UNIQUE constraints with a nullable column treat each NULL as distinct, so `UNIQUE(project_id, slug)` allows two `(NULL, 'same-slug')` rows to coexist. Standard advice (two indexes — one for non-NULL scope, one with `WHERE p

- **Penumbra t2 is the authoritative session-memory store; ~/.claude/projects/.../memory/ is archived** — The memory-redesign project Phases 1-7 (2026-05-23) replaced Claude Code's file-based auto-memory with penumbra-native t2 storage.

**Decision**: For the penumbra project, all new memories go to t2 via `mcp__penumbra__memory_write_t2` or `P

- **WorkflowCtx exposes storageRoot, not a services bag — open DB lazily from storageRoot** — When writing a ts-function workflow that needs to query the daemon DB, this is the canonical pattern.

**Rule**: Open the DB lazily from `ctx.storageRoot`. Do not reach for `ctx.services?.db` — it doesn't exist on the WorkflowCtx surface.



- **ts-function workflow returning string must use composedPrompt-style fallback, not JSON.stringify** — When writing or reviewing a workflow runtime change, this rule is load-bearing.

**Rule**: For ts-function workflows that return a string, the output-sink body must be `composedPrompt ?? (typeof runResult === 'string' ? runResult : JSON.str

- **second** — second body

- **updated title** — New body for [[livetest-write-1779563464-target]] only

- **stale-handoff-sweeper kills dispatches at 15 min** — The daemon's stale-handoff-sweeper at `packages/daemon/src/serve.ts:605` is configured with `staleAfterMs: 15 * 60_000`. Substantive dispatches to `codex-acp-deep` regularly take 15-25 minutes and get killed mid-flight. The agent's work sur

- **silent-failure-retry orphan pollutes local ports** — After `stale-handoff-sweeper` resolves a long dispatch as `stale_force_resolve`, the local penumbra orchestration spawns an opencode auto-retry tagged `[silent-failure-retry] retry_of=<original-handoff-id> prior_agent=<...>`. That process k

- **WorktreeManager — daemon and worker hold separate in-memory maps** — **The split brain:**
- `packages/daemon/src/serve.ts` constructs `services.worktreeManager` for the HTTP daemon process. Routes like `/worktrees/:id/glob` (Phase 1b.2), `/worktrees/:id` (worktree.inspect), and `/worktrees` (worktree.list) r

- **stale .js/.d.ts in packages/*/src/ shadow .ts at runtime** — If you edit a `.ts` file under `packages/*/src/` and a daemon restart doesn't pick up the change, look for a sibling `.js` (or `.d.ts`) in the same directory. They shouldn't exist — sources should compile to `dist/` per each package's tscon

- **workflow-run-untrusted-cwd-400** — When the user reports `workflow.<name> returned 404` from a session-handoff or similar workflow dispatch, the actual code is usually **HTTP 400 `untrusted_cwd`** from `packages/daemon/src/routes/workflows.ts:127` `resolveWorkflowScopeOrReje

- **project-workflow-run-mcp-timeout-completes-server-side** — `mcp__penumbra__workflow_run` is synchronous over MCP (`packages/mcp/src/tools/workflow-run.ts:63` awaits `daemon.workflowRun`). Fan-out workflows like `/adversarial-plan` (5 personas + synthesizer) take 3-6 min, well past the MCP client ti

- **project-workflow-lifecycle-trigger-architecture-2026-05-23** — The lifecycle flow:
1. `~/.claude/settings.json` SessionStart (and PreToolUse, UserPromptSubmit, etc.) hooks run `PENUMBRA_STORAGE_ROOT=... penumbra hook claude-code` — this is GENERIC, not event-specific.
2. The hook forwards the event to 

- **project-worker-token-rotation-split-brain-2026-05-22** — The GH #122 worker-token-binding plan deferred two design items to a follow-up: (1) the "split-brain workerId" observation, and (2) the rotation policy that addresses it. Documenting current state + proposed direction so the next person can

- **worker-reconcile-orphans-is-self-restart-only** — The HTTP route `POST /worker/reconcile-orphans` is **self-restart recovery only**: it calls `OrphanHandoffRecoveryService.runOnce(workerId)`, which sets `staleWorkerIds = [workerId]` — i.e., the caller's own worker_id. It then `listOrphaned

- **project-worker-launchd-graceful-exit-no-respawn** — `~/Library/LaunchAgents/dev.penumbra.worker.plist` declares:

```xml
<key>KeepAlive</key>
<dict>
  <key>SuccessfulExit</key>
  <false/>
  <key>Crashed</key>
  <true/>
</dict>
```

This means launchd respawns the worker **only on crashes**. 

- **Worker agentchat config cache is separate from daemon** — After adding/editing an agent in `~/.config/agentchat/agentchat.yaml`:

1. `mcp__penumbra__daemon_reload_config` reloads the daemon-side agentchat validation registry (so `chain_list_agents` and `maestro_capabilities` show the new agent).
2

- **uv-cache-layers-and-invalidation** — When `uvx --from <local-path>` is used to run a local package (e.g. the ha-mcp fork at `/Volumes/WorkSSD/repos/personal/ha-mcp`), uv layers caches in three places. `--refresh` only invalidates the metadata-resolution cache. The wheel-build 

- **Local-state usage poller never runs in production deployment** — The four local-state usage readers (`CodexRolloutReader`, `OpenCodeDbReader`, `ClaudeJsonlReader`, `ClaudeStatusLineBridge`) are wired into `startUsagePoller` at `packages/agentchat/bin/agentchat-worker.ts:1083-1097`. The startup is gated o

- **tick-gate-concurrency-race-fixed** — `packages/daemon/src/long-lived/tick-gate.ts:80-95` (createTickGate) is the
gate that decides whether a cron/event firing should spawn a tick or insert
a terminal `concurrency_skip` / `circuit_open` row. Pre-fix, it queried:

```sql
SELECT 


## Commits this session

```
80eac87 test(cli): expose-e2e -- bind fake server to 127.0.0.1 instead of 0.0.0.0
535eb47 chore(mcp,cli,fleet-supervisor): defensive aliases + JSDoc -- adversarial-review deferred items
21649ad fix(eval,remote): unbreak 6 pre-existing test failures -- env wiring, mock drift, error-msg drift
231f90c fix(fleet-supervisor,mcp,cli): adversarial-review batch 2 -- failing test, sort-once audit reader, status-merge ts comparison, identity key alignment, threshold default reference, cosmetic batch
024f0ee test(fleet-supervisor): expand status-reader + audit-reader coverage -- adversarial-review A10
08ea13d refactor(fleet-supervisor,mcp,cli): API hygiene -- rename status/audit fields, add --clear-ticks flag, fit MCP tool naming pattern
501a72e fix(fleet-supervisor,mcp,cli): adversarial-review correctness pass -- node filter, async audit reader, HIGH-entry status emit, mutation fix, journal-rotation resilience
c58c312 docs(mcp): llamactl_fleet_pressure -- describe both pressure + pressure-cleared signals
17412cd fix(mcp): defer CLI_BIN_PATH check until tool invocation -- unbreaks bun-compiled binaries
fe7962a chore(launchd): mac-mini plist -- enable --auto --severity-threshold=2
444f160 feat(fleet-supervisor,mcp): audit-trail reader -- CLI 'supervisor audit' + MCP read tool
8f06d60 feat(fleet-supervisor,mcp): pressure-status observability -- periodic journal entry + CLI status + MCP read tool
```

## Dispatch events


- 2026-05-23T13:16:25.928Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:16:26.429Z `agent.tool_call.failed` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:16:31.972Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:16:37.452Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:16:43.633Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:16:49.319Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:16:50.512Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:16:58.556Z `agent.tool_call.failed` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:17:10.401Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:17:22.739Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:17:28.227Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:17:29.470Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:17:40.767Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:17:42.606Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:17:43.663Z `agent.tool_call.failed` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:17:48.581Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:17:50.160Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:17:50.697Z `agent.tool_call.failed` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:17:57.180Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:18:35.290Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:18:43.371Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:19:03.521Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:19:09.846Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:19:10.656Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:19:16.892Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:19:26.688Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:19:28.857Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:19:32.955Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:19:39.313Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:19:41.908Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:19:48.063Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:20:05.395Z `claim` handoff `605e2194-4de3-460f-8f7a-cbdd41e03f4c`

- 2026-05-23T13:20:05.395Z `dispatch.start` handoff `605e2194-4de3-460f-8f7a-cbdd41e03f4c`

- 2026-05-23T13:20:05.407Z `acp.server.start` handoff `605e2194-4de3-460f-8f7a-cbdd41e03f4c`

- 2026-05-23T13:20:06.862Z `acp.session.start` handoff `605e2194-4de3-460f-8f7a-cbdd41e03f4c`

- 2026-05-23T13:20:09.520Z `agent.thought` handoff `890a214b-5914-4fd6-a0da-0b071bd211cd`

- 2026-05-23T13:20:09.707Z `agent.thought` handoff `605e2194-4de3-460f-8f7a-cbdd41e03f4c`

- 2026-05-23T13:20:09.707Z `agent.thought` handoff `605e2194-4de3-460f-8f7a-cbdd41e03f4c`


## Pending follow-ups



## Diff against main

```

```
