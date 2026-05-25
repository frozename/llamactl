---
run_ts: 2026-05-25T19:56:38.673Z
synthesis_handoff_id: badb48bb-3d2e-4016-83bf-8a34f0fe2061
topic: Fleet placement scheduler + cross-node observability + infra-push rollout. Reviewer focus: verify the proposed authority model and journal-additive integration with the recently-shipped fleet-supervisor (packages/fleet-supervisor/) introduces no conflicts. Specifically: per-node hysteresis (consecutiveTicks=3, clearTicks=5), proposal types (evict/restart/mark-degraded), and the 30s tick should remain unchanged. Flag any case where the placement scheduler's new proposal types (place/move/drain) could race with or invalidate supervisor state. Pay attention to phase sequencing — Phase 1 is the lowest-risk slice (cross-node routing via static cluster.yaml), Phase 4 (migration) is the highest-risk surface.
personas: architect, simplifier, test-first, risk, integration
persona_handoff_ids:
  architect: 1bc8e427-838a-4982-8945-a1e5e6ceb54d
  simplifier: 3ddee35a-5a11-4134-8985-d92272b3705b
  test-first: efa50807-d6c9-498f-99d9-1efafaf9a6ea
  risk: ca6db6ae-189b-49ae-9122-67f4ecb12581
  integration: c47e5ece-dd9c-4f3e-a3cc-3edd9923661a
---

Let me read the spec first to anchor the synthesis.Reading the key files directly.Now I have enough to synthesize. Here is the merged plan.

---

# Fleet Placement Scheduler — Merged TDD Plan

## Pre-synthesis: conflicts and resolutions

**C1 — Phase 0 numbering.** Architect and integration planners call the aggregator "Phase 0"; risk planner uses "Phase 0" for a journal-contract foundation pass; test-first and spec agree dispatch order is Phase 1 first. **Resolution:** use spec phase numbers for traceability; dispatch order is 1 → 0+2 → 3 → 4 → 5. Risk's journal-additive regression test (`journalSchema.test.ts`) is a *pre-condition* for Phase 3, not a phase of its own.

**C2 — `cluster.yaml` schema.** Architect wants `version:1 / nodes[local?] / schedulerLease`. Test-first/simplifier want `peers[]`. **Resolution:** use `peers[]` for Phases 1–3 (simpler, no `local` flag needed — daemon knows its own address); add `schedulerLease.holder` only when Phase 4 ships. No `version` field until there is a breaking schema change.

**C3 — Aggregator process boundary.** Integration wants a new named daemon; architect wants a launchd-supervised CLI foreground process. **Resolution:** architect wins — CLI foreground supervised by launchd; avoids a third daemon process.

**C4 — Feature flags.** Risk and integration planners propose 6+ env vars. Simplifier says gate only the highest-risk slice. **Resolution:** only Phase 4 migration gets an explicit opt-in gate (`LLAMACTL_FLEET_MOVE_ENABLED=0`). Phases 1–3 and 5 are activated by config presence (`cluster.yaml`) or manifest opt-in (`spec.node: auto`); no flag needed.

**C5 — FLAG-A/B timing.** Architect flags `actionTier` exhaustiveness (FLAG-A) and `fleet_journal_tail` kinds enum (FLAG-B) as must-fix. **Resolution:** both are real bugs but are only triggered when `place/move/drain` land. Fix them in Phase 3 alongside the new action types, not before.

---

## Pre-step: `cluster.yaml` contract (no code, defines the schema all phases build on)

```yaml
# ~/.llamactl/cluster.yaml  (not in repo; document in README)
peers:
  - id: mac-mini
    endpoint: https://macmini.ai:7843
    caPemPath: ~/.llamactl/certs/mac-mini-ca.pem   # stable path; /tmp/ is OK locally
# Phase 4 only — added when migration ships:
# schedulerLease:
#   holder: m4pro
```

Rules: `peers` is empty-array if absent (aggregator boots without peers). No peer is "local" — the running node's own snapshot is always resolved locally. `/tmp/` CA paths are documented as acceptable but `~/.llamactl/certs/` is preferred for stability.

---

## Phase 1 — Static cross-node proxy routing

**Why first:** lowest risk, no new process, proves the cross-node HTTP path before anything depends on it.

### Failing tests

**`packages/core/test/clusterRoutes.test.ts`** (new):
```
T1: listClusterRoutes merges local routes + peer routes; peer routes have isPeer:true
T2: local route wins on model-id collision (deterministic local-first)
T3: peer in HIGH pressure state → excluded from result
T4: peer snapshot older than 30s → excluded (stale)
T5: listClusterRoutes returns empty array when peers map is empty
T6 (FLAG-C): isPeer:true route does NOT carry useProxy — assert the field is absent
```

**`packages/core/test/clusterConfig.test.ts`** (new):
```
T1: readClusterConfig parses peers + caPemPath
T2: readClusterConfig returns {peers:[]} when file absent (no throw)
T3: readClusterConfig throws on malformed YAML
```

**Extend `packages/core/test/openaiProxy.test.ts`** (existing):
```
T1: /v1/models response includes both local and peer model ids
T2: POST /v1/chat/completions routes to peer endpoint when model is peer-only
T3: POST /v1/chat/completions with x_omlx_request_handle on a peer route → HTTP 400 "cross-node slot ops not supported"
T4: peer returns 502 → proxy returns 502; route TTL invalidated (next request refetches peer state)
```

### New / changed files

| File | Action |
|---|---|
| `packages/remote/src/config/cluster.ts` | **New.** `PeerNode`, `ClusterConfig`, `readClusterConfig(path?)` |
| `packages/core/src/workloadRuntime.ts` | **Extend.** Add `ClusterRoute = WorkloadRoute \| (WorkloadRoute & {isPeer:true; peerEndpoint:string; peerCaPemPath?:string; targetNodeId:string})`. Add `listClusterRoutes(local, peerSnapshots, config)` pure function |
| `packages/core/src/openaiProxy.ts` | **Extend.** After route lookup, branch on `isPeer`. Forward via `fetch` + CA agent from `peerCaPemPath`. 400 on `x_omlx_request_handle` + isPeer. 502 from peer → invalidate route cache entry |

`listLocalRoutes()` callers are unchanged — they continue to work. `listClusterRoutes` is a new, additive entrypoint.

### Verify

```bash
cd packages/core && bun test test/clusterRoutes.test.ts test/clusterConfig.test.ts test/openaiProxy.test.ts
# live (requires cluster.yaml present):
curl http://127.0.0.1:7944/v1/models | jq '.[].id'   # expect both nodes' models
```

### Daemon restart

Restart `llamactl-agent` on M4 only after merge (`launchctl kickstart -k gui/$(id -u)/ai.llamactl.agent`). Mac-mini is a passive peer in Phase 1.

---

## Phase 0+2 — Fleet aggregation + observability surface

**Pre-condition:** Phase 1 types (`PeerNode`, `ClusterConfig`, `ClusterRoute`) are merged.  
**Pre-condition before Phase 3:** `journalSchema.test.ts` must be green (see below).

### Failing tests

**`packages/fleet-supervisor/test/aggregator.test.ts`** (new):
```
T1: pollNow() populates cache for all peers via injected fetchFn
T2: on fetch error, prior snapshot is retained and marked stale
T3: getSnapshot(nodeId) returns null when fetchedAt > 90s ago (3 missed ticks)
T4: getAll() returns all known nodes including stale ones
T5: pollNow() resolves after fetching ALL peers, not just the first
T6: poll count does not exceed 1 per peer per 30s (assert call count via injected fetchFn)
```

**`packages/fleet-supervisor/test/fleetSnapshotRoute.test.ts`** (new):
```
T1: GET /v1/fleet/snapshot returns latest fleet-snapshot entry from journal, status 200
T2: GET /v1/fleet/snapshot returns 204 when no fleet-snapshot in journal
```

**`packages/fleet-supervisor/test/aggregatorDb.test.ts`** (new):
```
T1: writeSnapshot then getLatestPerNode returns the inserted row
T2: multiple upserts for same node: getLatestPerNode returns row with latest ts
T3: getHistoricalForNode filters by sinceTs, honors limit
T4: db dir is created on first open (mkdirSync)
```

**`packages/fleet-supervisor/test/journalSchema.test.ts`** (new — **must be green before Phase 3 ships**):
```
T1: existing fleet_snapshot MCP tool tolerates a 'fleet-placement' entry in journal (no throw, returns valid data)
T2: fleet_proposals MCP tool tolerates 'fleet-placement' entries (no throw)
T3: journal-tail CLI renders valid lines when unknown entry type present
```

**`packages/cli/test/fleet.test.ts`** (new):
```
T1: "fleet snapshot" prints local node's latest snapshot JSON
T2: "fleet snapshot --all" prints table: node | free_mb | compressor_mb | workloads | pressure
T3: "fleet status" prints one summary line per node
```

### New / changed files

| File | Action |
|---|---|
| `packages/fleet-supervisor/src/aggregator.ts` | **New.** `FleetAggregator` class with `pollNow()`, `getSnapshot()`, `getAll()`, `start()→{stop()}`. `fetchSnapshot` is injected — no HTTP in the class itself |
| `packages/fleet-supervisor/src/peer-fetch.ts` | **New.** `createPeerFetch(peer: PeerNode)` wraps `https.Agent` with optional `ca` from `caPemPath`. Falls back to default agent when absent |
| `packages/fleet-supervisor/src/aggregator-db.ts` | **New.** `openAggregatorDb(path)`, `writeSnapshot()`, `getLatestPerNode()`, `getHistoricalForNode()`. Schema: `node_snapshots(node TEXT, ts TEXT, snapshot_json TEXT, PRIMARY KEY(node,ts))` |
| `packages/remote/src/routes/fleet.ts` | **Extend.** Add `GET /v1/fleet/snapshot` handler (reads journal tail, filters to `fleet-snapshot`, returns latest or 204) |
| `packages/cli/src/commands/fleet.ts` | **New.** `fleet snapshot [--all]`, `fleet status`. Calls `/v1/fleet/snapshot` on each peer from `cluster.yaml` (one-shot, no aggregator daemon needed for CLI) |
| `packages/mcp/src/tools/fleet.ts` | **Extend.** Add `all: z.boolean().optional()` to fleet snapshot tool; when true, return cluster view. Add `'fleet-placement'` to kinds enum (FLAG-B fix — preemptively, before the type exists, so existing readers never error) |

### Verify

```bash
bun test packages/fleet-supervisor/test/
bun test packages/cli/test/fleet.test.ts
# live:
llamactl fleet snapshot --all
curl http://127.0.0.1:7944/v1/fleet/snapshot | jq .type
# mac-mini:
curl https://macmini.ai:7843/v1/fleet/snapshot --cacert ~/.llamactl/certs/mac-mini-ca.pem | jq .type
```

### Daemon restart

Restart agent on **both nodes** (new `GET /v1/fleet/snapshot` route). Mac-mini: `ssh macmini.ai 'launchctl kickstart -k gui/$(id -u)/ai.llamactl.agent'`.

---

## Phase 3 — Apply-time placement scheduler

**Pre-condition:** Phase 0+2 aggregator cache shape is defined. `journalSchema.test.ts` must be green.

### Failing tests

**`packages/fleet-supervisor/test/placement.test.ts`** (new):
```
T1: HIGH-pressure node → disqualified (reason: 'pressure'), even with most free_mb
T2: null snapshot → disqualified (reason: 'no_telemetry')
T3: freeMb - expectedMb < headroomMin (512) → disqualified (reason: 'insufficient_headroom')
T4: two viable nodes → higher headroom wins
T5: tied headroom → lower compressorMb wins
T6: all nodes disqualified → chooseBestNode returns null
T7: scoreNodes returns ALL nodes (disqualified included) — full breakdown goes in journal
T8: modelFilePresent set → node NOT in set gets score penalty, not disqualification
```

**Extend workload apply tests** (existing file, add cases):
```
T1: spec.node absent → schedulePlacement() called; chosen node written to spec before apply
T2: spec.node: 'auto' → same as absent
T3: spec.node: 'mac-mini' (explicit) → schedulePlacement() NOT called
T4: spec.placement: 'pinned' → schedulePlacement() NOT called even if node is absent
T5: schedulePlacement returns null → apply fails with "no viable placement node"
T6: placement journal entry written with per-node scores on success
```

### New / changed files

| File | Action |
|---|---|
| `packages/fleet-supervisor/src/types.ts` | **Extend.** Add `NodeScore`, `PlacementDecision`, `FleetPlacementEntry`. Extend `FleetProposalAction` union with `place\|move\|drain`. Fix FLAG-A: update `actionTier` with explicit cases for new types |
| `packages/fleet-supervisor/src/placement.ts` | **New.** `scoreNodes(nodes, input, headroomMinMb=512): NodeScore[]` and `chooseBestNode(scores): string\|null`. Both pure functions — no IO |
| `packages/remote/src/workload/schema.ts` | **Extend.** `spec.node` accepts `'auto'` or specific node id. Add `spec.placement?: 'auto'\|'pinned'` (default `'auto'`) |
| `packages/cli/src/commands/workload.ts` or apply path | **Extend.** Before admit-check: if `spec.node` absent or `'auto'` and `spec.placement !== 'pinned'`, call `schedulePlacement()`, rewrite `spec.node` in-flight |

### Verify

```bash
bun test packages/fleet-supervisor/test/placement.test.ts
bun test packages/remote/test/workload-apply*.test.ts
bun run tsc -p tsconfig.json --noEmit   # type-check flag-A fix
# live:
llamactl apply -f templates/workloads/some-manifest.yaml   # manifest with spec.node: auto
llamactl fleet journal-tail --type fleet-placement | head -3
```

### Daemon restart

None — apply is a CLI path only.

---

## Phase 4 — Migration / event-driven rebalance

**Risk level: HIGH.** Gated behind `LLAMACTL_FLEET_MOVE_ENABLED=1` (default off). `cluster.yaml` gains `schedulerLease.holder` for this phase. Only the leaseholder emits `move` proposals.

### Failing tests

**`packages/fleet-supervisor/test/migration-controller.test.ts`** (new):
```
T1: evaluateMove returns null when not scheduler leaseholder
T2: evaluateMove returns null when workload is pinned
T3: evaluateMove returns null when sticky window active (< 10 ticks since last move)
T4: evaluateMove returns null when no viable destination node (all disqualified)
T5: evaluateMove returns MoveProposal with correct from/to when viable destination exists
T6: after markMoveInFlight, isStickyWindowActive returns true for stickyTicks
T7: executeMove writes fleet-execution {status:'skipped'} for original evict, then {status:'executed'} on success
T8: executeMove writes fleet-execution {status:'failed'} on move timeout, returns 'timed_out'
T9: destination headroom re-checked at execution time (C1 guard) — if headroom gone, fall back to original evict
T10: onJournalEntry triggers evaluateMove on NORMAL→HIGH pressure transition
T11 (regression): supervisor loop hysteresis counters are unchanged when fleet-placement entries appear in journal
```

**`packages/fleet-supervisor/test/arbitration-conflicts.test.ts`** (new):
```
C1: move supersedes evict only with fresh headroom proof (re-checked at execution)
C2: stale move proposal (ts + 30s < now) is not executed
C3: fleet-placement journal entries do not affect supervisor consecutiveTicks
C4: HIGH-pressure destination refused even if it was NORMAL at proposal time
C5: supervisor restart action never cross-calls schedulePlacement
```

### New / changed files

| File | Action |
|---|---|
| `packages/fleet-supervisor/src/migration-controller.ts` | **New.** `MigrationController` class. `evaluateMove()`, `markMoveInFlight()`, `isStickyWindowActive()`, `executeMove()` (make-before-break: launch on dest → health gate → evict source), `onJournalEntry()` |
| `cluster.yaml` | Add `schedulerLease: {holder: m4pro}` on leaseholder machine |
| `packages/fleet-supervisor/src/types.ts` | **Extend.** Add `FleetMoveEntry` journal type; add `expiresAt` to move proposals |

### Make-before-break protocol

```
1. Write fleet-execution {status:'skipped', proposalId: evictProposalId, reason:'move in flight'}
2. Write fleet-proposal {action:{type:'move',...}}
3. markMoveInFlight(workload, moveProposalId)
4. llamactl apply -f <manifest> --node <toNode>
5. Poll GET <toNode>/v1/fleet/snapshot until workload reachable=true (timeout: 300s)
6. If timeout: write fleet-execution {status:'failed'}; return 'timed_out'; fall back to original evict
7. llamactl workload delete <workload> --node <fromNode>
8. Write fleet-execution {status:'executed', action:{type:'move',...}}
```

### Verify

```bash
bun test packages/fleet-supervisor/test/migration-controller.test.ts
bun test packages/fleet-supervisor/test/arbitration-conflicts.test.ts
bun test packages/fleet-supervisor/  # full suite for regression
# canary (live, LLAMACTL_FLEET_MOVE_ENABLED=1):
# stress M4 RAM to HIGH, observe:
llamactl fleet journal-tail --type fleet-move
```

### Daemon restart

Restart `llamactl-agent` on leaseholder node only. Non-leaseholder nodes run aggregator in read-only mode — no restart needed.

---

## Phase 5 — Infra-push rollout orchestrator

**Depends on:** Phase 1 peer HTTP client; Phase 0+2 `/v1/fleet/snapshot` health signal.

### Failing tests

**`packages/cli/test/infraRollout.test.ts`** (new):
```
T1: one-at-a-time strategy: install→activate→health for node A completes before install on node B starts
T2: rollout halts at node B when health gate fails on node A; node B never touched
T3: --strategy=all fires all installs concurrently before any activates
T4: rollback calls activate(previousVersion) on each node
T5: orchestrating node appears last in the rollout sequence (self-last safety)
```

**`packages/remote/test/infraRolloutHealthGate.test.ts`** (new):
```
T1: healthGate resolves 'healthy' when all workloads reachable=true before timeout
T2: healthGate resolves 'timeout' after timeoutMs without full health
```

### New / changed files

| File | Action |
|---|---|
| `packages/cli/src/commands/infra.ts` | **Extend.** Add `rollout <pkg> --version <v> --tarball-url <url> --sha256 <hex> [--nodes <glob>] [--strategy one-at-a-time\|all]` and `rollback <pkg> [--nodes <glob>]` |
| `packages/remote/src/client/infra-client.ts` | **New.** `InfraClient` interface + `makeInfraClient(peer)`. `install()→POST /v1/infra/install`, `activate()→POST /v1/infra/activate`, `pollHealth()→polls /v1/fleet/snapshot` |
| `packages/fleet-supervisor/src/infra-rollout.ts` | **New.** `planRollout(config, strategy): RolloutStep[][]`, `healthGate(fetchSnapshot, timeoutMs, pollIntervalMs)`. Both pure/injectable — no HTTP in the logic |

### Verify

```bash
bun test packages/cli/test/infraRollout.test.ts
bun test packages/remote/test/infraRolloutHealthGate.test.ts
# dry-run live:
llamactl infra rollout llamactl-agent --version <v> --tarball-url <url> --sha256 <hex> \
  --nodes mac-mini --strategy one-at-a-time
```

### Daemon restart

Per-node restart is the point of `infra activate`. Orchestrating node rolls last by design.

---

## Cross-phase invariants (enforce in every PR review)

1. Supervisor loop constants unchanged: `consecutiveTicks=3`, `clearTicks=5`, `30s` tick — assert in `loop.test.ts`
2. Supervisor action domain unchanged: `evict|restart|mark-degraded` produced by supervisor only; scheduler produces `place|move|drain` only
3. Journal schema additive only: `journalSchema.test.ts` must stay green from Phase 0+2 onward
4. No cross-node slot ops: `x_omlx_request_handle` on peer route → 400
5. Pinned workloads not touched: `spec.placement: 'pinned'` bypasses both scheduler and migration controller

**Cross-repo gate after each phase** (per AGENTS.md):
```bash
bun test                             # llamactl
(cd ../nova && bun test)
(cd ../sirius-gateway && bun test)
(cd ../embersynth && bun test)
```

---

## Dispatch plan

| Dispatch | Phase | Task class | Notes |
|---|---|---|---|
| 1 | Phase 1 | `implement_substantial` | `use_worktree:false`, explicit `cd /Volumes/WorkSSD/repos/personal/llamactl` |
| 2 | Phase 0+2 | `implement_substantial` | Depends on Phase 1 types merged |
| 3 | Phase 3 | `implement_substantial` | journalSchema.test.ts must be green first |
| 4 | Phase 4 | `implement_substantial` | BOUNDARY review before land; adversarial review recommended |
| 5 | Phase 5 | `implement_small` | Composes Phase 1 peer HTTP + Phase 0+2 health signal |

---

## Trade-offs (what was cut and why)

- **`version: 1` in `cluster.yaml`**: cut. No breaking change anticipated in Phases 1–3; add on first breaking schema change.
- **Per-phase env flag proliferation** (risk+integration planners proposed 6+): kept only `LLAMACTL_FLEET_MOVE_ENABLED` for Phase 4. Other phases use config-presence or manifest opt-in as their gate — cleaner, no flag sprawl.
- **Inline CA in YAML**: cut. Key rotation would require YAML edits; `caPemPath` is the right boundary.
- **Separate `packages/fleet/` package** (integration planner suggested moving aggregator out of `fleet-supervisor`): cut. Adds a new package boundary with no immediate benefit; aggregator is a natural extension of fleet-supervisor.
- **`LLAMACTL_CLUSTER_CONFIG` env override**: cut from Phase 1. `readClusterConfig` accepts an optional path arg; callers supply it. Env var is a premature abstraction.
- **Multi-line CLI table formatting spec**: cut. Test asserts column presence; exact formatting is implementation detail.

## Open questions requiring user input before dispatch

1. **Does a `GET /v1/infra/install` endpoint already exist on the agent server**, or does Phase 5 need to add it? If it exists, confirm the request/response shape so `infra-client.ts` matches.
2. **Scheduler leaseholder election**: is `cluster.yaml: schedulerLease.holder` a static config decision (set once by operator), or should there be a failover mechanism when the leaseholder is unreachable? The plan assumes static for Phase 4; dynamic election is a Phase 4+ extension.
3. **`spec.node: auto` default**: should manifests with *no* `spec.node` field default to `auto` placement, or require explicit opt-in? Implicit auto is more ergonomic but could surprise users who expect single-node behavior.