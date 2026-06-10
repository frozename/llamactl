# Multi-workload local nodes — design

**Status:** draft / pending implementation plan
**Date:** 2026-05-13

## Problem

Applying a new `ModelRun` manifest on a local node stops the workload
that was already running there. Concrete incident: applying
`granite41-8b-long-lived-local.yaml` killed `gemma4-26b-a4b-mtp` —
Gemma's `:8181` consumer (home-mgmt SDK) flipped into a
ConnectionRefused respawn loop. The local node behaves as a
single-server appliance even though port-collision preflight already
proves the _port_ machinery can support multiple.

The root cause is in two places:

1. `packages/core/src/server.ts` tracks exactly one `llama-server` per
   `LOCAL_AI_RUNTIME_DIR` via a single `llama-server.pid` +
   `llama-server.state` pair. Every API (`serverStatus`, `startServer`,
   `stopServer`, `readServerPid`, `readServerState`) is keyed by the
   resolved env, not by a workload identity.
2. `packages/remote/src/workload/apply.ts:420` calls
   `client.serverStop.mutate()` whenever the live server's
   `rel`/`extraArgs`/`endpoint`/`binary` don't match the new manifest —
   even when the running server belongs to an unrelated workload.

## Goals

- Run two or more `llama-server` processes on the same local node,
  each managed by its own `ModelRun` manifest.
- Two operator scenarios must both be plausible:
  - **Parallel**: a long-lived helper (e.g. Granite 4.1 8B for
    home-mgmt at `:8181`) plus a swappable foreground model (Gemma 4
    26B, Qwen, …) on a different port, without either evicting the
    other.
  - **Hot swap**: replace one workload with another by explicit
    operator intent — not as a silent side-effect of `apply`.
- Allow disabling a workload without deleting the manifest, so the
  operator can park a config on disk and bring it back later without
  reauthoring it.
- Surface a soft RAM budget so the operator hears about overcommit
  before the M4 Pro's unified memory thrashes.

## Non-goals

- Auto-priority eviction across workloads. Operator-driven evict only.
- Sub-node GPU/CPU isolation (cgroups, taskset, Metal queue carving).
  Soft RAM accounting only.
- Sophisticated memory estimation. Heuristic + operator override.
- Reshaping remote (non-local) node UX. The same `core/server.ts`
  change benefits remote agents, but the budget dashboard and chat
  picker work is local-first.

## Approach

Move from a per-node-singleton state model to a per-workload state
model, with apply semantics defaulting to _parallel_, evict opt-in,
and an advisory RAM budget check.

### Architecture

Per-workload runtime state on disk:

```
~/.llamactl/runtime/
└── workloads/
    └── <workload-name>/
        ├── llama-server.pid    # PID of this workload's llama-server
        ├── llama-server.state  # rel + extraArgs + endpoint + binary + startedAt
        └── llama-server.log
```

Manifest store stays put: `~/.llamactl/workloads/<name>.yaml`
(`packages/remote/src/workload/store.ts`).

Invariants:

- One `llama-server` process is owned by exactly one workload name.
- Workload-name uniqueness on a node is already enforced by the file
  store (manifests are files keyed by `metadata.name`).
- Boot-time crash recovery: the agent daemon walks
  `runtime/workloads/*/llama-server.pid`, probes each PID, and
  reconciles against `workloads/*.yaml`.
- `llamactl server start` (imperative escape hatch) gains `--name
<key>` and synthesizes a transient manifest named
  `imperative-<unix-ms>` when omitted; that manifest is a normal
  first-class workload from then on.

### Schema additions

`packages/remote/src/workload/schema.ts`:

```ts
// ModelRunSpecSchema (new)
enabled: z.boolean().default(true),

// ModelRunSpecSchema (new optional)
resources: z.object({
  expectedMemoryGiB: z.number().positive().optional(),
}).optional(),

// ModelRunMetadataSchema (new)
annotations: z.record(z.string(), z.string()).default({}),
```

`spec.enabled: false` means "reconciler keeps this stopped." Manifest
stays on disk, status reports `Stopped` with `reason: Disabled`, RAM
budget does not count it. Re-enable by editing the field and
re-applying, or via `llamactl enable <name>` (below).

Reserved annotation keys:

- `llamactl.io/evict: "<name>,<name2>"` — stop these workloads before
  starting this one. No-op if a target is absent.
- `llamactl.io/force-admit: "true"` — skip the advisory budget check.

CLI `--evict <name>` (repeatable) and `--force` stamp these
annotations onto the persisted manifest so the file on disk is the
durable record of operator intent.

`packages/remote/src/workload/noderun-schema.ts`:

```ts
// NodeRunSpec (new optional)
budget: z.object({
  memoryGiB: z.number().positive(),
}).optional(),
```

When absent, the node's budget defaults to physical RAM × 0.75
(queryable via `node.facts`).

### Core API (`packages/core/src/server.ts`)

All public APIs gain a required workload key:

```ts
interface WorkloadKey { name: string; }

function workloadRuntimeDir(resolved: ResolvedEnv, key: WorkloadKey): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, 'workloads', key.name);
}

serverStatus(key, resolved?): Promise<ServerStatus>
startServer(key, opts): Promise<StartServerResult>
stopServer(key, opts?): Promise<StopServerResult>
readServerPid(key, resolved?): number | null
readServerState(key, resolved?): ServerState | null
```

New helpers:

```ts
listLocalWorkloads(resolved?): WorkloadRuntimeEntry[]
// Walks runtime/workloads/*, returns { name, pid, state, alive }.
// Used by reconciler at boot.

estimateWorkloadMemory(manifest, resolved?): number | null
// GGUF size × 1.1 + ctx-size × per-arch KV constant. null when
// the file isn't local (gateway workloads etc.).
```

Per AGENTS.md "no backwards-compat shims," signatures change in
place; every caller is updated. Callers:

- `packages/remote/src/workload/apply.ts` — main rewrite (below).
- `packages/remote/src/router.ts` keep-alive + chat-proxy paths.
- `packages/app` chat panel.
- `packages/cli` imperative `server start/stop/status`.

The legacy singleton paths (`runtime/llama-server.{pid,state,log}` at
the root) are deleted from the live code; tests update.

### Apply / reconciler (`packages/remote/src/workload/apply.ts`)

`applyOne()` reshape:

1. Gateway / worker handling unchanged.
2. **Disabled short-circuit.** If `spec.enabled === false`, ensure
   the workload's server is stopped (call `serverStop` only when its
   PID is live), skip admission and eviction, and return a `Stopped`
   status with a `Disabled` condition. Port-collision preflight and
   budget accounting both exclude disabled manifests.
3. Port-collision preflight unchanged (already cross-manifest;
   filters out disabled manifests).
4. **Evict step.** Read `annotations['llamactl.io/evict']`. For each
   named workload that is currently running on the same node, call
   `client.serverStop.mutate({ workload: name, graceSeconds: 5 })`.
   Emit `evict` events. A missing eviction target logs a warning and
   continues (operator may have already deleted it).
5. **Admission check.** Sum `expectedMemoryGiB` across all live,
   enabled workloads on this node (excluding any just evicted,
   including the new one). If sum > node budget and `force-admit` is
   absent → return `pending` with a `BudgetExceeded` condition. CLI
   translates that to a non-zero exit with a "rerun with `--force`"
   hint.
6. **Diff for this workload only.** `client.serverStatus.query({
workload: manifest.metadata.name })` returns state for that
   workload's process. The "stop the mismatched server" branch only
   stops _this_ workload's old process. Other workloads on the node
   are not touched — the core bug fix.
7. Start the new server under the workload's runtime dir.
8. Status reporting unchanged in shape; `ModelRunStatus` is already
   per-manifest.

`reconcileLoop.ts` continues to iterate `listWorkloads()`; each
iteration is now hermetic.

Agent tRPC surface (`packages/remote/src/server/...`): `serverStatus
/ serverStart / serverStop` take `workload: string` as input.

Boot-time reconciliation: on agent daemon startup, call
`listLocalWorkloads()` and cross-reference with `listWorkloads()`.
Orphan PIDs (alive process, no manifest) → log + leave alone. Stale
runtime dirs (no live process) → clean up.

### CLI + operator surfaces

`llamactl apply`:

- `--evict <name>` (repeatable) — stamps annotation.
- `--force` — stamps `force-admit`.

`llamactl enable <name>` / `llamactl disable <name>`: edit
`spec.enabled` on the persisted manifest and re-apply. `disable`
gracefully stops the running server if any; `enable` triggers normal
admission + start. Both are thin wrappers over `apply` so the
manifest file remains the durable record.

`llamactl get workloads`: gains a `RESERVED` column (per-workload
`expectedMemoryGiB`) and shows `Disabled` in the `PHASE` column for
parked manifests.

`llamactl describe node <name>`:

```
Budget:   24.0 / 36.0 GiB
Workloads:
  granite41-8b-long-lived   :8181   running   8.2 GiB
  gemma4-26b-a4b-mtp        :8090   running  15.8 GiB
```

Over-budget prints a `BudgetExceeded` warning line.

Imperative `llamactl server status/start/stop`:

- `--name <key>` required when more than one workload is live.
  Defaults to the single live workload when there is one.
- `start` without a manifest synthesizes one named
  `imperative-<unix-ms>` and persists it like any other workload.

MCP tools (`packages/mcp/`): `llamactl.workload.list`,
`llamactl.workload.apply`, `llamactl.server.status` gain a `workload`
argument where applicable. New tool:

- `llamactl.node.budget` (read-only): `{ budget, reserved, workloads[] }`.

Electron app (`packages/app/`): chat panel selects a workload from a
dropdown of live ones. Cost dashboard groups by workload (already the
shape for remote nodes).

### Migration

One-shot in-place move on agent daemon boot:

1. Detect `~/.llamactl/runtime/llama-server.pid` (legacy singleton).
2. Read `llama-server.state` to recover `rel`/`extraArgs`/`endpoint`.
3. Cross-reference manifests in `~/.llamactl/workloads/*.yaml`:
   - Match → `mv runtime/llama-server.{pid,state,log}` →
     `runtime/workloads/<name>/`.
   - No match → synthesize an `imperative-<timestamp>` manifest from
     the state and move the files under it.
4. Stash a `.migrated-v2` flag in the runtime dir so this only runs
   once.

If the legacy process is already dead at boot, delete the stale files
— nothing to preserve.

### Test plan

Bun test suites (`packages/remote/src/workload/`,
`packages/core/src/`):

| Suite                                  | Cases                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.test.ts` (core)                | Two workloads spawn concurrently into separate dirs; `serverStop(A)` does not touch B; `listLocalWorkloads()` returns both; crash-recovery walk after orphaning A's pid.                                                                                                                                                                                                 |
| `apply.test.ts`                        | Parallel apply: B applies cleanly while A is live, no stop. Evict: `evict: A` stops A then starts B; A's runtime dir cleaned. Budget overflow → `pending` + `BudgetExceeded`, unless `force-admit`. Hot-swap of same name still restarts in place. Disable while running stops the server, status reports `Disabled`, RAM accounting drops it. Re-enable starts it back. |
| `migration.test.ts`                    | Legacy `runtime/llama-server.pid` + matching manifest → moves under workload dir. No matching manifest → synthesizes `imperative-*`. `.migrated-v2` flag blocks re-run.                                                                                                                                                                                                  |
| Integration shell (`test/run-all.zsh`) | Apply Granite + Gemma → both serve. `apply --evict granite gemma` → only Gemma. Apply over budget → fails; `--force` → succeeds.                                                                                                                                                                                                                                         |

Cross-repo smoke (per the project's standing cross-repo validation
rule): manually verify home-mgmt SDK keeps hitting `:8181` (Granite)
while Gemma is applied to a different port.

## Risks

- **Memory estimator accuracy.** GGUF size × 1.1 + per-arch KV
  constant is a heuristic. Mitigation: operator override on the
  manifest, plus `--force` escape hatch.
- **Imperative-start UX churn.** Operators have muscle memory for
  `llamactl server start` with no name. Mitigation: when exactly one
  workload is live, `--name` is optional; otherwise we error with a
  clear "pass --name <name>" hint.
- **Chat/agent path workload selection.** Today the keep-alive proxy
  and chat router assume "the local server." Each consumer needs an
  explicit pick. Mitigation: each consumer picks the workload it was
  configured with; the Electron chat surfaces a dropdown.
- **GGUF memory estimator on remote / gateway nodes** returns null.
  Admission check falls back to "skip" for those entries, so
  cross-node estimates underreport. Mitigation: budget is per-node
  and skipped entries are flagged in `describe node`.

## Open questions

- Should `expectedMemoryGiB` be inferred lazily (at apply time) or
  baked into manifest status the first time the workload runs?
  Default plan: lazy at apply time; operator can write it explicitly
  to pin the estimate.
- Should the evict step accept a label-selector instead of a list of
  names? Out of scope for v1 — annotations carry plain comma-separated
  names; selectors are an additive change later.
