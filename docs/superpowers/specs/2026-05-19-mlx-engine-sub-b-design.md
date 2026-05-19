# MLX engine support — Sub B: ModelHost workload-store integration

Status: design, ready for `/write-plan`
Date: 2026-05-19
Predecessor: Sub A spec (`docs/superpowers/specs/2026-05-18-mlx-engine-sub-a-design.md`)

## 0. Measurement gate

Sub B is an integration and control-plane consistency slice, not a model-quality
or throughput optimization slice. No new benchmark target is required to decide
architecture. Measurement work stays in the Sub C/Sub D execution waves after
ModelHost is fully reconciler-backed.

Gate result: **not applicable for design acceptance**.

## 1. Goal and scope

Sub B closes the structural gap left by Sub A: `kind: ModelHost` must join the
same declarative workload lifecycle as `kind: ModelRun` so operators get the same
apply/list/disable/reconcile behavior.

In scope for Sub B:

- Persist `ModelHost` manifests in the canonical workloads yaml store
  (`defaultWorkloadsDir()`), not only runtime sidecars.
- Route `ModelHost` apply through node dispatch (not controller-local
  `child_process.spawn`) so remote nodes (mac-mini) are unblocked.
- Bring `ModelHost` into reconcile loop, list views, and disable semantics.
- Keep engine logic in `packages/core/src/engines/*`; Sub B is orchestration
  integration, not adapter redesign.

Out of scope:

- New engine types or adapter capabilities.
- Multi-model `hostedModels` expansion (Sub C+).
- Train-adapter loading and train→infer loop (Sub D).

## 2. Design question ledger (hard gate)

1. Store integration shape  
Decision: **shared store** in `defaultWorkloadsDir()` with kind filtering, same
pattern as `NodeRun` (`packages/remote/src/workload/noderun-store.ts`).  
Why: `llamactl disable` and `llamactl get workloads` are store-backed today
(`packages/cli/src/commands/setEnabled.ts`, `packages/cli/src/commands/workload.ts`).
Parallel directories would keep current blind spots.

2. Reconciler dispatch shape  
Decision: keep separate apply functions per kind (`applyOneModelRun`,
`applyOneModelHost`) behind `applyManifest` kind dispatch in
`packages/remote/src/workload/apply.ts`.  
Why: current `applyOne` is already large and ModelRun-specific (admission,
worker RPC, gateway path). Forcing both kinds into one function will reduce
maintainability and increase regression risk.

3. Worker-side spawn path  
Decision: add a dedicated node tRPC surface for ModelHost lifecycle:
`modelHostStart` (subscription), `modelHostStop` (mutation), `modelHostStatus`
(query), implemented in `packages/remote/src/router.ts` and backed by core engine
entrypoints.  
Why: reusing `serverStart` would overload ModelRun-specific inputs (`target`,
llama-server semantics). Dedicated procedures preserve clear contracts and
dispatcher fan-out (`--node`, tunnel, remote TLS pinning) without controller-local
spawn.

4. State source of truth  
Decision: desired state is yaml manifest in shared store; observed runtime state
remains sidecars under `workloadRuntimeDir` (`modelhost.pid`, `modelhost.state`)
via `writeModelHostState` / `readModelHostState` in
`packages/core/src/engines/state.ts`.  
Why: this matches current ModelRun pattern (manifest + runtime sidecars) and lets
`reconcileOnce` rebuild status after process drift.

5. `disable` semantics  
Decision: `llamactl disable <name>` becomes kind-aware; for ModelHost it sets
`spec.enabled=false` and executes ModelHost stop, which calls adapter
`teardown(pid)` (`EngineAdapter.teardown`) through the new node procedure.  
Why: today disable only loads ModelRun manifests; this is the direct fix for the
reported operator breakage.

6. Admission policy  
Decision: ModelHost uses the existing node budget gate (`computeNodeBudget`)
against `spec.resources.expectedMemoryGiB`, with same `llamactl.io/force-admit`
escape hatch as ModelRun. Port-collision checks are reused where endpoint exists.  
Why: one policy surface keeps fleet behavior predictable and avoids introducing a
second memory admission regime.

7. mac-mini deployment constraint  
Decision: Sub B removes the local-only guard in apply path and relies on node
dispatch. Any node constraints remain schema/runtime-validated, not hard-coded to
loopback identities.  
Why: this unblocks Sub C without requiring Sub C feature scope in this design.

8. Migration / compatibility  
Decision: keep file format compatibility in shared workloads dir; no changes to
existing `ModelRun` manifests. Add ModelHost store helpers and list/describe
routing by `kind` so mixed directories continue to work.  
Why: `NodeRun` already proved mixed-kind manifests are viable with parse-time kind
filtering.

## 3. Architecture

Control-plane path after Sub B:

1. `llamactl apply -f host.yaml` parses YAML, detects `kind: ModelHost`, persists
manifest to shared workloads store, then dispatches apply via remote workload layer.
2. Workload apply routes to `applyOneModelHost` (new) which:
   - runs admission + endpoint collision checks against store siblings,
   - calls node `modelHostStart` subscription,
   - writes status section back to persisted manifest.
3. Reconciler (`reconcileOnce`) loads both kinds from shared store and applies
kind-specific convergers each tick.
4. `llamactl get workloads` and `llamactl disable` operate on both kinds through
kind-aware load/save/apply wiring.

This keeps `packages/core` adapter logic pure and moves orchestration parity into
`packages/remote` + `packages/cli`.

## 4. Yaml schema + workload-store integration

Store strategy:

- Keep one directory: `defaultWorkloadsDir()`.
- Introduce `modelhost-store.ts` parallel to `noderun-store.ts`:
  `parseModelHost`, `saveModelHost`, `loadModelHostByName`, `listModelHosts`,
  `deleteModelHost`.
- Add a union loader for commands that are kind-agnostic (list/disable/describe)
  so they can resolve name→manifest kind without guessing.

Schema notes:

- `kind: ModelHost` remains unchanged from Sub A (`ModelHostManifestSchema`).
- Sub B does not widen to multi-model; `hostedModels` cardinality remains Sub A
  bounds.
- `spec.node` local-only enforcement in `applyModelHostManifest` is removed from
  workflow and replaced by node-dispatch availability checks.

## 5. Engine adapter + dispatch wiring

Adapter boundary remains in core (`packages/core/src/engines/index.ts` and
`EngineAdapter` contract). Sub B adds orchestration wiring only:

- New core-facing operations (or wrappers) for host lifecycle:
  `startModelHost`, `stopModelHost`, `modelHostStatus` using existing
  `ENGINES[engine].buildBootCommand/probeReady/teardown`.
- Router exposes corresponding tRPC procedures, mirroring existing `serverStart`
  subscription ergonomics.
- `WorkloadClient` type in `packages/remote/src/workload/apply.ts` is extended with
  `modelHost*` methods for remote/local parity.

Result: ModelHost spawn moves from controller `node:child_process.spawn` to
node-executed process management through the same dispatcher channel as ModelRun.

## 6. Pull-path impact

No functional pull-path changes in Sub B. `llamactl pull` MLX support landed in
Sub A and remains valid.

Only integration touchpoint: docs and validation should state that pulled MLX
artifacts become operational once ModelHost manifests are persisted and reconciled,
not via ad-hoc controller-side spawn.

## 7. openaiProxy + matrix impact

`openaiProxy` (`packages/core/src/openaiProxy.ts`) and `listLocalRoutes`
(`packages/core/src/workloadRuntime.ts`) already support ModelHost aliases from
sidecars. Sub B does not alter route-map semantics.

Indirect improvement: once ModelHost is reconciler-managed, route entries survive
controller restarts because desired state is recovered from store and reapplied.

Matrix bench (`packages/eval/src/matrix/*`) is unchanged in Sub B design; bench
engine selection remains as defined in Sub A.

## 8. Testing strategy

Primary tests to add/update:

- `packages/remote/test/workload/modelhost-apply.test.ts`
  - assert remote dispatch path (`modelHostStart`) is used instead of direct spawn.
  - assert non-local nodes are accepted when client exists.
- New store tests for `modelhost-store.ts` kind filtering + save/load parity.
- CLI tests (`packages/cli/test/...`)
  - `disable` works on ModelHost names.
  - `get workloads` includes ModelHost rows.
- Reconciler tests (`packages/remote/src/workload/reconciler.ts` coverage)
  - mixed ModelRun + ModelHost manifests reconcile and persist status.
- Router integration tests (`packages/remote/test/router-workload.test.ts`)
  - `workloadApply` returns persisted path for ModelHost (no longer `null`).

## 9. Migration and back-compat

- Existing ModelRun YAML files remain untouched.
- Existing ModelHost runtime sidecars remain readable; Sub B migration adds missing
manifest persistence as the canonical desired state.
- If an operator has a running Sub A ModelHost without a manifest in store, Sub B
introduces a one-time reconciliation-safe bootstrap path:
  - either require re-apply of YAML (preferred, explicit),
  - or optional synthesis helper from runtime sidecar to manifest stub (deferred;
    not required for Sub B acceptance).
- `llamactl disable/list/describe` become additive for ModelHost; no behavior
regression for ModelRun.

## 10. Open questions deferred

- Sub C: policy for remote ModelHost binary provenance (`spec.binary` path
portability vs per-node artifact resolution).
- Sub C: whether ModelHost status should include node-advertised endpoint metadata
similar to `serverStatus.advertisedEndpoint`.
- Sub D: whether train adapters require ModelHost schema extension or remain engine
extraArgs + side-channel APIs.

## 11. File touch list (informational, not the plan)

- `packages/remote/src/workload/apply.ts`
  - split ModelRun vs ModelHost convergers; remove local-only guard path.
- `packages/remote/src/workload/reconciler.ts`
  - mixed-kind reconcile pass.
- `packages/remote/src/workload/store.ts` and new `modelhost-store.ts`
  - shared-dir persistence for ModelHost.
- `packages/remote/src/router.ts`
  - add `modelHostStatus/start/stop`; update `workloadApply/list/delete` kind logic.
- `packages/cli/src/commands/workload.ts`
  - include ModelHost in list/describe/apply persistence reporting.
- `packages/cli/src/commands/setEnabled.ts` + `disable.ts`
  - kind-aware enable/disable.
- `packages/core/src/engines/state.ts`
  - reused as runtime observation source; no schema break expected.
- `packages/core/src/workloadRuntime.ts` and `packages/core/src/openaiProxy.ts`
  - likely no functional changes, but include regression tests for restart/reconcile.

## 12. Brainstorming checklist closure (9 items)

1. Explore project context — completed (Sub A spec + current workload/apply/store/runtime/router paths).
2. Offer visual companion — not applicable (no UI/visual design decisions needed).
3. Ask clarifying questions — waived by explicit task packet with fixed deliverable + constraints.
4. Propose 2-3 approaches — completed internally; selected shared-store + split-converger design.
5. Present design — completed in this spec with explicit decision ledger.
6. Write design doc — completed at this path.
7. Spec self-review — completed (placeholder/consistency/scope/ambiguity pass).
8. User review gate — next step by maestro after this commit.
9. Transition to implementation (`/write-plan`) — intentionally deferred per instruction.
