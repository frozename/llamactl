# Maestro continuation prompt — 2026-05-23 am

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## TL;DR of the last session

The four deferred fleet-supervisor follow-ons from the prior session all landed. Eight commits total. Items 2-4 went via sequential `chain_start` to `claude-acp-sonnet` (43 / 46 / 17 min wall, all terminated trustworthy=true, no cascade):

1. **launchd plist + `--node` fix** (`dbd41be`, hand-implemented). Per-node `LaunchAgent` for `llamactl supervisor serve`: M4 Pro variant installed + ticking; mac-mini variant in repo, not deployed. Bug fix: `--node=<n>` was being eaten by `extractGlobalFlags` at `bin.ts:317` before `parseFlags` saw it, so every prior invocation silently labelled journal entries `'local'`. Now reads `getGlobals().nodeName` post-parseFlags. **The LaunchAgent is still loaded and writing to the journal** — snapshot at 02:18 shows free_mb ~1800, compressor ~12300, both workloads reachable.

2. **Phase 8 executor — severity-gated** (`ebc2b1b` + `50933fb`). `runExecutor()` reads pending fleet-proposal entries, skips any already in fleet-execution (idempotency), tier-gates via `actionTier()` (mark-degraded=2, evict/restart=3), shells out to `setWorkloadEnabled` for evict/restart, emits `fleet-execution` entries. CLI: `--auto`, `--severity-threshold=<1|2|3>` (default 2), `--execute=<proposalId>`. Default behavior unchanged — propose-only unless flags set.

3. **Real-load admission probe** (`1d2daf5` + `4017b33` + `2d77172`). `llamactl admit measure <name>` launches the workload to a sandbox ephemeral port (≥18000), waits for `/health`, samples RSS via `ps -o rss= -p <pid>` every 5s for the steady-state window, writes `~/.llamactl/measured-memory.json` keyed by `modelPath::quant`. `admitWithLiveCheck` + `projectAdmissionHeadroom` prefer measured (1.05 bump) > declared (1.3 bump); decisions trace `source: 'measured' | 'declared'`. Catches the qwen3-8b-mac-mini 7-GiB-declared / 10-GiB-actual class of underestimate.

4. **MCP federation** (`bca9d28` + `8d078e8`). Five `llamactl_fleet_*` read-only tools in `packages/mcp/src/tools/fleet.ts`: `snapshot`, `pressure`, `proposals`, `executions`, `journal_tail`. Each handles missing journal + malformed lines gracefully. Wired into `server.ts` via `registerFleetTools`. **`bun install` was required on this checkout to wire the new `@llamactl/fleet-supervisor` workspace dep into `packages/mcp/node_modules/@llamactl/`.** Done in this session — verify with `ls packages/mcp/node_modules/@llamactl/ | grep fleet-supervisor`.

Also: a new memory entry landed — `reference_extract_global_flags_trap.md` (the `--node` global trap that bit the supervisor plist). Read it before adding any new subcommand flag.

## What's on main

```
8d078e8 feat(mcp): wire registerFleetTools into MCP server
bca9d28 feat(mcp): fleet-supervisor tools — snapshot, pressure, proposals, executions, journal-tail
2d77172 feat(cli): admit measure — RSS probe workload, cache peak, wire into admit
4017b33 feat(fleet-supervisor): wire measured peak into admission — source field + 1.05 bump
1d2daf5 feat(fleet-supervisor): measured-memory cache — read/write rssPeakMb by model key
50933fb feat(cli): supervisor --auto / --severity-threshold / --execute executor flags
ebc2b1b feat(fleet-supervisor): Phase 8 — severity-gated proposal executor
dbd41be feat(launchd): per-node fleet-supervisor LaunchAgent + --node label fix
208a039 fix(fleet-supervisor): adversarial-review findings batch       ← prior session boundary
```

All seven agent-authored commits are ff-merged from `agent/<handoff_id>` branches via `git merge --ff-only`. `dispatch_land` returned HTTP 409 / "not something we can merge" in each case — the daemon doesn't see the agent branches in its checkout. Worked around manually; worth a separate look later but did not block landing.

## Fleet state (live)

- **M4 Pro local**: oMLX 35B-A3B on :8096 (gains-host, mcr=4, thinking-off), llama-server granite-3b-Q8 on :8083 (long-lived judge), penumbra daemon PID 18617 (was 95212 at session start, restarted mid-session), penumbra worker PID 76942 (re-enabled at session start after the prior session's bootout), **LaunchAgent `com.llamactl.fleet-supervisor` PID 21833 ticking every 30s, propose-only**.
- **Mac-mini iso**: oMLX granite-3b-mlx :8194, granite-8b-nvfp4 :8195, qwen3-8b-mlx :8196. All mcr=4. **`scripts/launchd/com.llamactl.fleet-supervisor.mac-mini.plist` exists in repo but is NOT deployed** — requires `tools/install-agent-macos.sh` first + TCC Full Disk Access dance.
- **agentchat role pools** unchanged from prior session.

## Test counts (verified on main this session)

- `packages/fleet-supervisor` — 68/68
- `packages/mcp` — 58/58 (post `bun install`)
- `packages/cli` — 365/371 (3 pre-existing skips + 3 pre-existing `expose` timeouts; no regressions introduced)

## What's deferred

Original deferred list from the prior session is now empty. New follow-ons that surfaced this session:

1. **`dispatch_land` HTTP 409 / "not something we can merge"** — the daemon's checkout doesn't see `agent/<handoff_id>` branches created by worker dispatches. Manual `git merge --ff-only` works. Worth investigating: probably a worktree-discovery or daemon-cwd issue. Unrelated to the work being landed.

2. **Mac-mini plist deployment** — not done. Run `tools/install-agent-macos.sh` on the mini, grant Full Disk Access, copy the plist, bootstrap. The plist file in repo is correct; deployment is just the mac-mini-side dance.

3. **Supervisor pressure detection fired immediately on launchd load** — the first tick produced a `NORMAL→HIGH` transition + eviction proposal against `gains-host`. The signal is real (compressor_mb consistently ~12 GiB on this M4 Pro under normal use) but no further transitions have fired in the ~2h since (the SMA may be sitting at threshold). If the executor is turned on (`--auto` in the plist), default `--severity-threshold=2` would skip evict (Tier 3); only mark-degraded would auto-fire. Decide whether to raise the pressure threshold or just turn `--auto` on.

4. **MCP fleet tools are read-only** — no `llamactl_admit_measure` or `llamactl_supervisor_execute` write-side surface. Add when a maestro consumer actually wants it.

5. **`adversarial-plan` cascade trigger is still unknown** — prior session's note still stands. Watch for new runs via `sqlite3 ~/.penumbra/db.sqlite "SELECT id, workflow_name, status, started_at FROM workflow_runs WHERE status='running' ORDER BY started_at DESC LIMIT 10"`. Nothing currently running.

6. **The supervisor stderr log is empty** — `~/.llamactl/logs/fleet-supervisor.stderr.log` has zero bytes because the launched bun process writes its summary to stderr only on the first tick (when it succeeds, --quiet is off). No actual errors. Worth confirming `--quiet` isn't accidentally being inherited if logs go missing.

## Memory entries to read first

- `reference_extract_global_flags_trap.md` — `--node`/`--context`/`--cluster-config` are global flags consumed at `bin.ts:317`; subcommand-local parses for these names silently no-op. Read before adding any subcommand flag.
- `project_fleet_supervisor_landed_2026-05-22` — what the supervisor delivers + plan ref
- `project_dflash_long_gen_shelf_2026-05-22` — dflash decision-contract; don't re-bench unless workload shape changes
- `[mac-mini RAM admission underestimate 2026-05-17]` — the underlying class of issue the `admit measure` probe now catches

## First moves

1. `git status --short && launchctl list | grep -E "penumbra|fleet-supervisor" && git log --oneline origin/main -8`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Verify the LaunchAgent + worker are still running:
   ```
   pgrep -af agentchat-worker
   tail -2 /Users/acordeiro/DevStorage/fleet-supervisor/journal.jsonl
   ```
4. `mcp__penumbra__memory_search query="fleet-supervisor 2026-05-23"` to load any new memory entries.
5. Pick direction from the deferred list above. Likely candidates: (a) deploy mac-mini plist + run `admit measure` against its workloads to seed the memory cache; (b) investigate the `dispatch_land` 409; (c) write-side MCP tools.

## Operational notes

- **Three sequential `chain_start` dispatches to `claude-acp-sonnet` worked cleanly this session** — 43 / 46 / 17 min wall, all trustworthy=true. The agent handled the node_modules workspace-symlink-to-main-checkout quirk in items 2 and 3 by switching imports to relative paths (`../../../fleet-supervisor/src/<x>.js`). Item 4 worked around it by creating a symlink in the worktree's `packages/mcp/node_modules/@llamactl/`. On main, `bun install` was sufficient to fix the same quirk after item 4 landed.
- **The penumbra daemon restarted mid-session** (PID 95212 → 18617) for unclear reasons. Worker stayed up at 76942. No dispatches were lost; the restart happened between item 3 landing and item 4 dispatch.
- **Pre-existing diagnostic noise:** the IDE may flag `policy-degradation.test.ts` and `workload-probe-validation.test.ts` for missing `priority` field / fetch type narrowness, and `apply.ts` for an unused `sanitizeChildEnv` import. These are stale; the test runner is happy (68/68). Don't chase them unless you're touching the file.

## Untracked-in-repo (intentional)

- `.claude/scheduled_tasks.lock` — session state
- `templates/workloads/stress-fleet-L-mac-mini.yaml.bak` — operational backup
- `docs/notes/maestro-continuation-2026-05-22-eve.md` — prior session continuation
- `docs/notes/maestro-continuation-2026-05-23-am.md` — this file
- `docs/notes/session-summary-2026-05-23-am.md` — agent journaling artifact
- `docs/notes/session-summary-2026-05-22-pm.md` (modified) — prior session journal, mid-edit

Nothing else uncommitted.
