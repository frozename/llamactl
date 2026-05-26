# Maestro continuation prompt — 2026-05-24 pm

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

**Execute the First moves checklist (section 6) immediately in efficient order — batch independent calls in parallel — without asking permission per item.** The user has pre-authorized it. Only pause on items with user-visible blast radius (push, dispatch_land, restart hosted services, external messages) or genuine ambiguity.

## TL;DR

Long session that cleared all 4 items on the prior handoff's deferred list AND ran two full 8-persona adversarial reviews against the resulting diff, actioning every HIGH/MED finding plus most low-priority cleanups. **12 commits on `main`**, all pushed to origin. Bun-test-runnable failures across the repo went from **17 → 0**. Both fleet supervisors are now symmetric (`--auto --severity-threshold=2`, hysteresis active, observability + audit-reader surfaces live).

## What this session shipped

| Commit | Origin | Notes |
|---|---|---|
| `8f06d60` feat(fleet-supervisor,mcp): pressure-status observability | dispatched gemini-acp-pro (18m, STANDARD) | Slice 1 — new `fleet-pressure-status` journal entry every Nth tick while HIGH; `llamactl supervisor status` CLI; `llamactl_fleet_supervisor_status` MCP tool; shared `status-reader.ts` helper |
| `444f160` feat(fleet-supervisor,mcp): audit-trail reader | dispatched gemini-acp-pro (31m, STANDARD) | Slice 2 — mirrors slice 1; reads `~/.llamactl/fleet-supervisor/audit.jsonl`; `llamactl supervisor audit` + `llamactl_fleet_supervisor_audit` MCP tool |
| `fe7962a` chore(launchd): mac-mini plist — enable --auto --severity-threshold=2 | hand-coded | One-line plist mirror of M4 Pro's `d75ebe6` |
| `17412cd` fix(mcp): defer CLI_BIN_PATH check until tool invocation | hand-coded | Discovered while redeploying mini — top-level `existsSync(CLI_BIN_PATH)` threw under `bun build --compile` because `import.meta.url` resolves to `/` in the bundled binary. Lazy `ensureCliBin()` helper now fires only when `admit measure` / `supervisor tick` actually shell out |
| `c58c312` docs(mcp): llamactl_fleet_pressure — describe both pressure + pressure-cleared signals | hand-coded | Description-string rot; behavior fix had landed in `a90c58b` prior session |
| `501a72e` fix(fleet-supervisor,mcp,cli): adversarial-review correctness pass | dispatched gemini-acp-pro (25m, STANDARD) | Review #1 A1-A7 + A11 — `--node` filter no longer dead; async streaming `readAuditEntries`; same-tick HIGH-entry pressure-status emit; journal-rotation resilience; `state.recent.reverse()` mutation; clamp negative `durationMs`; unused import + JSDoc fixes |
| `08ea13d` refactor(fleet-supervisor,mcp,cli): API hygiene | dispatched gemini-acp-pro (21m, STANDARD) | Review #1 A8/A9/A12 — `NodePressureStatus.node → name`; `sinceIsoTs → since`; `--audit → --audit-path`; new `--clear-ticks` flag; MCP tools `llamactl_fleet_supervisor_status → llamactl_fleet_pressure_status`, `llamactl_fleet_supervisor_audit → llamactl_fleet_audit` |
| `024f0ee` test(fleet-supervisor): expand status-reader + audit-reader coverage | dispatched gemini-acp-pro (5m, STANDARD) | Review #1 A10 — 12 new tests covering pressure-cleared, node filter, malformed lines, limit caps, recent-order, defensive-copy, durationMs clamp, missing-file, malformedLines counter, large-journal streaming |
| `231f90c` fix(fleet-supervisor,mcp,cli): adversarial-review batch 2 | dispatched gemini-acp-pro (12m, STANDARD) | Review #2 A1-A4, A7-A9 — `firstNode.node → .name` (silently-failing CLI test), sort-once audit reader (algorithmic regression fix), `status.ts > lastTransitionTs` (was comparing wrong field), `Date.parse` `since` filter, `llamactl_fleet_pressure` emits `name`, magic `5` → `DEFAULT_PRESSURE_THRESHOLDS.clearTicks`, cosmetic batch |
| `21649ad` fix(eval,remote): unbreak 6 pre-existing test failures | dispatched gemini-acp-pro (23m, STANDARD debug_diagnose) | Pre-existing test drift: omlx env wiring (also fixed `packages/eval/src/matrix/lifecycle.ts` to inherit process.env into `EngineBootEnv` — production fix masquerading as test fix), `LLAMACTL_CONFIG` test pollution, mock contracts, error-msg drift |
| `535eb47` chore(mcp,cli,fleet-supervisor): defensive aliases + JSDoc | dispatched codex-acp-spark (2m 32s, STANDARD) | Review #2 deferred F4/F5/F9/F18/F20 — old MCP tool names registered as one-time-warn aliases delegating to renamed handlers; `--audit` deprecated alias for `--audit-path`; JSDoc on `since` + `limit` clamp |
| `80eac87` test(cli): expose-e2e — bind fake server to 127.0.0.1 instead of 0.0.0.0 | dispatched gemini-acp-pro (~30m wall + post-commit stall, STANDARD debug_diagnose) | Found 3× expose-e2e timeouts were the macOS firewall blocking 0.0.0.0 cross-process localhost connects. One-line fix; tests now run in 8s vs 3× 40s. Note: dispatch entered the documented post-commit stall (memory `reference_dispatch_stall_trap.md`); I cancelled and landed since the work was unambiguously complete |

Two full **8-persona adversarial reviews** ran this session (artifacts under `.penumbra/reviews/2026-05-23T15-03-54.850Z/` and `.penumbra/reviews/2026-05-23T16-40-46.548Z/`). Both verdicts: **Land with revisions**. All HIGH/MED findings actioned; declined items documented in respective commit messages.

## Live state

- **`m4-pro-local` supervisor** — PID `66976` (kickstarted ~17:20Z); runs from source via `bun packages/cli/src/bin.ts`. `--auto --severity-threshold=2`, `clearTicks=5` hysteresis.
- **`mac-mini-iso` supervisor** — PID `49388` (bootout+bootstrap then kickstart after binary rebuild); runs from compiled `~/.local/bin/llamactl-agent` (`bun build --compile`). Same flags.
- **Penumbra daemon** — restarted mid-session (PID 54600 then 91604 then 14340… check `launchctl list | grep penumbra` for current). **Worker had to be kicked once** (`launchctl kickstart -k gui/$(id -u)/dev.penumbra.worker`) after daemon restart because the registration handshake broke — symptom was `no_worker_registered` from the first adversarial-review fan-out.
- **llamactl MCP stdio child** — killed mid-session to force CC respawn with current code. Server description for `llamactl_fleet_pressure` now mentions both `pressure` + `pressure-cleared` signals as expected.
- **No active dispatches**, no pending handoffs.

## Open follow-ups

1. **C1 — merge `audit.jsonl` into journal** *(synthesis-deferred from review #1)*. Devil's-advocate argued the two-file split (`audit.jsonl` + `journal.jsonl`) is unnecessary; audit entries already use `kind:'mcp-audit'`, could flow into the main journal and be read via the existing `llamactl_fleet_journal_tail` with `kinds:['mcp-audit']`. Pure architectural cleanup; deletes `audit-reader.ts` + the `llamactl_fleet_audit` tool. Risk: changes file ownership/retention defaults. Concrete first step would be to make `appendAudit` write to journal path and gate behind a feature flag for one session.

2. **Slice 4 — raise M4 Pro `--severity-threshold` to 3.** Tier 2 = mark-degraded (auto-safe); Tier 3 = evict/restart (destructive, ~minutes of 35B reload). The original handoff asked for ~24h Tier-2 baseline before this; we enabled threshold-2 at `d75ebe6` on 2026-05-23 ~12:52Z, so 24h elapses around **2026-05-24 ~12:52Z**. Operator opt-in required for destructive auto-action.

3. **`bun test` repo-root noise — 7 failures in vendored / app surfaces.** All in `packages/app/test/stores/*` (zustand persist middleware; needs electron-mcp runner per memory `project_electron_mcp_strategic.md`) and `packages/train/vendor/llama.cpp/tools/server/webui/tests/*` (Playwright + Vitest-browser + svelte tests that can't run in bun harness). Fix is `bun test` config that excludes these paths. Cleanup-tier; doesn't gate anything.

4. **Pre-existing TS-only diagnostic** still mentioned in older handoffs (`fleet-write-tools.test.ts:115` `toSatisfy` generic mismatch) — investigated this session and could NOT reproduce in `bunx tsc -p packages/mcp/tsconfig.json --noEmit`. Phantom from editor LSP using a stricter config than the project's tsconfig. Tests green at 77/77. Safe to ignore; could close the carryover.

5. **`packages/mcp/dist/` staleness trap** — recurring this session. Worktrees inherit a stale compiled `dist/` from prior builds, causing `bun test` to silently run BOTH `.ts` and compiled `.js` versions and report inflated counts (e.g., "168 pass" instead of the real 84). After every `chain_start` that produces a worktree, my verification protocol now includes `rm -rf packages/mcp/dist`. Worth filing a `.gitignore` / build-hygiene fix to never check in or persist `dist/`.

6. **`dispatch_land` HTTP 409** still observed when landing via `mcp__penumbra__dispatch_land` from the home checkout. Memory `reference_dispatch_land_409_cross_repo.md` says FIXED in penumbra `67fdd5f0`, but I hit it again this session. Workaround: `git merge --ff-only agent/<handoff_id>` from home checkout. Worth re-investigating upstream.

## Memories worth reading

- `reference_dispatch_stall_trap.md` — codex-acp-fast (and gemini-acp-pro this session) can complete edits + commit + push, then never emit `dispatch.end`. Symptom: `chain_status` stays "dispatched" indefinitely. Diagnose via `chain_status.reliability.recommended_action`; mine said "wait" but commit was already on the branch. Cancel + land manually.
- `reference_extract_global_flags_trap.md` — `--node` and `--cluster-config` are consumed by `bin.ts:317` before subcommand parsers see them. Several findings this session traced to this trap; the fix is always `getGlobals().nodeName`, not redeclaring the flag.
- `reference_mac_mini_launchd_bun_env.md` — bun-under-launchd needs USER/TMPDIR/LANG explicitly in `EnvironmentVariables`; the M4 Pro plist runs from source but mini runs a compiled binary at `~/.local/bin/llamactl-agent` rebuilt via `tools/install-agent-macos.sh`.
- `project_supervisor_hysteresis_2026-05-23.md` — `clearTicks=5` is intentional; tests an exit-side counter symmetric with the entry-side window. Devil's-advocate F4 (review #1) framed this as a "lock under oscillation" but it's by design.
- `reference_adversarial_review_workflow_cwd.md` — penumbra@133bb12 ensures persona dispatches run in the target repo cwd. Verified working this session for both review fan-outs.

## First moves

1. ```
   git status --short && launchctl list | grep -E "penumbra|fleet-supervisor" && git log --oneline origin/main -5
   ```
2. `mcp__penumbra__handoff_list_pending` → confirm clean.
3. Spot-check both supervisors (parallel):
   ```
   pgrep -af "supervisor serve"
   tail -3 ~/DevStorage/fleet-supervisor/journal.jsonl
   tail -3 ~/.llamactl/fleet-supervisor/audit.jsonl
   ssh macmini.ai 'pgrep -af "supervisor serve"; tail -2 ~/.llamactl/fleet-supervisor/journal.jsonl'
   ```
4. Sanity test the new MCP surface:
   ```
   mcp__llamactl__llamactl_fleet_pressure_status({})        # new richer tool
   mcp__llamactl__llamactl_fleet_audit({limit: 5})          # new audit tool
   mcp__llamactl__llamactl_fleet_pressure({})               # transition-derived; should now emit `name` not `node`
   ```
5. Decide direction from the open follow-ups. Most actionable next:
   - **Slice 4** (operational, ~24h baseline reached around 12:52Z today)
   - **bun-test exclude-paths config** (5-min fix, removes 7 false-positive failures)
   - **C1 audit-into-journal** (architectural; needs design call before dispatch)

## Operational notes / gotchas surfaced this session

- **Worker re-registration after daemon restart**: `launchctl kickstart -k gui/$(id -u)/dev.penumbra.daemon` does NOT auto-rebind the worker. If the next `workflow_run` returns `no_worker_registered`, kickstart the worker: `launchctl kickstart -k gui/$(id -u)/dev.penumbra.worker`.
- **`launchctl kickstart -k` vs `bootout+bootstrap`**: kickstart restarts the process with the CURRENTLY-LOADED ProgramArguments — does NOT pick up plist edits. For new flags, you need `launchctl bootout gui/$(id -u)/<label>; sleep 3; launchctl bootstrap gui/$(id -u) <plist-path>`. Captured twice this session (mac-mini plist edit).
- **Mac-mini binary rebuild flow**: `ssh macmini.ai 'cd /Volumes/AI-DATA/repos/personal/llamactl && git pull --ff-only origin main && PATH=$HOME/.bun/bin:$PATH bash tools/install-agent-macos.sh && launchctl kickstart -k gui/$(id -u)/com.llamactl.fleet-supervisor'`. The `PATH=...` prefix is required — mini's launchd-spawned shell doesn't have `bun` in PATH.
- **bun test repo-root output capture quirk**: `bun test 2>&1 | grep "(fail)"` works on direct stdout but loses the `(fail)` markers when piped to `tee` or `>`. Use per-package runs (`bun run --cwd packages/<pkg> test`) for reliable per-test failure enumeration.

## Untracked-in-repo (intentional)

- `.claude/scheduled_tasks.lock` — session state
- `templates/workloads/stress-fleet-L-mac-mini.yaml.bak` — operational backup
- `docs/notes/maestro-continuation-2026-05-22-eve.md` and prior session notes
- `docs/notes/maestro-continuation-2026-05-23-{am,pm,eve}.md` — prior session
- `docs/notes/maestro-continuation-2026-05-24-pm.md` — this file
- `docs/notes/session-summary-*.md` — auto-generated

Nothing else uncommitted.
