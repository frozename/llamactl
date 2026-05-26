# Maestro continuation — 2026-05-26 am

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, no AI/tool attribution. Delegate coding via `chain_start`; hand-code only when the worker/daemon won't boot.

**Execute the First moves checklist (§5) immediately in efficient order, batching independent calls in parallel — don't ask permission per item.** Only pause for items with user-visible blast radius (push, dispatch_land, restart hosted services, external messages) or genuine ambiguity. The user authorized the checklist by handing it over.

---

## 1 — Where we ended (2026-05-26 ~04:00 UTC)

Long session, ~7 hours. Five tracks shipped and pushed to `origin/main`. Head is `1f032db`.

- **Track A — push & verify**: the 4 unpushed commits from the prior session (Phase 3 placement scheduler + Tier-A adversarial blockers + Bun fetch + kubeconfig refactor) cleared CI and reached origin. cli 389/0, fleet-supervisor 127/0, core 499/0, remote 1517/0; tsc all clean.
- **Track B — mac-mini agent refresh end-to-end**: built fresh `darwin-arm64` agent binary (64.5 MB) via `llamactl artifacts build-agent`, scp'd to mac-mini. **Launchd KeepAlive respawn hangs in main-thread JS** without binding to :7843 — even with all plist env vars (HOME/USER/LANG/TMPDIR/PATH-with-bun-bin) present. Same symptom on the rolled-back .previous binary; manual ssh-launched start with identical env works fine. Workaround: `launchctl disable + bootout` + manual `nohup` start. Also discovered + saved: `defaultFleetJournalPath()` reads `DEV_STORAGE` → agent and supervisor disagree on journal path when only one process has the env var. Fix on mac-mini: start agent without DEV_STORAGE. `llamactl fleet snapshot --all` now returns both nodes. Both bugs in `[[reference-launchd-respawn-bun-compiled-hang-2026-05-25]]` and `[[project-fleet-journal-dev-storage-bug-2026-05-25]]`.
- **Track C — Phase 5 (infra rollout)**: dispatched `claude-acp-sonnet`, landed `0ffbb87` + `423d005` + `a3e98bf` (alias-import cleanup). New `packages/remote/src/client/infra-client.ts` + `packages/fleet-supervisor/src/infra-rollout.ts` (`planRollout` + `healthGate`, pure/injectable). New `infra rollout/rollback` CLI subcommands. 7 targeted tests green (T1-T5 + T1-T2). Worker initially used relative cross-package imports because of a worktree symlink quirk (worktree's `packages/*/node_modules` is a symlink back to main's `node_modules`); cleaned up post-land.
- **Track D — Phase 4 (gated migration) + 8-persona adversarial review**: landed `b983cd9..ffa0b1f` (3 commits, same subject — agent iterated). 16/16 tests (T1-T11 + C1-C5). MCP fleet enum extended for `fleet-move` (`cbd19f6`). Drive-by `modelhost.ts` env-coalesce was scope violation — reverted in `4641664`. **Synthesis verdict: "Land with revisions" — 4 HIGH blockers must be fixed before flipping `LLAMACTL_FLEET_MOVE_ENABLED=1`.** Full review at `.penumbra/reviews/2026-05-26T02-07-06.869Z/synthesis.md` (8 personas, 42 findings, 12 ranked Actions).
- **Track E — fix F1, F2, F4 of the Phase 4 review**: landed `1f032db`. F1 try/catch around apply+delete with `fleet-execution status:'failed'` on RPC error, `markMoveInFlight` moved post-success. F2 wall-clock sticky (`getNowMs() - movedAtMs < stickyWindowMs`, default 5 min) replacing the tick-based foot-gun. F4 `Promise.allSettled` peer fan-out + `pendingWorkloads:Set` debounce. 148/0 fleet-supervisor, 1519/0 remote on main. **F3 still open** — dispatch ran out of time on the supervisor-loop wiring; its `e4dc497` attempt (broken test + tsc error) was reset away.

## 2 — Live runtime state at session end

| process | PID | role |
|---|---|---|
| `mlx-qwen36-35b-a3b-local` :8096 | 23766 | oMLX mcr=4 + slot v2 + slot-save-path `/Volumes/WorkSSD/cache/omlx-qwen36-35b-slots` |
| `granite41-3b-long-lived-local` :8083 | 72925 | llama.cpp granite-3b-Q8 long-lived |
| llamactl proxy :7944 | 38513 | serves both local models + peer-routes to mac-mini |
| llamactl controller | 93358 | reconciler |
| llamactl fleet-supervisor | 15856 | freshly bootstrapped plist (F3 wiring not yet active) |
| penumbra daemon / worker | 18177 / 21003 | `PENUMBRA_JUDGE_BASE_URL=http://127.0.0.1:7944` |
| mac-mini :7843 agent | 33498 | NEW build (sha256 `558bbe5e5fe0…`), manually nohup-started (NOT under launchd because of the respawn hang) |
| mac-mini :8194-:8196 | (remote) | granite-3b / granite-8b / qwen3-8b oMLX hosts |

`llamactl fleet snapshot --all` at session end: m4-pro-local 119 MB / mac-mini 493 MB, both HIGH. Genuinely full — both boxes at memory ceiling, not Phase 4 noise.

**Mac-mini agent is detached from launchd.** Will not survive a mac-mini reboot. If the box reboots, the agent must be re-launched manually with the recipe in §4 OR the launchd respawn hang must be root-caused first.

## 3 — Open follow-ups (priority order)

### A) F3 — wire `createMigrationController` into `startSupervisorLoop` (Task #6 in this session)

`LLAMACTL_FLEET_MOVE_ENABLED=1` still does NOT alter runtime behavior. `createMigrationController` + `readSchedulerLease` are exported (`packages/fleet-supervisor/src/index.ts:25`) but have zero non-test call sites. Synthesis Action 5 has the exact spec.

The previous dispatch attempt (`e4dc497`, reset away) added 66 lines to `loop.ts` and an integration test (130 lines), but the test failed (no `fleet-proposal{action.type:'move'}` emitted on pressure flip) and a `loop.ts:145` tsc error surfaced (`fetchSnapshot` truthy-check on always-defined function — narrowing artifact).

Worth a fresh dispatch with a tighter prompt that:
- Only adds the loop wiring (no controller-internal refactor).
- Uses `bun:test`'s `mock.module` for kubeconfig + peers imports.
- Wires `applyWorkload`/`deleteWorkload` as optional (treats absence as `destination_lost`) — Phase 5 client + future workload-RPC client can fill in later.
- Restates Action 5 verbatim and the integration-test contract.

### B) Remaining MEDIUM/LOW findings from the Phase 4 review (post-ship cleanup batch, synthesis Action 12)

Batch into one follow-up commit when convenient. F6 (`new Date(expiresAt).getTime()` returns NaN → bypasses TTL), F13 (non-finite `free_mb` passes viability), F12 (`subjectKind` not gated in `onJournalEntry` — workload-level transitions can trigger migration), F14 (`inFlightMoves` Map lost on supervisor restart), F17 (regression tests assert literal constants not behavior), F8 (lease in static config is semantically wrong for a runtime-elected lock), F11 (`readSchedulerLease` does disk I/O per supervisor tick when config not threaded), naming fixes (F15/F16/F25/F27/F28). Full list at `.penumbra/reviews/2026-05-26T02-07-06.869Z/synthesis.md` §"Severity-Ranked Findings".

### C) Mac-mini agent stability

Two options on next pickup:
1. **Root-cause the launchd-respawn hang.** Diagnose why `bun build --compile` agent binaries spin in JS main-thread under launchd KeepAlive respawn but work fine when manually invoked with identical env. Sample stack shows `0x328b324` ↔ `0x328c85c` recursion deep in V8/JSC. dtruss capture in the first few seconds may surface the syscall it's blocked on. Memory: `[[reference-launchd-respawn-bun-compiled-hang-2026-05-25]]`.
2. **Stand up the live Phase 4 canary** — only after F3 lands. Set `LLAMACTL_FLEET_MOVE_ENABLED=1` on M4 Pro's `com.llamactl.fleet-supervisor`, stress M4 RAM to HIGH, observe `llamactl fleet journal-tail --type fleet-move` for a real move proposal. Requires explicit user co-pilot since it triggers real fleet moves.

### D) modelhost env-coalesce — needed separately?

The reverted `modelhost.ts` hunk added `LLAMACTL_MODELS_DIR ?? resolved.LLAMA_CPP_MODELS` fallbacks. Three personas flagged it as scope violation (no motivation in this diff). If the fallback IS needed for some live use case, land it as its own commit with an absent-env-var test.

### E) Working-tree untracked notes/benchmarks (parked, as before)

Many untracked `docs/notes/maestro-continuation-*.md`, `docs/notes/session-summary-*.md`, `docs/benchmarks/2026-05-24-*.md`, `docs/specs/2026-05-24-anthropic-endpoint-and-kvcache*.md`. User hasn't asked to clean; leave alone.

## 4 — Conventions (carry over)

- Delegate substantive code via `chain_start`. Hand-implement only when the worker/daemon won't boot or after a dispatch failure where the gap is small.
- Penumbra MCP for state; never query the live sqlite DB directly except for forensics.
- Search memory (`mcp__penumbra__memory_search`) before non-trivial work.
- Repo text (commits, PR descriptions) is neutral; no AI/tool authorship attribution.
- Production oMLX is `mlx-qwen36-35b-a3b-local` :8096 (mcr=4 + slot v2 + slot-save-path).
- All penumbra local-model traffic flows through the llamactl proxy at `http://127.0.0.1:7944`.
- `bun run typecheck` is a silent-pass no-op. Use real `bunx tsc -p <pkg>/tsconfig.json --noEmit`.
- **Worktree-symlink quirk**: a dispatch's worktree has `packages/*/node_modules` symlinked back to main's `node_modules`, so cross-package imports during worktree-local `tsc -p packages/cli` resolve to **main's** source — false-positive "no exported member" warnings on new exports. Per-package tsc inside the worktree is reliable; cross-package validation happens post-land.
- `dispatch_land --mode=ff` is fine for our linear commit history. `stale_force_resolve` status does NOT roll back the worktree commit — always `git log` the worktree before assuming nothing landed.
- `launchctl kickstart -k` does NOT reload a plist (plist file change is invisible). Use `bootout + bootstrap` when the plist file itself changed.
- **Mac-mini agent restart recipe** (until launchd hang is root-caused):
  ```bash
  ssh macmini.ai 'launchctl disable gui/$(id -u)/com.llamactl.agent && launchctl bootout gui/$(id -u)/com.llamactl.agent; pkill -9 -f "agent serve"; sleep 2; nohup env -i HOME=/Users/aimastermind LANG=en_US.UTF-8 USER=aimastermind TMPDIR=/var/folders/m3/qsxzqy9s6257l16y7m_c2nb00000gn/T/ LLAMA_CPP_MODELS=/Volumes/AI-MODELS/llama.cpp/models LLAMACTL_DISABLE_MDNS=1 PATH=/Users/aimastermind/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin /Users/aimastermind/.local/bin/llamactl-agent agent serve --dir=/Users/aimastermind/.llamactl-agent > ~/.llamactl-launchd-logs/agent-manual.out 2> ~/.llamactl-launchd-logs/agent-manual.err < /dev/null & disown'
  ```
  Do NOT set `DEV_STORAGE` in the agent env until the journal-path bug is fixed.

## 5 — First moves (next session)

1. **Parallel orientation:** `git status --short` + `git log --oneline origin/main..HEAD -8` + `mcp__penumbra__handoff_list_pending` + `mcp__penumbra__cost_quota_status` + `launchctl list | grep -E "(penumbra|llamactl)"` + `curl -s http://127.0.0.1:8096/v1/slots/capabilities` + `curl -s http://127.0.0.1:7944/v1/models | jq '.data[].id'` + `llamactl fleet snapshot --all`.
2. **Confirm mac-mini agent still up:** `ssh macmini.ai 'pgrep -fl "agent serve"; curl -ksw "HTTP %{http_code}\n" https://127.0.0.1:7843/healthz --max-time 3'`. If it died (mac-mini rebooted), restart with the recipe in §4.
3. **Decide direction with the user (priority order, pre-authorized in spirit):**
   - **F3 dispatch (Task #6)** — wire `createMigrationController` into `startSupervisorLoop`, fresh prompt referencing synthesis Action 5. Clean path forward. ~30-45 min.
   - **MEDIUM/LOW Phase 4 cleanup (Action 12)** — batch fix of F6/F12/F13/F14/F17/F8/F11 + renames. Splittable as "correctness pass" + "naming pass" if preferred. ~45-60 min.
   - **Live Phase 4 canary** — only after F3. Requires explicit user co-pilot.
   - **Launchd respawn hang diagnosis** — dtruss capture, root-cause Bun-compiled-under-launchd startup quirk.

---
