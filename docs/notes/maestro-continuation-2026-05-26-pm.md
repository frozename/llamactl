# Maestro continuation prompt — 2026-05-26 pm

> Paste this whole block into the next session as the kickoff message.

---

You are taking over as maestro in `/Volumes/WorkSSD/repos/personal/llamactl`.

If `AGENTS.md` is present in this repo, follow it. Use Penumbra MCP for chain state; do not query sqlite directly except for forensics. Keep commits and repo-facing text neutral, with no AI/tool attribution. Delegate coding work via `chain_start`; hand-code only when the worker/daemon won't boot.

## Recall summary

### Today's session memories


- `t2:55a26ea1-60a8-400c-9bed-47d7700aa2a5` — Phase 4 adversarial review status — fully resolved 2026-05-26 12:30 UTC (supersedes 2026-05-26 update)

- `t2:62762ca9-3465-45fc-9038-fba1950f30e3` — Phase 4 adversarial review status — 2026-05-26 update (supersedes 'all resolved')

- `t2:a392e643-9e15-45f9-9b57-932c8aaf8f85` — Phase 4 adversarial review — all findings resolved 2026-05-26

- `t2:201ea013-ec1d-4f29-a3d7-c8d85c0b8e9b` — Phase 4 fleet-supervisor migration controller — ALL defects resolved 2026-05-26

- `t2:ce535609-703b-4e57-bb7d-653b56168bb8` — Brief: llamactl (c942c5de)

- `t2:0b968e62-848f-4e3c-b65a-f1605438f809` — Brief: llamactl (9ca088fb)

- `t2:ddbec646-2f15-48d1-805f-4d83d1d80a59` — Session 2026-05-23 pm-late: firecrawl fix + Antigravity cancel + WTB#6 verify + orphan retire + P1 dedup root-cause

- `t2:37b2a27c-4057-47a8-8058-55f9dce95805` — P1 dream dedup uses exact (title,body) match; semantically-equivalent maestro rollups bypass it

- `t2:f8406883-e6f7-4ddb-8525-b594eff36f22` — Worker-token split-brain RESOLVED — stable workerId is live (was [[project_worker_token_rotation_split_brain_2026_05_22]

- `t2:d32c9ef2-21be-4876-9fde-adc5c0d3b43a` — Retired 187 synthetic-hash orphan t2 memories 2026-05-23

- `t2:4bd13e47-83b5-4dc6-85fd-f1f2b4b321ea` — projects.yaml: inline `# comment` after enum value gets included in the parsed string

- `t2:32f8932a-1f2a-4edd-af12-bd98380195e9` — Brief: llamactl (d1b8b6bf)


### Commits since midnight

```
a81385f fix(fleet-supervisor): F9 — executor skips expired fleet-proposal entries
11136d4 refactor(fleet-supervisor): migration controller naming + behavioral tests (F15-F28 + F17)
bb8a4c3 fix(fleet-supervisor): F8/F11/F14 — journal-backed scheduler lease + move durability
d8dda1e fix(fleet-supervisor): MEDIUM migration controller correctness pass (F6/F12/F13/F18)
118e1dd fix(fleet-supervisor): wire migration controller into supervisor loop (F3)
e1e8464 feat(fleet-supervisor): F3 — wire migration controller into supervisor loop
```

### Commit context (bodies)


**`a81385f1bd814b98e7da1f895383bdf406a12ff5`** — fix(fleet-supervisor): F9 — executor skips expired fleet-proposal entries

Action 8 from .penumbra/reviews/2026-05-26T02-07-06.869Z/synthesis.md.

runExecutor now parses FleetProposalEntry.expiresAt and emits a
fleet-execution{status:'skipped', reason:'expired'} entry without
invoking the action's side-effect path (disable/enable). Proposals
without expiresAt continue to execute under existing tier/auto rules.



**`11136d423fed14d07c7513a5c2e27d3ff048f581`** — refactor(fleet-supervisor): migration controller naming + behavioral tests (F15-F28 + F17)

Addressed synthesis Actions 11 and 12 from .penumbra/reviews/2026-05-26T02-07-06.869Z/synthesis.md.

Implemented: F15, F16, F17, F19, F20, F21, F24, F25, F26, F27, F28, and F30 verification no-op.

- F15: remapped peer snapshot snake_case memory fields to controller camelCase boundary in supervisor wiring.

- F16/F27/F28: renamed migration controller APIs and deps (move cooldown naming, deploy/remove workload verbs, markMoveInFlight signature).

- F19/F24/F25/F26: added policy defaults export, expiresAtMs in proposals, destination_unavailable status, and upgraded skipped-evict reason.

- F20: destination viability now enforces max(minDestinationFreeMb, workload memory hint) in evaluate and execute paths.

- F21: stopped emitting fleet-move entries, deprecated FleetMoveEntry, and updated journal move seeding to read fleet-proposal move entries.

- F17/F22/F23: replaced vacuous constant assertions with behavioral assertions, renamed mismatched test contracts, and added C1b positive-path execution coverage.



**`bb8a4c368bbf39ec254e15cd2ba7b4e37765bb89`** — fix(fleet-supervisor): F8/F11/F14 — journal-backed scheduler lease + move durability

Action 9 (F14): seed MigrationController in-flight stickiness from recent fleet-move journal entries via readRecentMoves during construction.

Action 7 (F8): introduce FleetLeaseElectionEntry (kind=fleet-lease-election) and journal-tail lease-holder resolution; remove schedulerLease from ClusterSchema.

Action 7 (F11): readSchedulerLease now requires journalPath and reads from the fleet journal; removed loadConfig fallback from lease resolution path.

Also extended MCP fleet journal-tail kind filter to include fleet-lease-election.

Synthesis reference: .penumbra/reviews/2026-05-26T02-07-06.869Z/synthesis.md (Actions 7 and 9).



**`d8dda1e1a43715a044ba32932eb5c5654e94dc76`** — fix(fleet-supervisor): MEDIUM migration controller correctness pass (F6/F12/F13/F18)

Phase 4 adversarial review MEDIUM batch (correctness slice):

- F6: executeMove guards expiresAt with Number.isFinite(Date.parse(...))
  so unparseable strings return 'timed_out' instead of bypassing the TTL
  check (NaN < nowMs is false).
- F12: onJournalEntry requires entry.subjectKind === 'node' before
  triggering migration evaluation, so workload-level fleet-transitions
  don't masquerade as node-pressure events.
- F13: evaluateMove + executeMove guard node_mem.free_mb with
  Number.isFinite; corrupted snapshots are now treated as not viable
  destinations instead of passing the headroom check.
- F18: isStickyWindowActive evicts the inFlightMoves entry once the
  window has elapsed, so the map doesn't accumulate dead entries over
  long-running supervisors.

Adds 5 regression tests in migration-controller.test.ts covering each
fix. Suite 156/0; tsc clean on fleet-supervisor.

Refs: .penumbra/reviews/2026-05-26T02-07-06.869Z/synthesis.md
(Actions 3, 9, 10)



**`118e1ddf45dc34c76ba203613178c1ae0b491bd0`** — fix(fleet-supervisor): wire migration controller into supervisor loop (F3)




**`e1e84649224db3f3c6dd3818beac0dfea583b3cd`** — feat(fleet-supervisor): F3 — wire migration controller into supervisor loop

Wire `createMigrationController` into the supervisor boot path behind
`LLAMACTL_FLEET_MOVE_ENABLED=1`. Per-tick journal processing now calls
`evaluateMove`/`executeMove` when the controller is non-null.

- `applyWorkload`/`deleteWorkload` made optional in controller deps;
  absence returns `destination_lost` without new RPC clients
- Integration tests (env ON / env OFF) added to migration-integration.test.ts

Closes F3 from the Phase 4 adversarial review.




### Diff against main

```

```

### Dispatch summaries this session


- `e68502dc-b499-48d2-9c98-681f9660eb83` → **gemini-acp-pro** [failed] — failures: ["cancel.dispatched","cancel.received"]

- `99abdaa8-360d-4a11-b215-a5c9fd923f56` → **claude-acp-sonnet** [failed] — failures: ["cancel.dispatched","cancel.received"]

- `c745845f-1672-4b7e-98a9-6419c18391b9` → **codex-acp-fast** [failed] — failures: ["cancel.dispatched","cancel.received"]

- `1a2f8388-63e9-46c8-a861-e87a71c94c29` → **home-mgmt** [failed] — failures: ["cancel.dispatched","cancel.received"]

- `16ddb7da-502b-4827-aa4b-2ebd219d6700` → **codex-acp-deep** [ok, 421s] — failures: ["agent.tool_call.failed"]

- `847711a4-53b4-47a4-8345-4c21751bb28c` → **codex-acp-deep** [ok, 238s] — failures: ["agent.tool_call.failed"]

- `338d023d-982b-4149-9fd8-0922b4745011` → **codex-acp-deep** [ok, 510s] — failures: ["agent.tool_call.failed"]


### Pending handoffs



## Next steps

Carry forward whatever the maestro had queued. Verify daemon/worker via `launchctl list | grep penumbra` and `mcp__penumbra__handoff_list_pending` before resuming work.

## First moves

1. `git status --short && launchctl list | grep penumbra && git log --oneline origin/main -5`
2. `mcp__penumbra__handoff_list_pending` → confirm clean
3. Decide direction with the user from any open work above.
