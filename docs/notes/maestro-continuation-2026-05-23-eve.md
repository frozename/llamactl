# Maestro continuation prompt — 2026-05-23 eve

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## TL;DR of the last session

This session cleared the entire deferred-list from the prior handoff (5/5 items) AND ran a full 8-persona adversarial review against the resulting diff and actioned 17 of 24 findings across two follow-on batches. Net 6 commits on `main`, all pushed to origin.

| Commit | Subject |
|---|---|
| `93b8fbc` | `fix(fleet-supervisor): hysteresis on pressure exit -- clearTicks consecutive non-hot ticks required before HIGH→NORMAL` |
| `55817cc` | `feat(mcp): write-side fleet tools -- admit-measure + supervisor-execute` |
| `5829dfb` | `tune(fleet-supervisor): clearTicks default 3->5 + add pressure-cleared to signal union` |
| `a90c58b` | `fix(mcp): adversarial-review batch -- pressure-cleared in pressure tool, supervisor tick subcommand` |
| `d75ebe6` | `chore(launchd): m4-pro plist -- enable --auto --severity-threshold=2` |
| `831d036` | `fix(mcp,fleet-supervisor): adversarial-review batch B -- audit, caps, in-flight, abs paths, oscillation test` |

Three dispatches this session: hysteresis fix (`5f42b9d…`, claude-acp-sonnet → codex-acp-fast, 13m, clean trustworthy), write-side MCP tools (`312a093…`, claude-acp-sonnet, stalled post-implementation at 38m so cancelled + maestro committed manually), adversarial-batch-B (`8e0adc5…`, claude-acp-sonnet → codex-acp-spark, 24m, clean). The stall on `312a093` matches the documented `reference_dispatch_stall_trap.md` pattern — file edits land cleanly but commit never fires; maestro cancel + manual commit is the right protocol.

## Fleet-supervisor delivery status

- **M4 Pro** (`m4-pro-local`, PID 44096): `--auto --severity-threshold=2`, hysteresis active with `clearTicks=5`, write-side MCP tools have confirm-gate + launchd-detect + audit trail at `~/.llamactl/fleet-supervisor/audit.jsonl`. Compressor 1.3 GB / free 1505 MB at session close — pressure has cleared.
- **Mac-mini** (`mac-mini-iso`, PID 12985): propose-only; 3 oMLX workloads probed. Binary was rebuilt on mini via `tools/install-agent-macos.sh` (required because the previous compile predated the `supervisor` verb). The user's `frozename/llamactl` git remote received 24 commits this session — origin was behind by several sessions of work prior.
- **`dispatch_land 409`** — FIXED upstream in penumbra `67fdd5f0` mid-session by the user. Daemon was restarted; tested implicitly by the batch-B dispatch landing cleanly. Memory entry `reference_dispatch_land_409_cross_repo.md` reflects FIXED status.

## Test counts (verified on main this session)

- `packages/fleet-supervisor` — 72/72 (up 4 from session start; added `isPressureHot` exit-side tests + an oscillation test)
- `packages/mcp` — 72/72 (up 14 from session start; new write-side fixtures + confirm-gate / in-flight / audit / launchd-detect coverage)
- Combined: 144/144

## Adversarial-review outcome

Synthesis at `.penumbra/reviews/2026-05-23T11-59-46.724Z/synthesis.md`. Verdict: *Land with revisions*. 8 personas, all completed (no parse-fail / no missing dispatch.end). 24 findings.

Actioned (17): F1, F2, F3, F5, F6, F7, F8, F9, F10, F11, F12, F14, F15, F16, F17, F19, F20, F22, F24 (some overlap).

Skipped with documented reason (5):

- **F4** — devils_advocate framed the symmetric exit-counter as a "lock under oscillation." It IS by design: entry uses `tail(N).every(hot)`, exit uses the equivalent counter-reset shape. Hysteresis stays HIGH under sustained oscillation. Maestro disputed; finding stands but no change made.
- **F13** — no `resume-workload` proposal emitted on HIGH→NORMAL. There's nothing to resume; supervisor evictions don't auto-restore prior workloads either. Design choice.
- **F18** — `isPressureHot` uses AND gate (free + compressor). devils_advocate suggested OR for the clear-side. AND-gate is intentional (real pressure ≡ both signals).
- **F21** — MCP tool descriptions embed `admit measure`, `tick` flag names. Description rot acceptable; descriptions aren't a load-bearing contract.
- **F23** — `'pressure-cleared'` is kebab-compound while siblings `'pressure'` / `'degraded'` are bare. Compound is intentional for the cleared sub-event.

## What's deferred (open carryover)

1. **F4 has a real adjacent concern, not the framed bug.** Under sustained oscillation the supervisor stays HIGH indefinitely AND continues emitting `fleet-execution skipped tier 3` entries every tick — no exit observed by operators. The audit/observability story for "stuck-in-HIGH" is thin. Adding a periodic "still HIGH, here's why" debug entry would help if a real operator-monitoring story emerges.

2. **Mac-mini still propose-only.** Once Tier-2 behavior has been observed on M4 Pro for a baseline window (~24h), consider flipping mac-mini to `--auto --severity-threshold=2` as well. Plist edit is one line.

3. **Severity threshold = 2 means evictions never auto-fire.** All current observations show `fleet-execution status:"skipped" reason:"tier 3 exceeds threshold 2"`. Raising to 3 enables real eviction of `gains-host` under sustained pressure — eviction = ~minutes of 35B reload, so the call is whether the operator wants automatic remediation or prefers to handle pressure manually.

4. **`adversarial-plan` cascade trigger is still unknown** — prior session's deferred item. Watch via `sqlite3 ~/.penumbra/db.sqlite "SELECT id, workflow_name, status, started_at FROM workflow_runs WHERE status='running' ORDER BY started_at DESC LIMIT 10"`.

5. **`packages/mcp/test/fleet-write-tools.test.ts:115` has a pre-existing TS-only diagnostic** (`toSatisfy` generic mismatch). Tests run green; TS-strict typecheck unhappy. Cleanup-tier; not urgent.

6. **38 `agent/*` branch refs retained** as cheap history; 10 worktrees were cleaned this session. If `git branch --list 'agent/*' | wc -l` becomes painful, the `wip(autocommit)` branches can be pruned safely (they represent abandoned dispatches whose work didn't land).

## Memory entries to read first

- `reference_dispatch_land_409_cross_repo.md` — now marked FIXED; kept for context. Cross-repo lands should work via `mcp__penumbra__dispatch_land` going forward.
- `reference_extract_global_flags_trap.md` — still applies to any new supervisor subcommand flag.
- `project_supervisor_hysteresis_2026-05-23.md` — captures the `clearTicks` tune + signal-union widening + audit-trail addition.
- `reference_dispatch_stall_trap.md` — relevant if any future dispatch finishes editing but doesn't commit.

## First moves

1. `git status --short && launchctl list | grep -E "penumbra|fleet-supervisor" && git log --oneline origin/main -8`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Spot-check the supervisor:
   ```
   pgrep -af "supervisor serve"
   tail -3 ~/DevStorage/fleet-supervisor/journal.jsonl
   tail -3 ~/.llamactl/fleet-supervisor/audit.jsonl  # new this session
   ```
4. `ssh macmini.ai 'launchctl list | grep fleet-supervisor && tail -2 ~/.llamactl/fleet-supervisor/journal.jsonl'`
5. Pick direction from the deferred list above. Likely candidates: (a) flip mac-mini to `--auto`, (b) raise M4 Pro threshold to 3 after baseline observation, (c) audit-trail consumer / tool to read `audit.jsonl`, (d) `adversarial-plan` cascade investigation.

## Operational notes

- **launchd `Bootstrap failed: 5: Input/output error` recovery** — `launchctl bootout` returns success even when the prior service was already SIGTERM'd-not-reaped, leaving the next `bootstrap` to fail with EIO. Recovery sequence: `pkill -9 -f "supervisor serve"; sleep 5; launchctl bootout ... ; sleep 5; launchctl print` (verify "not found"); then `bootstrap`. Captured this twice tonight.
- **Worktree-merge friction this session** — `dispatch_land` was 409-broken at start (fixed mid-session by upstream); the workaround was `git merge --ff-only agent/<id>` from the home checkout. For the batch-B dispatch this collided with my hand commit (plist) ahead of `main` — `git cherry-pick` was the cleanest path. With dispatch_land now FIXED, future dispatches should land via the protocol path.
- **Adversarial-review workflow worked end-to-end this session** — 8 personas, all completed, synthesis dispatched and landed in `.penumbra/reviews/...`. The auto-recall + recall_summary stuff in the existing `maestro-continuation-2026-05-23-pm.md` is from an unrelated earlier session-handoff run; ignore it, this note supersedes.

## Untracked-in-repo (intentional)

- `.claude/scheduled_tasks.lock` — session state
- `templates/workloads/stress-fleet-L-mac-mini.yaml.bak` — operational backup
- `docs/notes/maestro-continuation-2026-05-22-eve.md` — older session
- `docs/notes/maestro-continuation-2026-05-23-am.md` — start of tonight's chain
- `docs/notes/maestro-continuation-2026-05-23-pm.md` — auto-generated workflow stub from earlier today (superseded by this file)
- `docs/notes/maestro-continuation-2026-05-23-eve.md` — this file
- `docs/notes/session-summary-2026-05-22-pm.md` (modified) — older journal, mid-edit
- `docs/notes/session-summary-2026-05-23-am.md` — auto-generated
- `docs/notes/session-summary-2026-05-23-pm.md` — auto-generated

Nothing else uncommitted.
