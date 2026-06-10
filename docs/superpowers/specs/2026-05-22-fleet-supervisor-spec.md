# Fleet Supervisor — Cross-Node Workload Stability + Adaptability

## Why this exists

llamactl's controller today is a **spec reconciler**: it ensures the
running ModelHost/ModelRun matches the declared `spec.enabled` state,
restarts on crash via `restartPolicy`, and that's it. It is blind to
runtime conditions that don't kill a process:

- **Memory exhaustion before crash**: 2026-05-22 we hand-loaded
  gemma-26B-MTP atomic fork alongside the 35B-A3B + granite-3b-Q8 on
  M4 Pro. Free pages dropped from 1031 MB → 15 MB and the compressor
  swelled to 2.6 GB. Nothing crashed, but the system was one allocation
  spike away from OOM-kill cascade. The controller had no visibility
  and no eviction policy.
- **Silent degradation**: 2026-05-22 the `granite-mini-3b` agent (mac-mini
  gateway → :8086) returned 502s for **hours** before the daemon-restart
  triggered the rebuild and surfaced it. The pool still satisfied
  `roles.includes('memory-refiner')` so the daemon kept routing to it.
  No back-pressure, no failover.
- **Capacity-blind admission**: `llamactl enable` happily spawns a
  workload that the target node can't fit. The model loads, OOM-kills
  a sibling, the controller restarts the sibling, repeat. Today the
  manual disable/enable dance is the only protection.
- **No priority**: with multiple ModelHosts loaded on a node, there's no
  way to say "evict this one first if pressure rises." Every workload is
  equally precious to the controller.

This spec proposes a new **`@llamactl/fleet-supervisor`** package that
fills these gaps. The supervisor watches, journals, proposes, and (per
severity gates) acts. It is explicitly _not_ an engine replacement —
the engines (oMLX, llama-server) keep their per-process scheduling
responsibilities. The supervisor sits above them, treating the engine
as a black box that loads tokens-into-tensors.

## Goals (L1 → L5)

### L1: Observability (must)

- Per-workload signal: RSS, Metal residency estimate, /v1/models reachability,
  /health latency, observed request rate (5-min window), observed error rate.
- Per-node signal: free pages, active/inactive ratio, compressor pages
  occupied, swap usage. Cross-node: M4 Pro + mac-mini, queryable from
  central.
- Append-only journal (jsonl). Same shape as the existing healer journal
  but a different `kind` ("fleet-snapshot"). One snapshot per tick.

### L2: Reactive ops (must)

- **Memory pressure remediation**: when a node's free-pages SMA falls
  below threshold AND compressor pages above threshold for N consecutive
  ticks, mark `pressure: HIGH` and emit a remediation proposal:
  "evict lowest-priority workload on this node."
- **Silent degradation detection**: per-port p95 latency and error-rate
  windows. If p95 > threshold or error-rate > threshold for N ticks,
  mark workload `degraded` and emit a remediation proposal: "restart
  workload OR mark for role failover."
- **Capacity-blind admission protection**: before the controller accepts
  a spec.enabled=true edge, the supervisor checks projected free pages =
  current - workload.expectedMemoryGiB. Reject (with explicit error)
  if the projection drops below `headroom_min`.

### L3: Workload reshaping (nice-to-have)

- Dynamic mcr adjust under observed contention: when a workload's p95
  rises sharply during co-residency with another workload, propose
  reducing its mcr by 1. (Caveat: oMLX requires restart to change
  mcr; engine support for live tuning is a separate ask.)
- max-model-memory shrink/grow: same shape; engine-dependent.

### L4: Adaptive composition (nice-to-have)

- `spec.priority: 0-100` field on ModelHost/ModelRun. L2 eviction
  uses this for the eviction order.
- Cross-node role failover: when an agentchat role pool member dies
  (or is `degraded`), the supervisor proposes routing through a
  designated alternative. (Agentchat's pool member list is the
  source-of-truth ordering.)

### L5: Predictive admission (must)

- Pre-flight check on `llamactl enable`: project memory after load,
  reject if below `headroom_min`. Distinct from L2's reactive policy
  — this catches the problem _before_ it happens.
- (Same logic available as a stand-alone `llamactl admit <workload>`
  CLI command for dry-run capacity planning.)

## Non-goals

- Replacing or wrapping the engine schedulers. The supervisor reads
  engine state; it does not multiplex requests, do batching, or own
  KV cache.
- Auto-loading arbitrary workloads on demand ("scale-to-zero +
  cold-start"). Out of scope for v1. Always start from a declared
  set; the supervisor adjusts within that set.
- Cross-node load balancing of individual requests. The router /
  openaiProxy / agentchat pool layer owns that.
- Replacing the existing `llamactl heal` framework. heal probes
  gateways + sirius providers; fleet-supervisor probes ModelHosts/
  ModelRuns. They journal separately and could be merged later if
  the patterns converge.

## Constraints

- **Cross-node**: must work for both M4 Pro local and mac-mini
  workloads. Per-node agents collect signals; central supervisor
  aggregates + decides + commands.
- **No central daemon dependency**: per-node agents already exist
  (llamactl-agent). The supervisor's central component should be
  driveable from the existing controller's loop, OR runnable as a
  sidecar `llamactl supervisor serve` that talks to the controller
  via the existing tRPC v11.
- **Severity-gated auto-action**: like `heal --auto`, gate
  destructive actions (eviction, kill, restart) behind explicit
  opt-in. Defaults to propose-only journal entries.
- **Idempotent + reversible**: every action must be undoable
  (re-enable an evicted workload; reset mcr). Journal entries
  carry enough state to rebuild.
- **Bench-data-informed defaults**: thresholds (pressure_high,
  p95_degraded, error_rate_unhealthy, headroom_min) should be
  derived from observed bench data, not arbitrary. Initial values
  should be reasonable starting points with a `--config` override.

## Sketch — components + flow

```
                    ┌─────────────────────────────────┐
                    │  fleet-supervisor (central)     │
                    │                                 │
                    │  - aggregate snapshots          │
                    │  - run policy engine            │
                    │  - emit proposals               │
                    │  - execute approved actions     │
                    └────┬──────────────┬─────────────┘
                         │ tRPC         │ journal
                         ▼              ▼
        ┌────────────────┴────────┐    ┌─────────────────────┐
        │  per-node probe agent   │    │ fleet-journal.jsonl │
        │  (llamactl-agent       )│    └─────────────────────┘
        │   + new probe module    │
        │                         │
        │  - /v1/models reach    │
        │  - /health latency     │
        │  - request counter     │
        │  - error counter       │
        │  - node mem signals     │
        └─────────────────────────┘
                ▲ each tick
                │
        ┌───────┴─────────┐
        │ ModelHost / Run │
        │ on this node    │
        └─────────────────┘
```

Snapshot shape (jsonl):

```json
{
  "ts": "2026-05-22T17:00:00Z",
  "kind": "fleet-snapshot",
  "node": "local",
  "node_mem": {
    "free_mb": 122,
    "compressor_mb": 4045,
    "active_mb": 912,
    "inactive_mb": 839,
    "wired_mb": 320
  },
  "workloads": [
    {
      "name": "gains-host-35b-local",
      "kind": "ModelHost",
      "endpoint": "http://127.0.0.1:8096",
      "rss_mb": 36,
      "request_rate_5m": 2.3,
      "error_rate_5m": 0.0,
      "p50_ms": 240,
      "p95_ms": 480,
      "models": ["Qwen3.6-35B-A3B-4bit"],
      "reachable": true
    }
  ]
}
```

Transition + proposal shape: same as healer journal (transition kind
"healthy↔unhealthy" → on flip, emit proposal entry with a plan).

## Open design questions for adversarial-plan

1. **Pressure threshold derivation**: how to set `pressure_high`
   without false positives? macOS compressor is normal under load.
   Free-pages alone is misleading (mmap/Metal). Better: free + compressor +
   swap delta over a window? What window length?

2. **Per-port request/error rate accounting**: where do we increment?
   Options: (a) reverse proxy at the router layer counts, (b) tail
   each engine's access log, (c) the agent itself wraps llama-server/oMLX
   with a thin counter. Trade-offs in coupling vs accuracy.

3. **Eviction policy when multiple workloads at same priority**: tie-break
   by RSS? By age? By cost (which workload is more expensive to reload)?

4. **mcr live-tuning vs restart**: oMLX requires restart to change
   `--max-concurrent-requests`. Is the supervisor's "reshape" action a
   restart, or do we defer reshape until engines gain live-config?
   (Spec defaults to "propose restart with new args" for v1.)

5. **Predictive admission with shared GPU memory**: M4 Pro unified
   memory means model A's Metal allocation reduces availability for
   model B. expectedMemoryGiB on the workload spec is a hint; reality
   depends on prompt shape, KV cache, etc. How conservative should the
   admission check be? +10%, +30%, observed-peak-x1.5?

6. **Severity tiers for fleet-supervisor actions**:
   - Tier 1 (read): journal a snapshot, emit a proposal.
   - Tier 2 (mutation-safe, auto-allowed): mark `degraded`, route
     around (no process kill).
   - Tier 3 (destructive, propose-only by default): evict, kill,
     restart.
     Should "evict" ever be tier 2? Argument for: reversible (re-enable
     later). Argument against: data in flight is lost.

7. **Failure mode**: what if the supervisor itself stalls or hangs?
   Heal-of-heal-er pattern? At minimum, the supervisor should journal
   "alive" heartbeats so a missing heartbeat is itself a transition.

8. **Cross-node coordination**: when pressure rises on M4 Pro, can the
   supervisor propose moving a workload to mac-mini? v1: no
   (workloads are pinned to nodes via spec.node). Future: maybe.

9. **Interaction with the existing `heal` framework**: should this
   eventually merge? Or stay distinct because the abstractions are
   different (gateway/provider vs ModelHost/ModelRun)?

## What we want from the adversarial planning fan-out

Each persona files a brief plan addressing:

- **The phasing**: is L1→L2→L5→L3→L4 the right order? Or should L5
  (predictive admission) ship first because it's the simplest +
  closes the most-painful gap?
- **Concrete probe shape**: per-port HTTP probe vs in-proc subscription
  to engine logs. Where does per-port request/error counting live?
- **Policy engine**: a simple SMA + threshold (proposed in the sketch),
  or something fancier (PID controller, hysteresis, learned thresholds)?
- **Failure-mode coverage**: what scenarios from the 2026-05-22
  session (gemma overload, granite-mini 502 storm, ad-hoc oMLX
  process orphans) does the design close? Which are still open?
- **TDD shape**: smallest failing-test that this design satisfies.
  Probably something like: "given a fake node with 2 workloads and
  free_mb=30, the supervisor emits a pressure_high transition + an
  eviction proposal in ≤ 2 ticks."

The synthesizer should produce one prioritized phased TDD plan with
dispatch-ready task descriptions per phase. Aim for L1 + L5 in a
shippable first-week scope; defer L3/L4 to a follow-on plan unless
the persona disagreement converges on different scoping.

## Out-of-band considerations

- **Authentication**: probes need to reach mac-mini gateway (TLS +
  bearer). Reuse existing agent cert + token path.
- **Storage**: journal at `~/.llamactl/fleet-supervisor/journal.jsonl`
  (parallel to healer journal). Retention: ?
- **Observability of the supervisor itself**: emit metrics to stdout
  for any external dashboard scraping. Prometheus format optional.

## Predecessor artifacts

- Existing `llamactl heal` (`packages/cli/src/commands/heal.ts`,
  `@llamactl/agents`) — frame this supervisor as the workload-level
  parallel.
- 2026-05-22 fleet audit (this session): role pool composition,
  bench-informed defaults for which workloads should bear which load.
- `[Daemon arg-dedup fix 2026-05-15]`, `[Mac-mini iso spawn regression
2026-05-21]` — historical incidents the supervisor should help avoid.
