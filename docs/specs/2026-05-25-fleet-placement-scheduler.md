# Fleet placement scheduler + cross-node observability

Spec draft — 2026-05-25.
Author: maestro session.
Reviewers: TBD (run via `/adversarial-plan` against this file).

## 1 — Motivation

Today llamactl runs as a federation of independent nodes:

- Each node has its own llamactl-agent (`agent serve`) listening on a port (M4: `:7944` proxy, mac-mini: `:7843`).
- Each node has its own per-node `fleet-supervisor` (`packages/fleet-supervisor/`) doing per-node pressure detection + degradation tracking via `~/.llamactl/fleet-supervisor/journal.jsonl`.
- Workload manifests are placed by hand on a node (`/Users/<user>/DevStorage/workloads/*.yaml`) — there's no fleet-wide placement layer.
- The M4 proxy at `:7944` only exposes locally-hosted workloads. Mac-mini-hosted workloads (`mlx-granite-3b-iso-mac-mini`, `mlx-granite-8b-iso-mac-mini`, `mlx-qwen3-8b-iso-mac-mini`) are addressable only by hitting `:7843` directly with the self-signed CA pem. Penumbra's `bench-fleet.ts` / `bench-grade.ts` do this today.

Two user-named gaps drive this plan:

1. **Distribution + observability** (2026-05-25): "we should distribute workloads to all nodes" + "manage / observe nodes easily". The cluster is half-distributed by manifest but not at the routing or telemetry layer.
2. **Infra-push channel** (2026-05-25): "we need a way to easily push infra updates to nodes (llamactl, oMLX, llama.cpp, etc)". Today this is hand-rsync — mac-mini's `llamactl source at /Volumes/AI-DATA/repos/personal/llamactl (often stale)` per project memory.

These are connected: a placement layer needs accurate node telemetry; pushing infra updates needs a way to address all nodes and orchestrate rollouts.

## 2 — Existing surfaces this plan reuses

Read the actual code at:
- `packages/fleet-supervisor/src/types.ts` — `NodeMemSnapshot`, `WorkloadSnapshot`, journal entry types (`fleet-snapshot`, `fleet-proposal`, `fleet-transition`, `fleet-execution`, `fleet-heartbeat`, `fleet-pressure-status`).
- `packages/fleet-supervisor/src/loop.ts` — `startSupervisorLoop` per-node loop (interval 30s, hysteresis `consecutiveTicks=3` to enter HIGH, `clearTicks=5` to exit).
- `packages/fleet-supervisor/src/policy.ts` — pressure + degradation detection + proposal generation.
- `packages/fleet-supervisor/src/node-probe.ts` — `vm_stat` parser producing `NodeMemSnapshot`.
- `packages/fleet-supervisor/src/workload-probe.ts` — per-workload HTTP probe.
- `packages/core/src/workloadRuntime.ts` — `listLocalRoutes()` (proxy route table).
- `packages/cli/src/commands/supervisor.ts` — supervisor CLI entry.
- `packages/mcp/src/tools/fleet.ts` — MCP tools (`fleet_snapshot`, `fleet_pressure`, `fleet_supervisor_audit`, `fleet_proposals`, `fleet_executions`, `fleet_journal_tail`).
- `packages/cli/src/commands/admit*` — admission flow (apply-time RAM accounting).
- llamactl already has `llamactl infra install/activate/uninstall` (sha-verified tarballs + current-symlink flip). Reuse for the infra-push lane.

The plan does NOT replace any of this. It composes on top.

## 3 — Authority model — placement scheduler vs supervisor

This is the critical conflict surface. Reviewer focus when running the adversarial plan.

| Subject | Owner | Tick interval | Scope |
|---|---|---|---|
| Per-node pressure detection (HIGH/NORMAL) | per-node fleet-supervisor | 30s | one node |
| Per-workload health (healthy/degraded) | per-node fleet-supervisor | 30s | one node |
| L2/L3 proposals (`evict` / `restart` / `mark-degraded`) | per-node fleet-supervisor → controller executes | event-driven | one node |
| **New:** Cluster topology (which workloads on which node) | **placement scheduler** | apply-time + on-pressure | fleet-wide |
| **New:** Migration proposals (`place` / `move` / `drain`) | **placement scheduler** → emits via fleet journal | event-driven | fleet-wide |
| **New:** Cluster-wide telemetry aggregation | **fleet aggregator** (subset of placement scheduler) | 30s (passive) | fleet-wide |

**Authority rule (proposed):** the placement scheduler is the *only* layer that emits `place` / `move` / `drain` proposals. The per-node supervisor stays the only layer that emits `evict` / `restart` / `mark-degraded`. The two cooperate via shared journal events.

**Conflict cases:**

- C1. Node X supervisor declares HIGH pressure → emits `evict workload-Y` proposal. Placement scheduler sees the transition and, BEFORE the evict executes, evaluates whether moving Y to node Z (with headroom) is preferable. If yes, scheduler emits `move workload-Y X→Z` which the controller treats as higher-priority than `evict`. Hysteresis on X must NOT block the move — moves are out-of-band on hysteresis.
- C2. Both layers race on the same workload. Resolution: scheduler-emitted `move` supersedes supervisor-emitted `evict` only if the move's destination is verified to have headroom right now. Stale `move` proposals expire after one tick.
- C3. New workload apply: placement scheduler picks node Z based on free RAM + ggml backend match + model file presence. Node-Z supervisor wakes up at its next tick, sees the new workload via its standard probe path. Hysteresis is unaffected (this isn't a pressure event).
- C4. Apply during HIGH pressure on Z: scheduler MUST refuse to place onto a HIGH-pressure node. Falls back to next-best.
- C5. Per-workload `restartPolicy: Always` interaction: a controller restart triggered by crash should NOT trigger a re-placement decision. Only manifest changes + explicit `move` actions do.

## 4 — Phased plan

### Phase 0 — fleet-wide telemetry aggregation (foundation)

**Goal:** make a peer node's `NodeMemSnapshot` + `WorkloadSnapshot[]` readable from anywhere in the cluster.

- Add `GET /v1/fleet/snapshot` to llamactl-agent on every node — returns the latest local `FleetSnapshotEntry` from the journal (already produced by the supervisor every 30s).
- Add a `FleetAggregator` in `packages/fleet-supervisor/` (or a new `packages/fleet/`): polls each known peer's `/v1/fleet/snapshot` every 30s and caches the latest snapshot per node.
- Peer discovery: pull from `~/.llamactl/cluster.yaml` (single source of truth) OR mDNS browse for `_llamactl-agent._tcp.local.`. Pick one and stick with it — recommendation: `cluster.yaml` (explicit, no mDNS surprises). The proxy `:7944` and the aggregator both consume this file.
- Auth: mac-mini already serves with a self-signed CA pem at `/tmp/llamactl-mac-mini-ca.pem`. Pin per-node CAs in `cluster.yaml`. Bench scripts can then drop their hardcoded path.

Acceptance: `llamactl fleet snapshot --all` prints a table — one row per node, columns: free_mb / compressor_mb / workload count / pressure state. Polling SHALL NOT add load greater than 1 HTTP call / 30s / node.

Test surface: the aggregator is pure-function over a (snapshot, peer-list) pair. Use a fake peer-fetch in tests.

### Phase 1 — cross-node proxy routing

**Goal:** `:7944/v1/models` exposes ALL cluster-known model ids. POST to `/v1/chat/completions` with a peer-hosted model id transparently proxies to the peer.

- Extend `packages/core/src/workloadRuntime.ts:listLocalRoutes` → `listClusterRoutes(localRoutes, peerSnapshots)`. Merges remote workloads' model ids into the route table with a `target_node` field.
- Proxy request handler: if `target_node !== local`, forward the request to `peer.endpoint` (use the peer CA pem from `cluster.yaml`).
- Cache: TTL the peer snapshot lookup for 30s; on a 502 from the peer, invalidate immediately.
- Don't proxy slot v2 ops (`x_omlx_request_handle`) — those are per-instance and would corrupt cross-node restore. Reject with HTTP 400 + a clear error.

Acceptance: `curl -s http://127.0.0.1:7944/v1/models` lists both local and mac-mini-hosted models. A `POST /v1/chat/completions` with `model:"qwen3-8b-mlx"` from M4 returns the mac-mini response.

### Phase 2 — observability surface

**Goal:** humans (and the MCP) can see node + workload state at a glance.

- `llamactl fleet snapshot` — single-node JSON (already exists via the MCP; surface as a CLI command if missing).
- `llamactl fleet snapshot --all` — cluster table.
- `llamactl fleet status` — opinionated single-line summary per node ("M4 NORMAL 12.3 GB free / mac-mini HIGH 0.4 GB free, 2 workloads degraded").
- MCP tool `llamactl_fleet_snapshot` — already exists; extend to return the aggregator's cluster view.
- Persist the aggregator's recent observations to a small sqlite at `~/.llamactl/fleet/cluster.db` for time-series queries — keep schema dead-simple (one row per (node, ts)).

Acceptance: a one-line CLI command produces the cluster state. The MCP tool returns the same shape.

### Phase 3 — placement scheduler (apply-time)

**Goal:** `llamactl apply -f <manifest>` consults cluster state and picks the best node. Today the manifest pins `spec.node` by hand.

- Manifest extension: `spec.node` becomes optional. If absent or set to `auto`, the apply call runs the scheduler.
- Scheduler inputs: aggregator's latest snapshot per node, the manifest's resource requirements (`spec.resources.expectedMemoryGiB`), the model file presence on each node, the ggml/MLX backend availability.
- Scheduler scoring: rank nodes by `free_mb - expectedMemoryMb` (negatives disqualify), then by lower `compressor_mb`, then by lower `request_rate_5m` of existing workloads. Refuse to place on a node currently in HIGH pressure.
- Output: rewrites the manifest in-flight with the chosen `spec.node` and emits a `fleet-placement` journal entry. The rest of the apply path is unchanged.

Acceptance: apply a manifest with `spec.node: auto`. The journal shows the placement decision with a per-node score breakdown. The chosen node ends up running the workload.

### Phase 4 — migration / rebalance (event-driven)

**Goal:** workloads can move between nodes when pressure or efficiency demand it.

- New `FleetProposalAction` types: `place` (initial), `move` (cross-node), `drain` (per-node, evict everything before maintenance).
- Scheduler subscribes to the aggregator's `fleet-transition` events. When node X enters HIGH pressure AND another node Z has headroom for X's evict-candidate, propose `move` instead of letting the supervisor's `evict` proceed.
- Controller treats `move` as: launch on Z first, validate /health, then evict on X. (Make-before-break.)
- Two-tick stickiness: a workload that just moved is exempt from another move for `≥10 ticks` (5 minutes) to prevent ping-pong.
- Manifest-driven pinning: `spec.placement: pinned` opts a workload out of moves entirely.

Acceptance: trigger HIGH pressure on M4 with a memory-pressure burst. The scheduler emits `move <workload> M4→mac-mini`. Workload comes up on mac-mini, then is evicted on M4. End state: workload reachable via the proxy with no consumer-visible interruption.

### Phase 5 — infra-push channel

**Goal:** "push infra updates to nodes" — llamactl, oMLX, llama.cpp builds.

- llamactl already has `infra install --tarball-url --sha256` + `infra activate --version` + `current` symlink. Reuse this as the per-node primitive.
- Add a fleet-wide orchestrator: `llamactl infra rollout <pkg> --version <v> --tarball-url <url> --sha256 <hex> [--nodes <pattern>] [--strategy=one-at-a-time|all]`. Iterates over `cluster.yaml`, calls the per-node `infra install` + `infra activate` over the agent HTTP API, watches health, rolls forward.
- Health gate between nodes: after activating on node N, wait for `fleet-snapshot` to show all of N's workloads back to `reachable: true` before moving to node N+1.
- Rollback: keep the previous symlink target; `llamactl infra rollback <pkg> --nodes <pattern>` flips back.
- Out of scope for now: building tarballs (currently hand-built with `infra artifacts build-agent` for llamactl-agent only). Builds for oMLX and llama.cpp builds would be follow-up work.

Acceptance: bumping oMLX from v0.3.9rc1 to v0.3.9rc2 across both nodes is one command, observable via the journal.

## 5 — Why this won't conflict with the supervisor

Specific compatibility statements (each is a falsifiable reviewer check):

- **Pressure / degradation detection paths are unchanged.** Per-node supervisor still owns these. Placement scheduler only reads them.
- **The hysteresis windows (`consecutiveTicks=3`, `clearTicks=5`) are unchanged.** They prevent supervisor flap; the scheduler does not write to those state machines.
- **The supervisor's L2/L3 proposals (`evict`/`restart`/`mark-degraded`) are not removed.** They are the per-node fallback when no cross-node move is feasible.
- **The journal schema is additive.** New entries `fleet-placement` and new action types `place`/`move`/`drain` are appended; existing readers (MCP fleet tools, CLI) keep working.
- **The supervisor's per-tick budget is unchanged.** Aggregation polling is a separate process, not piggybacked onto the supervisor tick.
- **`spec.placement: pinned` honors operator intent.** Workloads not opted into auto-placement are inert relative to the scheduler.

## 6 — Open questions for reviewers

1. **Peer discovery (cluster.yaml vs mDNS):** is the explicit file right, or do we want mDNS browsing? Trade-off: explicit = no surprises but operator has to update on node add/remove; mDNS = zero-touch but spooky-action-at-distance.
2. **Where does the aggregator live — inside the per-node supervisor process, or a separate `llamactl fleet aggregator` daemon?** Cleaner to separate, but more processes to manage.
3. **Cluster CA management:** today mac-mini's CA pem lives at `/tmp/llamactl-mac-mini-ca.pem`. Should `cluster.yaml` distribute CAs inline, or point to per-node pem paths?
4. **Should `fleet-supervisor` learn to *consume* placement proposals (e.g. defer `evict` for 30s if a `move` is in flight), or is the controller the right place to arbitrate?**
5. **Sequencing of phases vs the user's named priorities:** is Phase 1 (cross-node routing) urgent enough to land standalone, before Phase 0 (aggregator) is fully built? Today the only consumer is bench scripts.

## 7 — Risk register

- **R1 — split brain on `move`:** if two scheduler instances run (e.g. on M4 and mac-mini), they could disagree. Fix: scheduler is singleton via a fleet-wide lease in `cluster.yaml` (lessee node = M4 by default).
- **R2 — ping-pong moves:** prevent via the two-tick stickiness rule in Phase 4.
- **R3 — auth-bypass surface in the proxy:** the proxy currently runs `--no-auth`. Cross-node forwarding will need a service token. Out of scope for Phase 1; document as a known weakness.
- **R4 — cluster.yaml + per-node mDNS divergence:** if both are used, picks must be consistent. Resolution: pick one (cluster.yaml proposed) and reject the other.
- **R5 — infra-push on the same node that's pushing:** rolling llamactl-agent's own binary on the scheduler's host is dangerous. Mitigation: the orchestrator's host is rolled last + manually.

## 8 — Sequencing

The fastest first-value path:

1. **Phase 1 alone, standalone**, with `cluster.yaml` hand-edited and no aggregator yet. Just teach the proxy to call peers from a static list. ~implement_substantial, single dispatch. Delivers: bench scripts drop their CA pem hardcodes.
2. **Phase 0 + 2**: aggregator + observability — once we want to look at "what's where" without ssh-ing.
3. **Phase 3**: apply-time placement once Phase 0 is in.
4. **Phase 4**: migration. Largest risk surface; gate behind explicit opt-in.
5. **Phase 5**: infra-push orchestration. Mostly compose-on-top.

Each phase is independently dispatchable.
