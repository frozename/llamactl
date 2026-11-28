# Dynamic fleet models

Operator guide for the large-GPU candidate fleet: catalog metadata,
residency exclusion, qualification and promotion, the exclusive-window
runbook, and the download/rollback procedure. This extends the existing
catalog, router and workload lifecycle — it is not a parallel registry
(refs #522 and #273).

Open items:

- The 8-state residency lifecycle and the exclusive-group decisions ship
  as a pure library (`packages/core/src/residency/lifecycle.ts`, #517).
  Persistence landed in #662: the fenced residency store
  (`packages/remote/src/residency/store.ts`) writes per-model states to
  its `residency_states` table. Writing is opt-in through
  `transitionResidencyState`, and the profile-switch executor
  (`applyResidencyProfile`: router procedure, CLI verb, MCP tool) now writes
  `residency_states` for its victims and replacements. A same-group occupant
  that the plan observed occupying refuses the start with
  `ExclusiveGroupOccupied` before the engine runs. A same-group occupying row
  the plan did not observe is reconciled to downloaded only when it is `ready`
  and `directWorkloadProvenDown` proves its workload down (for example a
  crash-left keep-alive, or a ModelRun whose recorded pid is gone). Otherwise,
  including any `loading`/`warming` row, it is kept, logged as
  `[residency] lifecycle kept <model> <state> in group <group>: not proven down`,
  and the replacement start is refused with `ExclusiveGroupOccupied` before the
  engine runs, matching the direct-start rule. `applyOne`
  and `applyOneModelHost` (`packages/remote/src/workload/apply.ts`), which the
  reconciler calls, start a ModelRun's coordinator and a ModelHost through the
  node agent's `serverStart` and `modelHostStart` procedures, so the fenced
  direct-start lifecycle refusal covers those starts; the rpc-server workers
  `applyOne` starts for a ModelRun with `spec.workers` go through the agent's
  `rpcServerStart` procedure, which calls `startRpcServer` without
  `runDirectResidencyStart` and records no `residency_states` row, and the
  reconciler passes `applyOne` no gateway dispatcher, so it leaves a
  `spec.gateway` ModelRun `Pending` without starting it. What enforces today
  is the finite-budget admission math, the per-node residency-group start
  guard, the fenced direct-start lifecycle refusal and the read-only
  pre-launch gate, all four listed under Residency states and exclusion
  below. `llamactl residency status`, the
  `residencyStatus` procedure and the MCP tool now report the serving
  process's `residency_states` rows and any exclusive-group violation
  (`findExclusiveGroupViolations`, previously used only by the planner).
  Lifecycle-row boot recovery has landed, and direct ModelHost
  `modelHostStart`/`modelHostStop` now drive their `residency_states` rows
  through the same fenced walks (`direct-lifecycle.ts`), reconciling
  proven-down same-group peers and refusing an occupied exclusive group or
  an in-flight switch. The direct ModelRun `serverStart`/`serverStop` writers
  now do the same, recording the group from the agent-side ModelRun
  `llamactl.io/residency-group` label; when the stored ModelRun has no such
  label, or no ModelRun is stored under the name, `serverStart` takes the group
  from the catalog `residencyGroup` of the rel `resolveTarget` returns for its
  target (`directModelRunStartOpts`), and a label always wins; when neither the
  inline nor stored ModelHost has such a label, `modelHostStart` takes the group
  from the catalog `residencyGroup` of its first hosted rel, the inline rel
  winning over the stored rel (`directResidencyGroup`), and a label always wins;
  the switch's own `applyManifest` calls run in a switch scope and are walked
  only by the switch.
  Still pending: reconciliation outside a switch.
- Real GLM-5.3-Flash z13 measurements are not yet committed (see the
  eval record at the bottom).

## Catalog fields

Curated catalog rows carry optional candidate metadata in the `meta`
column of `curated-models.tsv`. The canonical top-level keys, per the
`CuratedMeta` zod schema in `packages/core/src/schemas.ts`:

| key              | meaning                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `availability`   | Declared availability: `available` (optional `reason`) or `unavailable` (non-empty `reason` required when declared unavailable). |
| `qualification`  | Stage (`experimental` \| `candidate` \| `validated` \| `production` \| `degraded`) plus optional `since` and `evidenceRef`.      |
| `runtime`        | Non-empty `engines` list plus optional `minBuild`, `toolCallFormat`, `reasoningFormat`, `chatTemplate`.                          |
| `contextMax`     | Positive integer maximum context length.                                                                                         |
| `params`         | Optional `totalB` and `activeB` (positive numbers) and `experts` (positive integer).                                             |
| `memory`         | Optional non-negative `residentGiB`, `diskBackedGiB`, `kvGiBPer32k`.                                                             |
| `residencyGroup` | Non-empty group name; members of one group hold exclusive memory on a node.                                                      |
| `license`        | Non-empty licence note.                                                                                                          |

See [tsv-schemas.md](tsv-schemas.md) for the column-9 wire format.

### The z13-large-gpu builtin rows

Eight builtin catalog rows declare `residencyGroup: z13-large-gpu`.
All eight are qualification stage `experimental`. Declared
availability and reason, copied verbatim from
`packages/core/src/catalog.ts`:

| id                                   | declared availability     | reason                                                                      |
| ------------------------------------ | ------------------------- | --------------------------------------------------------------------------- |
| `glm53-flash-a4e3s`                  | unavailable               | `artifact-not-downloaded`                                                   |
| `deepseek41-flash-1017-ud-iq1s`      | unavailable               | `artifact-not-downloaded; runtime-not-pinned`                               |
| `deepseek41-flash-1017-ud-iq1m`      | unavailable               | `artifact-not-downloaded; runtime-not-pinned`                               |
| `deepseek41-flash-1017-gsq-rco-iq1m` | unavailable               | `artifact-not-downloaded; runtime-not-pinned; exceeds-node-budget-resident` |
| `mimo26-flash-mopd-bpw25`            | unavailable               | `artifact-not-downloaded`                                                   |
| `mimo26-flash-mopd-a4x`              | unavailable               | `artifact-not-downloaded; runtime-unverified`                               |
| `mimo26-flash-mopd-bpw30`            | unavailable               | `exceeds-node-budget`                                                       |
| `glm53-flash-aj-iq2xxs`              | availability not declared | —                                                                           |

Changing availability:

- A builtin row's availability lives in `catalog.ts` source, so
  changing it is a code PR.
- Custom rows come from `LOCAL_AI_CUSTOM_CATALOG_FILE` (default
  `curated-models.tsv` under the runtime dir). `listCatalog`
  concatenates them after the builtins; it does not merge them into
  builtin rows. There are no override semantics — a custom row with a
  builtin's id is a second row, not a replacement.

### Adding custom candidate rows

`llamactl catalog add <hf-repo> <gguf-file-or-relpath> [label] [family] [class] [scope] [--meta <json>]`
appends a custom row.

`--meta` takes a JSON object of the keys in the table above.

`addCurated` (`packages/core/src/catalogWriter.ts`) validates it against
`CuratedMeta` in strict mode (`.strict()`). An unknown key is refused with
`invalid catalog meta: unrecognized key(s): <keys>`, and nothing is written.

The CLI (`packages/cli/src/commands/catalog.ts`) refuses with exit 1 on
`catalog add: --meta is not valid JSON` and `catalog add: unknown flag <flag>`.
A missing value after `--meta` produces
`catalog add: --meta requires a JSON value`.

`--meta` always consumes the next token as its value, and that value is
never counted as a positional argument. A bare `--` ends flag
parsing, so a label starting with `--` goes after `--`.

The keys are written as compact JSON in column 9 (see [tsv-schemas.md](tsv-schemas.md)).

A row added with `qualification.stage` reports that stage as `catalogStage`
in `llamactl qualification status <rel>` (`packages/cli/src/commands/qualification.ts`).

`catalog add` cannot change an existing row: it refuses a rel already in any
catalog with `Catalog already contains <rel>`.

## Residency states and exclusion

The residency state model exists as a library (#517). Since #662 the
fenced residency store (`packages/remote/src/residency/store.ts`)
persists per-model states in its `residency_states` table:

- The file is `residency/operations.sqlite` under the llamactl home,
  or the path in `LLAMACTL_RESIDENCY_STORE`.
- Each `transitionResidencyState` write is fenced, compare-and-set on
  version, and checked against the lifecycle edges and exclusive-group
  occupancy over all persisted rows in one IMMEDIATE transaction.
- Writing is opt-in: only a caller that opens the store and calls
  `transitionResidencyState` writes rows. The profile-switch executor
  (`applyResidencyProfile`: router procedure, CLI verb, MCP tool) now writes
  `residency_states` for its victims and replacements. A same-group occupant
  that the plan observed occupying refuses the start with
  `ExclusiveGroupOccupied` before the engine runs. A same-group occupying row
  the plan did not observe is reconciled to downloaded only when it is `ready`
  and `directWorkloadProvenDown` proves its workload down (for example a
  crash-left keep-alive, or a ModelRun whose recorded pid is gone). Otherwise,
  including any `loading`/`warming` row, it is kept, logged as
  `[residency] lifecycle kept <model> <state> in group <group>: not proven down`,
  and the replacement start is refused with `ExclusiveGroupOccupied` before the
  engine runs, matching the direct-start rule.
  `llamactl residency status`, the `residencyStatus` procedure and the MCP
  tool now report the serving process's `residency_states` rows and any
  exclusive-group violation (`findExclusiveGroupViolations`, previously
  used only by the planner). Lifecycle-row boot recovery has landed, and
  direct ModelHost `modelHostStart`/`modelHostStop` now drive their
  `residency_states` rows (see Residency lifecycle states), as do the direct
  ModelRun `serverStart`/`serverStop` writers, recording the group from the
  agent-side ModelRun `llamactl.io/residency-group` label; when the stored
  ModelRun has no such label, or no ModelRun is stored under the name,
  `serverStart` takes the group from the catalog `residencyGroup` of the rel
  `resolveTarget` returns for its target (`directModelRunStartOpts`), and a
  label always wins; when neither the inline nor stored ModelHost has such a
  label, `modelHostStart` takes the group from the catalog `residencyGroup` of
  its first hosted rel, the inline rel winning over the stored rel
  (`directResidencyGroup`), and a label always wins; the switch's own
  `applyManifest` calls run in a switch
  scope and are walked only by the switch. Still pending: reconciliation outside
  a switch.
- Group declarations are not persisted. They come from the caller
  (default `RESIDENCY_GROUPS`). `catalog add` refuses a `--meta`
  `residencyGroup` that `RESIDENCY_GROUPS` does not declare, because an
  undeclared group would be ignored by every exclusive-group gate.

Since #276 opened, ModelHost starts are enforced (items 2 and 3 below),
boot recovery of interrupted profile-switch operations and lifecycle rows
has landed
([dynamic-residency.md](dynamic-residency.md#cancel-and-crash-recovery)),
and the residency store refuses a `desiredRevision` below its high-water
mark as `stale-revision` and, on `beginOperation`, refuses as
`reservation-exceeds-budget` a reservation that would push the pending and
committed reservations past a caller-supplied `nodeBudgetGiB`; the
profile-switch executor passes the plan's resolved node budget when it is
known. Still pending #276: reconciliation outside a switch, a mandatory
`desiredRevision` on `transitionResidencyState` (a write that carries none
is accepted and keeps the stored revision), and budget admission for
`transitionResidencyState`, which records no reservation and is not
budget-gated. The enforcement in place today is the following:

1. `packages/core/src/residency/admission.ts` — finite-budget
   admission arithmetic: refusals for an unknown budget, an
   unmeasurable allocation, or an over-budget commit; never treats an
   unknown budget as unlimited.
2. The per-node residency-group guard in `startModelHost`
   (`packages/remote/src/server/modelhost.ts`, #557 S5):
   - ModelHosts carrying the same `llamactl.io/residency-group` label
     value are mutually exclusive on a node.
   - `startModelHost` refuses a start while a same-group peer is
     Running, Starting (an in-flight start or a live/unverifiable
     starting record) or Unknown (an unverifiable pid).
   - The refusal runs before the manifest is persisted and before any
     reap or spawn, so a refused start leaves no desired state behind.
   - Error text:
     `residency-group <group> already has <state> ModelHost <host> on this node; stop it before starting <name>`.
     The result carries `residencyConflict` — `{ group, host, state }`.
   - Scope is the agent's own workloads store and runtime dir — that
     is the node. `spec.node` is not consulted.
   - Known limit: two separate agent processes (e.g. a CLI in-process
     apply and the daemon) starting different members at the same
     instant can both pass, because a peer's starting record is
     written only after prepareLaunch and spawn.
   - Only labelled ModelHost peers are checked. ModelRuns and
     unlabelled hosts are not.
3. The fenced direct-start lifecycle refusal (`runDirectResidencyStart`,
   `packages/remote/src/residency/direct-lifecycle.ts`, #517). The agent's
   `modelHostStart` and `serverStart` procedures
   (`packages/remote/src/router.ts`) run every direct start through it.
   A ModelHost takes its group from its `llamactl.io/residency-group`
   label, else the catalog group of its hosted rel (an inline manifest's
   rel winning over the stored manifest's); a ModelRun takes the label,
   else the catalog group of its resolved target. When another `loading` or `warming` row holds that
   exclusive group, or a `ready` row whose workload is not proven down, the
   start is refused before the engine runs, as
   `residency lifecycle refused <name> <from> -> <to>: ExclusiveGroupOccupied: <detail>`;
   a same-group `ready` peer proven down is instead reconciled to
   `downloaded` and logged as
   `[residency] lifecycle reconciled stale <peer> ready -> downloaded in group <group>`.
   It also refuses a start while a profile switch is in flight on the node, as
   `residency lifecycle refused <name>: profile switch in flight on this node; retry after it settles`.
   A writer inside the profile switch's own scope (its `applyManifest`
   calls) neither records nor refuses, and a node with no residency store
   file starts unrecorded. Details:
   [dynamic-residency.md](dynamic-residency.md#direct-modelhost-start-and-stop).
4. The read-only pre-launch gate (`exclusiveGroupLaunchRefusal`,
   `packages/remote/src/residency/direct-lifecycle.ts`, #517). Launches read
   the local residency store before they spawn and refuse when any
   `loading`, `warming` or `ready` row holds the declared-exclusive residency
   group of what they launch. Sandbox launches record no `residency_states`
   row and count a row for the same id:
   `llamactl eval run <model>` without `--url`,
   `llamactl eval perf --launch` and `llamactl admit measure` exit 1; the
   eval matrix runner spawns no refused engine, and writes an error cell for
   every workload of a refused model and for the one workload whose judge is
   refused; `llamactl bench preset` and `bench vision` exit 1, and the
   agent's bench subscriptions return the refusal as a stream error; the
   post-pull auto-tune records the preset or vision step as skipped with
   kind `exclusive-group-occupied`, and `llamactl candidate test` reports
   the step not run with the refusal as its reason.
   `llamactl keep-alive start` exits 1, locally or through the agent's
   `keepAliveStart` procedure, and the keep-alive worker's pre-start gate
   records `start-refused`; these keep-alive gates pass `ignoreModel` so
   only the target's own row is ignored, because the worker records that row
   itself through `runDirectResidencyStart` and
   `runDirectResidencyStop` (`keepAliveRecordedStart`,
   `keepAliveRecordedStop`). The refusal reads
   `residency lifecycle refused <id> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>`.
   It also refuses while a profile switch is in flight
   (`residency lifecycle refused <id>: profile switch in flight on this node; retry after it settles`)
   or when the store cannot be read
   (`residency lifecycle refused <id>: store unavailable (<error>)`). The
   gate is unfenced and never reconciles a proven-down peer, and a node with
   no store file launches as before.

Observable signals operators use today:

- catalog `availability.declared`;
- manifest `spec.enabled`;
- `llamactl get workloads` phases: Running / Stopped / Mismatch /
  Unreachable / Foreign, and unknown for a ModelHost whose node cannot
  confirm the recorded pid;
- the guard's Running / Starting / Unknown peer states;
- template readiness probes (e.g. `/ready` flipping to 200).

### Residency lifecycle states

`packages/core/src/residency/lifecycle.ts` is pure and synchronous:
states in, decisions out. `planProfileSwitch`
(`packages/core/src/residency/planner.ts`) is called by
`packages/remote/src/residency/procedures.ts` behind `llamactl residency
plan` and `apply-profile`. Since #726, `applyResidencyProfile` passes
`operation.lifecycle`, so `profile-transition.ts` wraps the executor deps
in `withResidencyLifecycle`
(`packages/remote/src/residency/lifecycle-steps.ts`). Each hop is a
`RESIDENCY_TRANSITIONS` edge: a victim walks `ready` → `draining` →
`unloading` → `downloaded`|`failed`; a replacement walks → `loading` →
`warming` → `ready`|`failed`; an observed same-group occupant refuses
with `ExclusiveGroupOccupied` before the engine runs. Since #741 (Part
of #517) the
direct ModelHost writers `modelHostStart`/`modelHostStop` route through
`packages/remote/src/residency/direct-lifecycle.ts`: they claim the shared
apply-profile fence, walk the row the same way, reconcile proven-down
same-group peers, and refuse a start while a profile switch is in flight.
The direct ModelRun writers `serverStart`/`serverStop` route through the same
wrapper, recording the group from the agent-side ModelRun
`llamactl.io/residency-group` label; when the stored ModelRun has no such label,
or no ModelRun is stored under the name, `serverStart` takes the group from the
catalog `residencyGroup` of the rel `resolveTarget` returns for its target
(`directModelRunStartOpts`), and a label always wins; when neither the inline
nor stored ModelHost has such a label, `modelHostStart` takes the group from the
catalog `residencyGroup` of its first hosted rel, the inline rel winning over
the stored rel (`directResidencyGroup`), and a label always wins. Operator
force-unload
(`residencyForceUnload`) routes its stop through the same wrapper after the
lease drain commits. Since #847 (Part of #517) the detached keep-alive worker
records its own row through the same wrapper: `keepAliveRecordedStart` and
`keepAliveRecordedStop` (`packages/cli/src/commands/keepAlive.ts`) wrap the
worker's engine start in `runDirectResidencyStart` and its worker-exit stop in
`runDirectResidencyStop`. The row is keyed by the keep-alive target as given,
not the resolved rel, and the start takes its group from the catalog
`residencyGroup` of the rel being started, so a failed start leaves the row
`failed` with that group and only a confirmed stop walks it to `downloaded`. A
keep-alive target has no ModelRun or ModelHost manifest, so
`directWorkloadProvenDown` (`packages/remote/src/router.ts`) proves it down
through `keepAliveWorkloadProvenDown` (see [dynamic-residency.md](dynamic-residency.md#direct-modelhost-start-and-stop)).
Bookkeeping never blocks a stop: a stop
whose claim or walk fails still runs and logs `not recorded`. A direct stop
runs before its row moves and walks it to `downloaded` only once the stop is
confirmed; an unconfirmed stop (the process may still be alive) leaves the row
occupying, so its exclusive group is not freed, and logs `not recorded:
unconfirmed stop (process may be alive)`. The profile
switch's own `applyManifest` calls run in a switch scope
(`runInResidencySwitchScope`) and are walked only by the switch. Still
pending: reconciliation outside these paths, and #276.
`llamactl residency status` reports these rows and any exclusive-group
violation (#731), and a wet switch refuses to unload a session-bound victim
with `SessionsActive` (#730; see [dynamic-residency.md](dynamic-residency.md)).

| state         | legal next states                | occupying |
| ------------- | -------------------------------- | --------- |
| `unavailable` | `downloaded`                     | no        |
| `downloaded`  | `loading`, `unavailable`         | no        |
| `loading`     | `warming`, `failed`, `unloading` | yes       |
| `warming`     | `ready`, `failed`, `unloading`   | yes       |
| `ready`       | `draining`, `failed`             | yes       |
| `draining`    | `unloading`, `failed`            | no        |
| `unloading`   | `downloaded`, `failed`           | no        |
| `failed`      | `downloaded`, `unavailable`      | no        |

The occupying states (`loading`, `warming`, `ready`) hold a group's
memory.

`RESIDENCY_GROUPS` declares `z13-large-gpu` as exclusive. Membership
comes from the catalog `residencyGroup` field and the
`llamactl.io/residency-group` label.

`evaluateResidencyTransition` checks, in order:

- The member must be present, else `UnknownMember`.
- The transition must be legal per the table, else `IllegalTransition`.
- Only when the target state is occupying and the member has a group,
  the group must be declared, else `UnknownGroup`. If that group is
  exclusive, no other member may be occupying it, else
  `ExclusiveGroupOccupied`, which carries the lowest-sorted occupying
  `peer`.
- Refusals return `{ ok: false, reason, detail }`.

`findExclusiveGroupViolations` reports every exclusive group with two or
more occupying members.

Lifecycle-row boot recovery (Part of #517) sweeps interrupted transient
states (`loading`, `warming`, `draining`, `unloading`) to `failed` under
the same claimed fence as the profile-switch operation recovery, releasing
exclusive-group capacity. On a claimed pass, i.e. when a stale profile-switch
row exists, it sweeps every interrupted row. When the store holds no
nonterminal operation row, it also sweeps lifecycle rows interrupted outside a
switch, such as a direct start whose agent died in `loading`, once they have
made no progress for 30 minutes and their workload is proven down, under its
own claim of the apply-profile fence. A workload that is not proven down, for
example an engine that outlived its agent, keeps its row. The outside-a-switch
pass also moves a stale `ready` row to `failed` over the legal `ready` ->
`failed` edge once it has made no progress for 30 minutes and its workload is
proven down, for example an engine that crashed, or a host that rebooted, while
its row read `ready`; the claimed pass never touches `ready` rows
(`ORPHAN_LIFECYCLE_STATES` in `packages/remote/src/residency/boot-recovery.ts`
is `INTERRUPTED_LIFECYCLE_STATES` plus `ready`). The agent passes
`directWorkloadProvenDown` as the proven-down predicate, and without one the
pass fails closed and never opens the store. A `ready` row younger than the
window, or one beside any nonterminal operation row, stays `ready` until a
later boot. The group is not wedged forever: before the window elapses an
operator stop or
`llamactl residency force-unload` also clears it. Any nonterminal operation row keeps
this sweep off. When no profile-switch row is nonterminal, boot recovery first
finishes `evict:` rows that have made no progress for 30 minutes as `unknown`,
so a crashed eviction no longer disables the outside-a-switch sweep; a younger
or malformed `evict:` row still keeps it off, and until then an operator stop or
`llamactl residency force-unload` clears a stuck interrupted row, and an
`evict:` row does not block either. It is implemented in
`runProfileSwitchBootRecovery` (`packages/remote/src/residency/boot-recovery.ts`)
with `failInterruptedLifecycleRows`. Per-row write failures and refusals
are contained and counted without stopping the sweep; a failed row
listing counts as one record failure. When the sweep moved at least one
row or recorded at least one failure, the agent logs one counts-only line:
`[residency] lifecycle boot recovery {"failed":N,"recordFailures":M}`. A
claimed pass logs it after the profile-switch line; the outside-a-switch pass
logs only this lifecycle line, with no profile-switch line. Its
`recordFailures` counts lifecycle rows only; the profile-switch line's
`recordFailures` counts operation rows only.

## Qualification and promotion

The five qualification stages: `experimental`, `candidate`,
`validated`, `production`, `degraded`.

Ladder: `experimental` → `candidate` → `validated` → `production`.
`degraded` is an overlay, not a rung.

`effectiveStage` (`packages/core/src/qualification/stages.ts`): a pin
wins over the declared stage; `health.ok === false` yields `degraded`
while keeping the base stage visible as `baseStage`.

Routing (`packages/core/src/routing/catalog.ts`): an experimental
candidate is eligible only when the client pins the exact id and no
non-experimental candidate exists; otherwise it is rejected with
`experimental-excluded`.

`admissionConflict` (`packages/core/src/routing/catalog.ts`) judges a
healthy advertisement (neither experimental nor degraded) only against
healthy candidates and local routes, so a healthy advertisement is
admitted for an id held only by degraded or experimental peer or
advertised candidates. Local routes stay authoritative, even a degraded
one, as in `listClusterRoutes` (#896); a degraded advertisement is judged
against every non-experimental candidate and an experimental advertisement
against all candidates, so neither ever shadows or joins a healthy or
degraded holder. `insertCandidate` places an admitted advertisement in the
same healthy, degraded, experimental order as `compareDeployments`. The
embersynth bench scorer never picks an experimental rel as a fusion node's
`modelId`: it
reads stages through `embersynthQualificationStages`
(`packages/remote/src/config/embersynth.ts`), which is
`catalogQualificationStages` with pin overrides applied. `llamactl
embersynth promote-private <rel>` exits 1 for an experimental rel, with
stderr "experimental models are served only on an exact model pin and
never under fusion-private-first" (#725). Under #728/#729 the ranked
replica hint never lifts an experimental replica over a non-experimental
one, and a session already bound to an experimental workload stays on it.

`benchCompare` (`packages/core/src/bench/compare.ts`) carries each row's
routing stage as `qualificationStage`, read through
`catalogQualificationStages`; the `promote-fastest-vision-model` runbook
never picks an experimental rel and reports excluded experimental rels on
the `excludedExperimental` field of the bench.compare step result; when
every benched installed multimodal rel is experimental the runbook returns
ok:false with an error listing the excluded rels and stating that
experimental models are served only on an exact model pin and never as a
preset default; a refused `llamactl.catalog.promote` step fails the
runbook before `llamactl.embersynth.sync`.

Bench scorers rank a degraded rel behind every healthy rel (#518): the
embersynth bench scorer (`summarizeBenchForMachine`,
`packages/remote/src/config/embersynth.ts`) picks a fusion node's `modelId`
from the fastest bench row that is neither experimental nor degraded and
falls back to the fastest degraded row only when the machine has no such
row, and the `promote-fastest-vision-model` runbook ranks a degraded rel
behind every healthy rel, promoting a degraded rel only when every eligible
rel is degraded. A degraded rel is demoted, not excluded: it stays eligible,
unlike an experimental one. Across nodes, a fusion node whose `modelId` fell
back to a degraded rel is advertised at priority 9
(`DEGRADED_NODE_PRIORITY`), behind every healthy bench band (1 to 8) and the
unbenched default 5 and ahead of the cloud provider default 10, so the
`preferLowerPriority` profiles prefer any node serving a healthy model; every
degraded node shares that priority.

`/v1/models?include=declared` reads the same stages: each `unavailable`
entry's `qualification.stage` is the routing stage from
`catalogQualificationStages` (so a pin replaces the catalog stage), and a
`declared` entry whose id's routing stage is experimental carries
`experimental: true`, the same flag a `data` entry carries. Neither array
is routable, so the flags only report; they change no routing decision.

The degraded stage is reported the same way (#518): a `data` entry whose
winning route is degraded carries `degraded: true`, and a `declared` entry
whose id's routing stage is degraded carries `degraded: true`; an
experimental route or stage never also carries `degraded`, because
experimental wins (`isDegradedRoute`, `packages/core/src/routing/capabilities.ts`).
Because the legacy order ranks a healthy route ahead of a degraded one, a
`data` entry carries the flag only when no healthy route serves the id.
The flag only reports; it changes no routing decision.

Peer-advertised qualification stages (#518): the `include=local-routes` fleet
snapshot (`buildLocalRoutesSnapshot`, `packages/remote/src/routes/fleet.ts`)
labels a workload `llamactl.io/qualification: experimental` when any of its
routes is experimental — a catalog row, an applied or pin override, or an
explicit label — and `llamactl.io/qualification: degraded` when any of its
routes carries the degraded stage. Experimental wins whenever a workload has
both kinds of route, whatever the route order, and a workload with neither
advertises no label at all. The peer poller (`collectPeerWorkloads`,
`packages/remote/src/server/peer-snapshot-poller.ts`) forwards only the
experimental and degraded stages onto each model id and advertises no other, so
the existing peer admission and catalog exclusion apply on other nodes,
including a peer's `ModelHost` alias ids and node-local pins. A peer can add an
exclusion or a demotion but never lift a stage: a degraded peer label never
lifts an inherited experimental stage, and the other non-experimental peer
stages (validated, candidate, production) are not propagated, so a peer route
still inherits this node's stage by exact id. Admission
(`admitPeerRoute`, `packages/core/src/workloadRuntime.ts`): a healthy peer —
neither experimental nor degraded — is admitted for an id held only by degraded
or experimental peer routes, which is what lets the unified ranker place the
degraded peer in its existing degraded tier behind the healthy one; local routes
stay authoritative, so a healthy peer is not admitted over any non-experimental
local route, a degraded local route included, and one healthy peer still closes
the id. The legacy (flag-off) order ranks a degraded route behind a healthy one
and ahead of an experimental one, so a healthy route leads the legacy
`/v1/models` listing and legacy chat forwarding: `orderedProxyRoutes`
(`packages/core/src/openaiProxy.ts`) and `compareDeployments`
(`packages/core/src/routing/catalog.ts`) carry the same healthy, degraded,
experimental tier. A second admitted peer route for the same id still logs a
route-map collision, which keeps the healthy route. When a fleet-supervisor
journal snapshot is served in preference to the fallback,
`readFleetSnapshotOrLocalRoutes` overlays the same qualification label onto each
journal workload whose workload name matches an
experimental or degraded local route — only for callers asking
`include=local-routes` (the peer poller over HTTP and tRPC). Without
`include=local-routes` the journal snapshot is served unchanged, a journal
workload with no experimental or degraded local route of the same workload name
carries no label, and an empty journal workload list or a failing route listing
serves the journal unchanged.

`proposePromotion` (`packages/core/src/qualification/promotion.ts`)
applies the first matching check, in source order: `frozen`, `pinned`,
`degraded`, `terminal-stage`, `no-thresholds`,
`insufficient-evidence`, `below-threshold`. A proposal moves exactly
one rung up the ladder. No threshold defaults ship — thresholds are
entirely caller-configured.

The promotion metrics (`PROMOTION_METRICS`): `firstAttemptSuccess`,
`repairSuccess`, `toolCallCorrectness`,
`structuredOutputValidity`, `regression`, `improvement`,
`memoryStability`, `runtimeReliability`.

Threshold keys (`PromotionThresholdsSchema`, all required, ranges from
zod):

| key                           | range           |
| ----------------------------- | --------------- |
| `minEvaluatedTasks`           | integer, >= 0   |
| `minFirstAttemptSuccess`      | ratio, 0 to 1   |
| `minRepairSuccess`            | ratio, 0 to 1   |
| `minToolCallCorrectness`      | ratio, 0 to 1   |
| `minStructuredOutputValidity` | ratio, 0 to 1   |
| `maxRegression`               | ratio, 0 to 1   |
| `minImprovement`              | number, -1 to 1 |
| `minMemoryStability`          | ratio, 0 to 1   |
| `minRuntimeReliability`       | ratio, 0 to 1   |

`autoApply` defaults to false. `applyPromotion` returns `skipped` for a
`none` decision, returns `proposed` unless `autoApply` is set AND a
writer is injected; `autoApply` without a writer writes nothing.

`writePresetOverride` (`packages/core/src/presets.ts`) refuses to promote a
rel whose stage is `experimental`, read through `catalogQualificationStages`,
so a later pin to a non-experimental stage lifts the refusal; experimental
models are served only on an exact model pin and never as a preset default.
Every promotion surface enforces it: `llamactl catalog promote` exits 1 with
the refusal on stderr, the `promote` procedure rejects with `BAD_REQUEST`, and
the MCP `llamactl.catalog.promote` tool returns `ok: false` (a dry run reports
`refused` instead of previewing a write).

`resolvePreset` skips an env or file preset override whose rel is experimental, read through `catalogQualificationStages` (so pins count), and falls through to the next layer. Each skip is reported on `skippedExperimental` in layer order. This covers a row written before the rel was pinned experimental, and every `resolveTarget` caller (server start, keepAlive, bench, workload apply) and `recommendationsForProfile`. When the builtin itself is pinned experimental (a pin row set after the rel was promoted), no lower layer exists to fall back to, so the builtin default is returned even when it is pinned experimental.

`recommendationsForProfile` copies `skippedExperimental` onto each recommendation row when it is non-empty. `llamactl recommendations`, local or `--node`, appends `skipped-experimental=<source>:<rel>` entries, comma-separated in layer order, after any `promoted=` note, and the row then shows the layer that actually won. The qwen and qwen27 rows never carry the field.

`llamactl qualification evidence --db <matrix.db> --model <name> --map <file.json> [--run-id <id>] [--baseline-run-id <id> [--baseline-model <name>]]`
builds promotion evidence from eval matrix cells plus an optional baseline
run. The adapter module is `qualificationEvidenceFromCells` (Part of #518,
`packages/eval/src/qualification/evidence.ts`).

The map file is a JSON object with a `metrics` key mapping absolute metric
names (`firstAttemptSuccess`, `repairSuccess`, `toolCallCorrectness`,
`structuredOutputValidity`, `memoryStability`, `runtimeReliability`) to
target workload names. `regression` and `improvement` are refused in the
map: they are computed from a baseline run, never declared in the map.
Each workload list is deduplicated; at least one metric key is required.

Evidence is computed as the n_rows-weighted mean of `primary_metric_value`
for each mapped metric, over the selected cells' workloads.
Latest-cell selection picks the cell with the greatest `finished_at` per
workload, with `run_id` breaking ties; `--run-id` restricts the candidate
pool to a single run. `evaluatedTasks` sums `n_rows` over all distinct
selected candidate cells (a workload mapped to multiple metrics is
counted once).

A selected cell with `n_rows` of 0 or less counts as missing
(`qualificationEvidenceFromCells` in `packages/eval/src/qualification/evidence.ts`):
latest-cell selection does not skip unscored cells, so when the latest
cell for a mapped workload is unscored the command exits 1 with `no
matrix cell for model <m> workload <w> (metric <metric>)`, even if an
earlier run scored it; `--run-id <id>` picks the scored run. A selected
baseline cell with `n_rows` of 0 or less is likewise a missing baseline
cell, for a workload that has a candidate cell.

With a baseline (`--baseline-run-id` plus `--baseline-model`, defaulting
`--baseline-model` to `--model`), `regression` is the fraction of
compared workloads whose `primary_metric_value` dropped below the
baseline (per `compareMetric`), and `improvement` is the n_rows-weighted
mean delta. Without `--baseline-run-id` the evidence carries no
`regression` or `improvement`, so `propose` answers `insufficient-evidence`.

The evidence ref format is
`matrix:<model>@<run ids>;baseline=<model>@<run id>`
when a baseline is set, or
`matrix:<model>@<run ids>` otherwise.

Three refusal paths:

- **missing-cells**: `no matrix cell for model <m> workload <w> (metric
<metric>)` for a missing candidate cell, or `no baseline matrix cell for
model <bm> run <id> workload <w>` for a missing baseline cell.
- **baseline-is-candidate**: `baseline run <id> is the candidate cell for
model <m> workload <w>` when a baseline cell's run_id and model match
  the candidate cell's.
- **ZodError**: `invalid map file '<path>'` for an invalid map file, or
  `invalid evidence from matrix cells` for evidence values out of range
  (such as a percent-scaled `primary_metric_value`).

The command opens the matrix db read-only and never writes the overrides
file, the db, or any state — it is strictly read-only.

### Demotion

The optional `demotion` block on the promotion policy carries the floors
that open the entry path into `degraded`
(`packages/core/src/qualification/demotion.ts`). `minEvaluatedTasks` is
the shared evidence gate; every other key is an optional floor, so a
policy checks only the floors it configures. No demotion defaults ship.

| key                           | comparison               |
| ----------------------------- | ------------------------ |
| `minEvaluatedTasks`           | evidence gate, inclusive |
| `minFirstAttemptSuccess`      | demote below             |
| `minRepairSuccess`            | demote below             |
| `minToolCallCorrectness`      | demote below             |
| `minStructuredOutputValidity` | demote below             |
| `maxRegression`               | demote above             |
| `minImprovement`              | demote below             |
| `minMemoryStability`          | demote below             |
| `minRuntimeReliability`       | demote below             |

`proposeDemotion` applies the first matching check, in source order:
`frozen`, `pinned`, `already-degraded`, `not-demotable`,
`no-thresholds`, `insufficient-evidence`, `within-tolerance`. A `freeze`
or `pin` override blocks demotion just as it blocks promotion (freeze
wins). A declared `degraded` stage is already demoted
(`already-degraded`); a declared `experimental` stage never reached a
demotable rung (`not-demotable`). A missing `demotion` block, or one with
only `minEvaluatedTasks` and no floor, reports `no-thresholds`; evidence
below `minEvaluatedTasks`, or a configured floor whose metric is absent
or non-finite, reports `insufficient-evidence`; otherwise, if no
configured floor is breached, `within-tolerance`.

Breach comparisons are strict: value above `maxRegression`, or value
below a min floor — a metric sitting exactly on its floor stays within
tolerance. Breaches report in `PROMOTION_METRICS` order and a demotion
proposal moves the rel from `candidate`, `validated` or `production` to
`degraded`.

`evaluateQualification` runs the demotion path before promotion: a
demotable stage past a floor returns a demotion, and everything else
falls through to the untouched `proposePromotion` decision.
`applyQualification` gates either decision kind through the same
`autoApply` flag (default off): a `none` decision is `skipped`,
`autoApply` without an injected writer stays `proposed`, and only
`autoApply` with a writer applies. `health` stays the runtime overlay in
`effectiveStage` and never triggers a persisted demotion here.

Effective status at this commit: `llamactl qualification status` and `list`
call `effectiveStage` (see Overrides). `llamactl qualification propose` is
the read-only consumer of `evaluateQualification` and `applyQualification`,
and `llamactl qualification apply <rel> --evidence <file> --policy <file>
[--author <name>]` is the writer consumer: with `autoApply: true` it records
the transition through `writeAppliedStage`, and `llamactl qualification
unapply <rel>` removes the row (see Overrides). `proposePromotion`,
`applyPromotion` and `proposeDemotion` remain library-only; the remaining
apply-path surfaces — tRPC/MCP/ops-chat projection and scheduled triggers —
are pending DF-11 / #284. The overrides reader has one consumer: routing
applies its applied and pin rows (see Overrides).

`llamactl qualification propose <rel> --evidence <file> --policy <file>
[--json]` reads an evidence file and a policy file and reports a promotion,
a demotion or a refusal without writing anything. The evidence file is
validated by `parsePromotionEvidence` against the strict
`PromotionEvidenceSchema`, so unknown keys are refused and each metric
carries its threshold's bound (ratios in [0, 1], `improvement` in [-1, 1]),
which refuses percent-scaled evidence; the policy file is validated by
`PromotionPolicySchema`, which also refuses unknown top-level keys such as
an `autoapply` typo. The declared stage is the applied
stage, falling back to the catalog stage, then the pin stage, and an
unstaged rel is refused. The freeze, pin and applied rows come from the
shared overrides file. `applyQualification` is called without a writer, so
`autoApply: true` still reports `proposed` and nothing is written.

## Overrides

Pin/freeze/applied override rows live in `qualification-overrides.tsv`
(`packages/core/src/qualification/overrides.ts`), keyed on
`(rel, action)`:

- `pin` freezes promotion while declaring the stage the model is held
  at — it requires a stage.
- `freeze` blocks promotion and must carry an empty stage.
- `applied` records the stage a gated promotion or demotion actually
  reached — it requires a stage like `pin`, and `llamactl qualification
apply` writes it through `writeAppliedStage`.

Columns: `rel`, `action`, `stage`, `author`, `reason`, `updated_at`.

Resolution order: `LOCAL_AI_QUALIFICATION_OVERRIDES_FILE`, otherwise
`qualification-overrides.tsv` under the runtime dir.

Writer semantics: a write replaces the `(rel, action)` row and drops
`#` comments and invalid rows present before the write. A delete
removes the file entirely when it empties.

Routing reads this one shared file. `catalogQualificationStages`
overlays the overrides in two passes: every `applied` row's stage
first, then every `pin` row's, over the catalog stage for its `rel`
(also for a rel the catalog never staged), so a pin wins over an
applied stage whatever the file order, and both change the stage the
route builders and `/v1/models` see. A `freeze` row has no routing
effect: it leaves the stage unchanged, and only the library-only
`proposePromotion` check (`frozen`) consults it. The OpenAI proxy's
`/v1/models` cache signature stats the same resolved file, so an edit
takes effect without a workload restart.

Operator surface (Part of #518): `llamactl qualification` writes these rows
through `writeQualificationOverride` and `deleteQualificationOverride`,
always to the file `qualificationOverridesFileFor` resolves — the same file
`catalogQualificationStages` and the `/v1/models` cache signature read.
`llamactl qualification pin <rel> <stage> --reason` writes a pin row;
`llamactl qualification unpin <rel>` removes it. `llamactl qualification
freeze <rel> --reason` writes a stageless freeze row; `llamactl
qualification unfreeze <rel>` removes it. `llamactl qualification apply
<rel> --evidence <file> --policy <file> [--author <name>]` evaluates the
evidence against the policy and records the transition as an `applied` row
through `writeAppliedStage`, gated by the policy's `autoApply`: without it
apply reports `proposed` and writes nothing, and a `none` decision is
`skipped`, also writing nothing; `llamactl qualification unapply <rel>`
removes the applied row. `llamactl qualification status <rel>` prints the
effective, catalog, pin, freeze and applied rows; `llamactl qualification
status <rel> --json` and `llamactl qualification list --json` report the
catalog stage, the pin, the freeze, the applied row (`null` when absent,
consistent with pin and freeze), `effectiveStage` and the routing stage;
the `list` text output omits the applied row. The overrides file is
node-local, so every subcommand refuses a non-local `--node` target.

### Reading `llamactl qualification` output

Every subcommand prints plain text on stdout and exits 0
(`packages/cli/src/commands/qualification.ts`). `list`, `status`, `propose`
and `apply` print JSON instead with `--json` — one JSON object for `status`,
`propose` and `apply`, one JSON array of those objects for `list` — and
`evidence` always prints JSON. Every refusal goes to stderr and exits 1.
With no subcommand, or with `help` or `--help`, it prints the usage and
exits 0; an unknown subcommand prints
`Unknown qualification subcommand: <subcommand>`, then the usage.

The line forms below are written space-separated, and only two of them use
tabs in the real output. Each `status` line puts one tab between its label
(the rel, on the first line) and its value; the value keeps its own spaces.
Each `list` row puts a tab between each of its five fields. Every other line
is space-separated exactly as written: the `pin`, `freeze`, `unpin`,
`unfreeze` and `unapply` success lines, the `overrides: <file>` line, the
`proposal`, `demotion` and `none` decision lines, and every `apply: ...`
line.

On a non-local `--node` target, every subcommand exits 1 before reading
anything, with `qualification: overrides are node-local; run this command on
the target node (selected node '<node>' is not local)`.

Every subcommand that takes a rel refuses a missing one with
`qualification <verb>: <rel> is required`, followed by the usage; for
`status` that reads `qualification status: <rel> is required`.

`pin` prints `pinned <rel> at <stage>` and `freeze` prints `froze <rel>`;
`unpin`, `unfreeze` and `unapply` print `unpinned <rel>`, `unfroze <rel>`
and `unapplied <rel>`. Each success adds a second line, `overrides: <file>`,
naming the overrides file it wrote. `pin`, `freeze` and `apply` take
`--author`, which names the author on the row they write; it defaults to the
OS user name, else `operator`. The write refusals are:

- `pin` refuses with `qualification pin: <stage> is required`, or with
  `qualification pin: unknown stage '<stage>' (expected experimental | candidate | validated | production | degraded)`.
- `pin` and `freeze` refuse a missing or empty `--reason` with
  `qualification <verb>: --reason is required`.
- A row that the overrides schema rejects is refused with
  `qualification <verb>: ` followed by the schema's issue messages.
- Removing a row that is absent exits 1 with
  `qualification unpin: no pin override for '<rel>'`,
  `qualification unfreeze: no freeze override for '<rel>'` or
  `qualification unapply: no applied stage for '<rel>'`.

`status <rel>` prints five tab-separated lines: `<rel> <effective stage>`,
`catalog <stage>`, `pin <stage> (<author>): <reason>`,
`freeze <author>: <reason>` and `applied <stage> (<author>): <reason>`. It
prints `-` for an absent value, and `unstaged` as the effective stage when
the rel has no declared stage. The declared stage is the applied stage, else
the catalog stage, else the pin stage (`declaredFor`).

`list` prints no header line. It prints one tab-separated line per rel,
sorted: `<rel> <catalog stage> <pin stage> <frozen> <effective stage>`, over
every rel with a catalog stage plus every rel with an override row.
`<frozen>` reads `frozen` or `-`, an absent catalog or pin stage reads `-`,
and an absent effective stage reads `unstaged`. The text output has no
routing-stage or applied column; `--json` carries both.

`propose` and `apply` each print a decision line, then an apply line. The
decision line is `proposal <rel> <from> -> <to>`,
`demotion <rel> <from> -> <to> (breached: <metrics>)` or
`none <rel>: <reason>`; for a `below-threshold` refusal
` (failed: <metrics>)` is appended. `propose` always follows with
`apply: <status> (nothing written; autoApply has no writer here)`. `apply`
follows with one of three lines:

- `apply: applied <rel> <from> -> <to>`, plus `overrides: <file>`, after a
  write;
- `apply: proposed (nothing written; policy autoApply is off)`;
- `apply: skipped (nothing written)` for a `none` decision.

With `--json`, both print one object with `rel`, `declared`,
`overridesFile`, `decision` and `apply`.

Each `propose` and `apply` refusal exits 1 with a message prefixed
`qualification <verb>: `. They are `--evidence is required` and
`--policy is required`; `cannot read evidence file '<path>'`,
`invalid JSON in evidence file '<path>'` and
`invalid evidence file '<path>': <issues>`, where each issue is prefixed
with its key path, and the same three forms exist for the policy file;
`'<rel>' has no qualification stage`; `invalid policy: <issues>` when the
gate's re-parse of the policy refuses it; and, for `apply` only,
`cannot record applied stage: <detail>` when `writeAppliedStage` refuses the
row or the write fails. Only the Zod refusal guarantees that nothing was
written; an IO failure says nothing about the file.

## Exclusive-window runbook

Manual procedure, before DF-06 / #279 automates the swap.

Every z13 template is committed `enabled: false`. Enabling one needs
an operator-approved window that swaps production out, as the template
headers say. The residency-group guard above blocks a second
same-group ModelHost, but it does not cover the production workload,
whose name and group membership are node-local and not in this repo —
swapping production out stays an operator step.

The thirteen z13-large-gpu templates (runtime-arm label where present, and
port):

| metadata.name                         | runtime arm                | port |
| ------------------------------------- | -------------------------- | ---- |
| `gufo-glm53-exp`                      | `G2c8-incoai-dc77ff1c99ee` | 8081 |
| `libosmos-ds41-d-o2-t00-z13`          | `D-O2-T00`                 | 8099 |
| `libosmos-ds41-ud-iq1m`               | `libosmos-934b51b932be`    | 8085 |
| `libosmos-ds41-ud-iq1s`               | `libosmos-934b51b932be`    | 8092 |
| `llamacpp-deepseek41-flash-iq1s`      | none                       | 8084 |
| `llamacpp-ds41-ud-iq1m-hip-b12206`    | `D-L-cf34d311332e`         | 8090 |
| `llamacpp-glm53-g-h1-t03-z13`         | `G-H1-T03`                 | 8098 |
| `llamacpp-glm53-hip-b12206`           | `G-H1-cf34d311332e`        | 8087 |
| `llamacpp-glm53-vulkan-halo`          | `G-V1-e742170e08db`        | 8086 |
| `llamacpp-mimo-m-v1-t06-z13`          | `M-V1-T06`                 | 8097 |
| `llamacpp-mimo26-bpw25-vulkan-b12206` | `M-V2-cf34d311332e`        | 8089 |
| `llamacpp-mimo26-bpw25-vulkan-halo`   | `M-V1-e742170e08db`        | 8088 |
| `llamacpp-mimo26-flash-bpw25`         | none                       | 8083 |

Steps:

1. Get operator approval for the window.
2. Record the current state with `llamactl get workloads` and
   `llamactl residency status --node <node>`. Its `Lifecycle:` block lists
   the serving process's `residency_states` rows, one
   `<model>  <state>  group <group>  version <n>` line each, and its
   `Exclusive:` line reads `no violations` or `violation in <group>:
<members>` (see
   [dynamic-residency.md](dynamic-residency.md#status-plan-and-apply-profile)).
   After production is stopped in step 3 and before step 6, run it again
   and open the window only when no other `z13-large-gpu` row occupies the
   group: in step 6 another `loading` or `warming` row, or a `ready` row
   whose workload is not proven down, refuses the start with
   `ExclusiveGroupOccupied`. A node with no residency store prints
   `Lifecycle:  0 workload(s) (scope: serving-process)` and `Exclusive:  no
violations`; an unreadable store prints `Lifecycle:  unavailable (store
unreadable; scope: serving-process)` or `Lifecycle:  unavailable
(lifecycle rows unreadable; scope: serving-process)` and no
   `Exclusive:` line, and an agent that predates the section prints no
   `Lifecycle:` line.
3. Stop production: `llamactl disable <production-workload>` (the
   node-local production workload name; it is not in this repo).
   Confirm it reads Stopped in `llamactl get workloads`.
   `llamactl get workloads` prints one row per manifest under the
   columns `NAME`, `NODE`, `KIND`, `PHASE` and `REL`, where `KIND` is
   `modelrun` or `modelhost` and `REL` is a ModelRun's target or a
   ModelHost's hosted model rels joined by commas; an empty store
   prints `No workloads registered.` and `--json` prints the rows as a
   JSON array instead. A ModelHost whose `spec.node` is `local` reads
   `Stopped` when it has no runtime state file, `Unreachable` when a
   state file exists but its endpoint does not answer, `Foreign` when
   the endpoint answers but its recorded pid is not alive or another
   pid holds its port, and `Running` otherwise; any other ModelHost,
   including every z13 template (`node: z13`) even when llamactl runs
   on z13 itself, reads what its node's agent reports: `Running`,
   `Stopped`, `unknown` when the node cannot confirm the recorded pid,
   or `Unreachable` when the node query fails or misses its deadline
   (10 s by default, or the node's `rpcTimeouts.queryMs` in the
   kubeconfig). A ModelRun reads `Foreign` when a process llamactl did
   not record answers on its port, `Running` when its node reports the
   server up on the manifest's target, `Mismatch` when it is up on
   another rel, `Stopped` otherwise, including when the node cannot
   confirm the recorded pid, and `Unreachable` when the node query
   fails or misses its deadline; a gateway ModelRun shows its stored
   phase, `Pending` when none was written. Below the table, a
   non-loopback ModelHost adds a `warning: modelhost/<name> binds an
   unauthenticated engine to <host:port>` line, an externally managed
   ModelHost adds a `note: modelhost/<name> is managed by <controller>`
   line, and a row whose node query failed adds `unreachable:
   <kind>/<name> on node <node>, last answered <time|never>: <error>`.
   `Stopped` confirms the stop only when `llamactl describe workload
   <production-workload>` shows no `"identityUnknown": true` under
   `LiveStatus:`, because a ModelRun whose recorded pid cannot be
   confirmed also reads `Stopped` while its process may still be
   resident; `Unreachable`, `Foreign` and `unknown` never prove the
   process is gone. With the lease
   registry on (`LLAMACTL_RESIDENCY_LEASES`), the node stop fence can
   refuse a disable: `llamactl disable` exits 1 with `disable:
serverStop refused: <reason>: <ids>` for a ModelRun (the `: <ids>`
   part is left out when no ids are reported) or `disable:
modelHostStop refused: <reason>: <ids>` for a ModelHost, where
   `<reason>` is `LeasesActive`, `DrainInProgress`, `SessionsActive` or
   `SessionsUnknown`. The manifest is already stored with `spec.enabled:
false`, but nothing was stopped and the engine keeps serving. Before
   the window, check the `Sessions:` section of `llamactl residency
status --node <name>`; the disable never releases sessions, so the
   overrides are `llamactl residency release-session <sessionId> --yes
--node <name>` for an idle binding and `llamactl residency
force-unload <workload> --reason <text> --yes --node <name>`, after
   which run the disable again. An in-flight binding refuses the release
   as `SessionInFlight` unless `--force` is given, and a forced release
   leaves its leases held, so the stop still refuses as
   `LeasesActive`; force-unload is the override then.
4. Diff the template against the z13 state copy, as the
   `gufo-glm53-exp` header and the GLM HIP `TODO(#557)` require.
5. `llamactl apply -f templates/workloads/<file>`. The template is
   committed `enabled: false`, so this stores the manifest disabled
   and does not start the engine.
6. `llamactl enable <name>`. This loads the stored manifest, sets
   `spec.enabled=true` and re-applies. `enable` fails with
   "workload not found" for a name that was never applied. If the
   start is refused with "already has … ModelHost …", stop that peer
   first. When the agent's residency store exists, the start can also
   be refused with "residency lifecycle refused <name> …:
   `ExclusiveGroupOccupied` …" (a same-group row still occupying;
   inspect with `llamactl residency status --node <name>`), or with
   "residency lifecycle refused <name>: profile switch in flight on
   this node; retry after it settles" (#741; see
   [dynamic-residency.md](dynamic-residency.md#direct-modelhost-start-and-stop)).
7. Wait for the readiness probe, then `llamactl describe workload <name>`.
   For a ModelHost, `llamactl describe workload <name>` prints the
   manifest as `Name:`, `Kind:`, `Node:`, `Engine:`, `Binary:`,
   `Models:`, `Endpoint:`, `Enabled:`, `ExtraArgs:` and
   `RestartPolicy:` lines, an `IdleHold:` line only when the manifest
   carries the idle hold, then its history (for a `local` host a
   `Source:` line and the conditions only when the node reports them;
   for any other host always a `Source: controller history` line, then
   a `NodeHistory:` line when the node reports its own conditions), and
   last a `LiveStatus:` block holding the node's `modelHostStatus`
   JSON. It prints no `PHASE` column: the engine is up when
   `LiveStatus:` carries `"state": "Running"` with its `"pid"`;
   `"state": "Stopped"` without `"identityUnknown": true` means no live
   recorded process, `"state": "Stopped"` with `"identityUnknown": true`
   means the node cannot confirm the recorded pid and the engine may
   still be resident, and an `"error"` object means the node query failed
   or missed its deadline. For a ModelRun it prints `Name:`, `Node:`,
   `Target:`, `ExtraArgs:` and `RestartPolicy:` lines, an optional
   `IdleHold:` line, a `Status:` line reading
   `phase=<phase> endpoint=<endpoint|none> pid=<pid|none> since=<time>`
   when the manifest has a stored status, and the node's `serverStatus` JSON
   under `LiveStatus:`, whose `"state"` is `"up"` or `"down"`;
   `"down"` with `"identityUnknown": true` means the recorded pid
   cannot be confirmed and the server may still be resident, an
   `"error"` object means the node query failed or missed its deadline,
   and the `Status:` line is the stored status, not a live probe.
8. Run the eval against the engine the window started, with `--url`
   pointing at it: `llamactl eval perf --url <http://...> --engine
<llamacpp|omlx|gufo|kapitsa> --model <id>` for perf evidence (see
   [Capturing evidence for an arm](#capturing-evidence-for-an-arm)), or
   `llamactl eval run <model> --url <http://...>` for the four
   sub-benches, where `<model>` is only the leaderboard tag and nothing
   is spawned or killed. Without `--url`, `llamactl eval run <model>`
   spawns its own sandbox engine in the CLI process, beside the
   window's engine, so when the local residency store exists on the
   host running the eval and the catalog row for `<model>` declares
   `z13-large-gpu`, it reads that store read-only and exits 1 without
   spawning: `eval run: residency lifecycle refused <model> downloaded
-> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is
held by <member> in state <state>`. On the agent host the window's
   own workload is such a holder: `llamactl enable` in step 6 records
   its `loading`, `warming` or `ready` row in `z13-large-gpu`, and the
   check counts every occupying row, so an in-window `eval run` without
   `--url` refuses there (see
   [dynamic-residency.md](dynamic-residency.md#direct-modelhost-start-and-stop)).
9. Exit the window: `llamactl disable <name>`, then
   `llamactl enable <production-workload>`, then verify Running and
   readiness. Verify Running as `Running` in the `PHASE` column of
   `llamactl get workloads` for the production workload and, in
   `llamactl describe workload <production-workload>`,
   `"state": "Running"` under `LiveStatus:` for a ModelHost or
   `"state": "up"` for a ModelRun. A disable is never blocked by this
   bookkeeping and at worst logs "not recorded" (#741). The stop fence is
   separate from this bookkeeping and can refuse the exit-step disable the
   same way (see step 3). After `llamactl disable <name>` and before
   `llamactl enable <production-workload>`, run
   `llamactl residency status --node <node>` again. A confirmed stop walks
   the window workload's row `ready` -> `draining` -> `unloading` ->
   `downloaded`, which frees `z13-large-gpu`, and a stop that throws walks
   it to `failed`, which does not occupy the group either. An unconfirmed
   stop (the process may still be alive) is never recorded: the agent logs
   `[residency] lifecycle <name> stop not recorded: unconfirmed stop
(process may be alive)` and the row stays occupying, so a later
   same-group start is refused with `ExclusiveGroupOccupied` until the
   workload is proven down, and an `eval run` without `--url` keeps
   refusing while the row occupies. With the lease registry on
   (`LLAMACTL_RESIDENCY_LEASES`), `llamactl residency force-unload <name>
--reason <text> --yes --node <node>` is the override: it runs the same
   stop, so it is confirmed only once the engine process is verified gone,
   and a confirmed force-unload walks the row to `downloaded` while an
   unconfirmed one keeps it occupying. Without the lease registry,
   force-unload exits with `residency force-unload: Unavailable: no
residency lease registry installed; nothing to fence`, stops nothing
   and leaves the row as it is. Close the window when `Exclusive:` reads
   `no violations` and the window workload's row is not `loading`,
   `warming` or `ready`; a `ready` row left by an unconfirmed stop can be
   closed over only once its engine process is proven down, since it then
   no longer refuses a direct start but still refuses an `eval run` without
   `--url`.

Never run two group members at once, given the two-process race in
the guard.

## Download, checksum and rollback

`llamactl pull file <hf-repo> <gguf-file>` takes a plain HF repo id.
At this commit it does not pin a revision or verify checksums, and it
auto-runs a bench tune unless `--no-tune` is passed (or
`LLAMA_CPP_AUTO_TUNE_ON_PULL` is disabled). Use `--no-tune` outside a
window, or download the pinned revision manually.

Pinned revisions live in `packages/core/src/catalog.ts` comments.
Only `glm53-flash-a4e3s`, `deepseek41-flash-1017-ud-iq1s`,
`deepseek41-flash-1017-ud-iq1m` and `mimo26-flash-mopd-bpw25` use the
`<repo>-<owner>/<rev8>/...` models-root layout.

- `glm53-flash-aj-iq2xxs` uses its Z13 on-disk dir; no HF repo
  carries that name.
- `mimo26-flash-mopd-a4x` has a captured revision but a quant-dir-only
  rel.
- `deepseek41-flash-1017-gsq-rco-iq1m` and `mimo26-flash-mopd-bpw30`
  have no captured revision; pin them before download.

Procedure: download the pinned revision into the rel path, verify
each shard's sha256 against the HF LFS oid at that revision manually,
then change availability via the catalog-PR path above.

Rollback: delete partial shards and run the runbook exit step. A `pin`
override row is a routing lever: `catalogQualificationStages` applies its
stage, so pinning a rel to `experimental` keeps it out of alias,
advertised and fusion picks (it stays reachable only on an exact model
pin when no non-experimental candidate exists). A `freeze` row has no
runtime effect and is not a rollback lever. TTM/GTT kernel-parameter
rollback is not covered by repo code and is out of scope.

### What `llamactl pull` does with a candidate row

`llamactl pull file` and `llamactl pull candidate` run `hf download <repo> <file> [<mmproj>] --local-dir <target>` with `<target>` defaulting to `$LLAMA_CPP_MODELS/<repo-basename>` (`pullRepoFile`, `packages/core/src/pull.ts`), adding the `<mmproj>` argument when the repo's model info lists one, and the argv never carries `--revision`, so the fetch tracks the repo's current default head rather than the catalog row's pinned revision.

Every `.gguf` rel in the candidate set names only the first shard of its multi-part file — `...-00001-of-NNNNN.gguf` — and `llamactl pull` fetches the file it is given (plus the repo's mmproj file when its model info lists one), so pulling a candidate rel lands shard 1 alone; the remaining shards are not fetched.

`relFromRepoAndFile` (`packages/core/src/catalog.ts`) does not learn the `<repo>-<owner>/<rev8>/...` models-root layout, so `llamactl pull` cannot reproduce the catalog rel of `glm53-flash-a4e3s`, `deepseek41-flash-1017-ud-iq1s`, `deepseek41-flash-1017-ud-iq1m` or `mimo26-flash-mopd-bpw25` from a plain file argument.

A file argument that already contains `/` is kept as the rel verbatim — `UD-IQ1_S/X-00001-of-00005.gguf` stays `UD-IQ1_S/X-00001-of-00005.gguf` — while the download still targets `$LLAMA_CPP_MODELS/<repo-basename>` (`pullRepoFile`, `packages/core/src/pull.ts`).

`maybeTuneAfterPull` (`packages/core/src/autotune.ts`) runs the post-pull bench only when the file was absent before the pull — a re-pull skips with `Model was already on disk` — and only while `LLAMA_CPP_AUTO_TUNE_ON_PULL` is enabled, otherwise it skips with `LLAMA_CPP_AUTO_TUNE_ON_PULL=off`; `--no-tune` skips the call entirely (`packages/cli/src/commands/pull.ts`).

The bulk form `llamactl pull <hf-repo> [target-dir]` runs `hf download <repo> --local-dir <target>` through `pullRepo` (`packages/core/src/pull.ts`) with no auto-tune — the usage string says `(No auto-tune.)` — and `runPullRepo` (`packages/cli/src/commands/pull.ts`) invokes it in-process with no node-client dispatch, so the bulk pull never fans out to `--node`.

`llamactl pull candidate <hf-repo> [gguf-file] [profile]` auto-picks only when no file is given: it reads HF model-info, keeps the `eligibleGgufSiblings` set (`packages/core/src/discovery.ts`) — which drops mmproj sidecars, bf16/fp16/f16 directories and every `-NNNNN-of-NNNNN.gguf` shard — and walks the profile's quant ladder, while an explicit file argument short-circuits the HF lookup and is pulled verbatim with `source: "requested"` (`pickCandidateFile`, `packages/core/src/pull.ts`).

`packages/core/src/pull.ts` carries no checksum code — no `sha256`, no `createHash` — so `llamactl pull` stores whatever `hf download` writes without verifying it, and per-shard sha256 verification against the HF LFS oid stays the manual step above.

The `hf` binary resolves through `resolveHfBin` (`packages/core/src/pull.ts`): `LOCAL_AI_HF_BIN` wins when set, then `hf` or `huggingface-cli` on `PATH`, then the literal `hf`; the token resolves from `HF_TOKEN`, then `HUGGING_FACE_HUB_TOKEN`, then `$HF_HOME/token` (default `~/.cache/huggingface/token`).

## GLM-5.3-Flash z13 eval record

One row per GLM template arm; one column per promotion metric.

| arm                        | template                      | `firstAttemptSuccess` | `repairSuccess` | `toolCallCorrectness` | `structuredOutputValidity` | `regression`  | `improvement` | `memoryStability` | `runtimeReliability` |
| -------------------------- | ----------------------------- | --------------------- | --------------- | --------------------- | -------------------------- | ------------- | ------------- | ----------------- | -------------------- |
| `G2c8-incoai-dc77ff1c99ee` | `gufo-glm53-exp`              | `unavailable`         | `unavailable`   | `unavailable`         | `unavailable`              | `unavailable` | `unavailable` | `unavailable`     | `unavailable`        |
| `G-V1-e742170e08db`        | `llamacpp-glm53-vulkan-halo`  | `unavailable`         | `unavailable`   | `unavailable`         | `unavailable`              | `unavailable` | `unavailable` | `unavailable`     | `unavailable`        |
| `G-H1-cf34d311332e`        | `llamacpp-glm53-hip-b12206`   | `unavailable`         | `unavailable`   | `unavailable`         | `unavailable`              | `unavailable` | `unavailable` | `unavailable`     | `unavailable`        |
| `G-H1-T03`                 | `llamacpp-glm53-g-h1-t03-z13` | `unavailable`         | `unavailable`   | `unavailable`         | `unavailable`              | `unavailable` | `unavailable` | `unavailable`     | `unavailable`        |

Notes:

- Catalog row `glm53-flash-a4e3s` is `artifact-not-downloaded`; the
  catalog `glm53-flash-aj-iq2xxs` row backs the Gufo arm.
- `llamacpp-glm53-hip-b12206` has no catalog row yet
  (`TODO(#557)`).
- No z13 measurement is committed in this repo, mirroring the
  `MetricValue` `{ value: null, status: "unavailable", reason }`
  convention in `packages/eval/src/matrix/types.ts`. Template headers
  carry self-reported figures; they are not committed evidence and are
  not repeated here.

### Capturing evidence for an arm

The synopsis is
`llamactl eval perf --url <http://...> --engine <llamacpp|omlx|gufo|kapitsa> --model <id>`,
followed by the optional flags
`[--suite perf-quick|perf-full] [--pid <n>] [--binary <path>] [--gguf <path>] [--hf-revision <rev>] [--quant <q>] [--ctx <n>] [--slots <n>] [--flags=<args>] [--db <path>] [--run-id <id>] [--launch]`.
Both are copied verbatim from the USAGE text (`USAGE`,
`packages/cli/src/commands/eval.ts`), and every valued flag in it is in
`VALUED_FLAGS` (`packages/cli/src/commands/eval-perf.ts`).

The command runs the perf suite against an engine that is already serving at
`--url`. Without `--launch` it never starts or stops the engine, so the operator runs it inside
the exclusive window after step 7 of the runbook. `--engine` defaults to
`llamacpp`. `--suite` defaults to `perf-quick`; the other choice is
`perf-full`. It reads `/v1/models` first, and when `--model` is not listed it
exits 1 with `engine at <url> is not serving '<model>' (serving: ...)`
(`runEvalPerf`, `packages/cli/src/commands/eval-perf.ts`).

Rows go to `perf.sqlite` under `eval/` in the llamactl home, which is
`$DEV_STORAGE` or `~/.llamactl` (`defaultPerfDbPath`,
`packages/cli/src/commands/bench-schedule.ts`), or to `--db`. It is
the same `perf.sqlite` as `bench schedule` suites. The run prints
`run_id: <id>` and then a `| metric | status | value | reason |` table
(`runEvalPerf` and `printPerfTable`,
`packages/cli/src/commands/eval-perf.ts`). `--run-id <id>` overrides the
id; otherwise it is generated from the model and the run timestamp.

Because host counters are read on this machine, `--pid` needs a loopback
`--url` (`resolveRunInput`, `packages/cli/src/commands/eval-perf.ts`). On Linux with `--pid`,
SSD read and write bytes come from `/proc/<pid>/io` and peak RSS comes from
`VmHWM` in `/proc/<pid>/status`. Without `--pid`, those counters are recorded
`unavailable` with a reason naming the unknown engine PID
(`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`). With --launch, peak RSS is read from the launched engine instead; see Measured load with --launch. GTT comes from the GTT probe on
any loopback Linux run, with or without `--pid`
(`hostReaders`, `packages/cli/src/commands/eval-perf.ts`). On macOS with `--pid`,
`proc_pid_rusage` with flavor `RUSAGE_INFO_V2` fills `ri_diskio_bytesread` and
`ri_diskio_byteswritten`, and their per-sample deltas are the SSD read and write bytes
(`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`, and
`defaultProcPidRusage`, `packages/eval/src/perf/darwin-rusage.ts`).
On macOS with `--pid`, `proc_pid_rusage` with flavor `RUSAGE_INFO_V4` fills
`ri_lifetime_max_phys_footprint`, and its value is the peak RSS
(`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`).
GTT is Linux-only; on macOS it is recorded `unavailable` with a named reason
(`hostReaders`, `packages/cli/src/commands/eval-perf.ts`). On any other platform SSD I/O
records `per-process disk I/O counters are read from /proc/<pid>/io on Linux and
proc_pid_rusage on macOS; no I/O reader on <platform>`. With a non-loopback URL, every
host counter is recorded `unavailable`, with a reason naming the remote engine
(`remoteReasons`, `packages/cli/src/commands/eval-perf.ts`).

The 16 `PERF_METRIC_NAMES` (`packages/eval/src/perf/metrics.ts`) are
`load_cold_ms`, `load_warm_ms`, `prefill_4k_tps`, `prefill_16k_tps`,
`prefill_32k_tps`, `prefill_64k_tps`, `decode_tps`, `ttft_ms`,
`spec_acceptance`, `c1_tps`, `c2_tps`, `c4_tps`, `ssd_read_bytes`,
`ssd_write_bytes`, `peak_rss_bytes` and `peak_gtt_bytes`. `eval perf` records
perf metrics, not promotion metrics, so it does not fill the table above. The
promotion cells stay `unavailable` until promotion evidence is committed.

`--binary` gives the engine version, the engine commit and the `binary_sha256`.
`--gguf` gives `gguf_sha256`. `hf_revision` is derived from an HF
`snapshots/<rev>/` path unless `--hf-revision` is given. `--quant`, `--ctx`
and `--flags` fill their fields. Each `PROVENANCE_UNAVAILABLE_FIELDS` field
(`packages/eval/src/matrix/types.ts`) — `engine_version`,
`engine_commit`, `binary_sha256`, `gguf_sha256`, `hf_revision`, `quant`, `ctx` and `flags` — is either a value or null with a reason in `provenance.unavailable`.
For example, "gguf path is not under an HF snapshots/<rev>/ directory"
(`collectHfRevision`, `packages/eval/src/perf/provenance.ts`). `gguf_sha256` hashes only the
file passed as `--gguf`. Per-shard verification against the HF LFS oid stays
the manual step in
[Download, checksum and rollback](#download-checksum-and-rollback). Without `--flags`, `flags` is recorded null with the reason "no --flags given; the launch flags of the engine at <url> are not known".

`gufo` and `kapitsa` are external-only eval engines (`isExternalOnlyEngine`,
`packages/eval/src/matrix/types.ts`). Eval never boots them; the matrix
lifecycle refuses with "... run the server externally"
(`buildBootCommandForModelSpec` and `ensureModelServing`,
`packages/eval/src/matrix/lifecycle.ts`). The `gufo-glm53-exp`
template is a `ModelHost` with `engine: llamacpp`, not the `gufo` engine.

### Scheduled perf suites for an arm

A schedule is the recurring alternative to `eval perf` for an arm that is
already serving on an HTTP agent node. The `add` synopsis below is copied
verbatim from the USAGE text (`packages/cli/src/commands/bench-schedule.ts`):

```text
  llamactl bench schedule add <id> --node <node> --rel <rel>
      [--mode auto|text|vision] --every <duration>
      [--kind suite --suite <perf-quick|perf-full> [--engine <llamacpp|omlx|gufo|kapitsa>] [--slots <n>] [--quant <label>] [--ctx <n>] [--flags=<args>] [--hf-revision <rev>]]
```

So `llamactl bench schedule add <id> --node <node> --rel <rel>` takes an
optional `--mode`, and `--every <duration>` is required: without it the CLI
refuses with `--every is required` (`planAddArgs`,
`packages/cli/src/commands/bench-schedule.ts`).

```sh
llamactl bench schedule add glm53-gufo-perf --node <node> --rel <rel> \
  --every 6h --kind suite --suite perf-quick --engine gufo
```

`--engine` is accepted only with `--kind suite`; otherwise the CLI refuses with
`--engine is only valid when kind is 'suite'`, and the schedule schema
(`BenchScheduleSchema`, `packages/remote/src/bench/schedule.ts`) refuses the
same combination. A CLI `add` refuses an unknown engine id up front with
`unknown engine '<id>' (expected one of llamacpp, omlx, gufo, kapitsa)`
(`validateSuiteArgs`, `packages/cli/src/commands/bench-schedule.ts`); only a
schedule saved another way reaches the suite runner, where an unknown engine id
is refused before any endpoint work and lands in the schedule's `lastError`.
Separately, a suite schedule without `--engine`, including one saved before
#768, records `llamacpp` (`createPerfBenchSuiteRunner`,
`packages/cli/src/commands/bench-schedule.ts`). At fire time the tick loop
forwards the schedule's engine to the suite runner (`runWithOutcome`,
`packages/remote/src/bench/scheduleLoop.ts`).

The node must be an HTTP agent, otherwise the run refuses with
`perf suite runs need an HTTP agent endpoint` (`defaultEndpoint`,
`packages/cli/src/commands/bench-schedule.ts`). The rel must already be listed in
the node's `/v1/models`, otherwise the run refuses with
`node '<node>' is not serving '<rel>' (serving: ...)` (`assertServesModel`,
`packages/cli/src/commands/bench-schedule.ts`): a schedule never starts or stops
the engine; if <rel> is not served when the tick fires, the run fails into
`lastError`, so for exclusive-group arms, schedule it to fire inside the
exclusive window.

Rows land in the same `perf.sqlite` as `llamactl eval perf` (`defaultPerfDbPath`,
`packages/cli/src/commands/bench-schedule.ts`), with run id
`<id>-<ISO timestamp>`. Provenance records the engine, while `engine_version`,
`engine_commit`, `binary_sha256`, `gguf_sha256`, `hf_revision`, `quant` and `ctx`
are recorded null unless the schedule declares them (see below), each with an
unavailable reason stating that scheduled suites reach <rel> through the agent
gateway. The launch `flags` are recorded null as well, with the reason `scheduled suites reach <rel> through the agent gateway; the engine launch flags are not known`. A schedule that declares `--flags=<args>` records that list instead (see Declared launch flags for a suite schedule). SSD I/O, peak RSS and GTT are recorded
`unavailable` with a reason naming the node. So an eval-record arm that needs
binary or GGUF provenance should use `llamactl eval perf` with `--binary` or
`--gguf` on the engine host instead. The provenance `host` is the machine running
`llamactl bench schedule run` or `kick`, not <node> (`collectEvalProvenance` with
`defaultProvenanceReaders`, `packages/eval/src/perf/provenance.ts`).

Note that schedules fire only while `llamactl bench schedule run` is alive;
`llamactl bench schedule kick` runs one tick now. As with `eval perf`, the
promotion cells stay `unavailable`.

### Concurrency slots for c2 and c4

`c1_tps` needs no slot count; `c2_tps` and `c4_tps` need the engine's
slot count (`CONCURRENCY_LEVELS`, `packages/eval/src/perf/metrics.ts`).
`llamactl eval perf` takes the count from `--slots <n>` when given.
Otherwise only the `llamacpp` engine (the `--engine` default) is probed
(`resolveSlots`, `packages/cli/src/commands/eval-perf.ts`): the command
reads `total_slots` from `GET <url>/props` with a 5-second timeout
(`probeEngineSlots`, `packages/eval/src/perf/client.ts`). The probe never
fails the run: an HTTP error, a fetch failure or a body without a
positive integer `total_slots` leaves the count unknown, and c2 and c4
are recorded `unavailable` with the probe's reason followed by `; pass
--slots <n> to measure c2/c4`. For `omlx`, `gufo` and `kapitsa` the
reason is `engine '<engine>' does not advertise a llama-server GET /props
slot count; pass --slots <n> to measure c2/c4`. With a known count below
a level, that level is recorded `unavailable` as `engine slots <n> <
concurrency <level>` (`runConcurrencyLevel`,
`packages/eval/src/perf/runner.ts`).

Without a declared count — that is, without `--slots`, scheduled suite
runs set no slot count: the agent gateway forwards only `/v1/*`, so the
engine's `/props` is unreachable, and c2 and c4 are recorded
`unavailable` with a reason naming the rel, the node and the gateway
(`createPerfBenchSuiteRunner`,
`packages/cli/src/commands/bench-schedule.ts`). For c2/c4 evidence on an
arm, run `llamactl eval perf` against the engine's own URL with `--slots
<n>`, or with the default `llamacpp` engine so `/props` is probed.

A suite schedule can declare the slot count with `--slots <n>` on
`llamactl bench schedule add`: the CLI refuses it unless `--kind suite`
was given (`--slots is only valid when kind is 'suite'`) and refuses a
value that is not a positive integer (`--slots must be a positive
integer`) (`validateSlotsArg`, `packages/cli/src/commands/bench-schedule.ts`).
The tick loop forwards the count to the suite runner (`runWithOutcome`,
`packages/remote/src/bench/scheduleLoop.ts`), which passes it to the perf
suite as the slot count instead of the gateway reason. A declared count
below a concurrency level still records `engine slots <n> <
concurrency <level>` for that level (`runConcurrencyLevel`,
`packages/eval/src/perf/runner.ts`).

### Declared quant and context for a suite schedule

A suite schedule can declare the quant label with `--quant <label>` and
the context size with `--ctx <n>` on `llamactl bench schedule add`: the
CLI refuses either flag unless `--kind suite` was given
(`--quant is only valid when kind is 'suite'`,
`--ctx is only valid when kind is 'suite'`), refuses a blank or
malformed label (`--quant must be a non-blank quant label`) and refuses
a value that is not a positive integer (`--ctx must be a positive
integer`) (`validateProvenanceArgs`,
`packages/cli/src/commands/bench-schedule.ts`). The tick loop forwards
both to the suite runner (`runWithOutcome`,
`packages/remote/src/bench/scheduleLoop.ts`), which records them in perf
provenance (`collectEvalProvenance`,
`packages/eval/src/perf/provenance.ts`) instead of the gateway reasons;
a scheduled suite still records the gateway prefill reason for every
prefill size (`runPrefillSize`,
`packages/eval/src/perf/runner.ts`). So without a declared `--quant` or
`--ctx`, that field is recorded null with the gateway reason
(`createPerfBenchSuiteRunner`,
`packages/cli/src/commands/bench-schedule.ts`).

### Declared launch flags for a suite schedule

A suite schedule can declare the engine launch flags with `--flags=<args>`
on `llamactl bench schedule add`: the CLI refuses the flag unless
`--kind suite` was given (`--flags is only valid when kind is 'suite'`)
and refuses a value that lists no flag (`--flags must list at least one
launch flag`) (`validateFlagsArg`,
`packages/cli/src/commands/bench-schedule.ts`). A space-separated `--flags`
value is refused when it starts with a dash (`--flags must be attached with
'=' when its value starts with '-'; use --flags="..."`, `parseAddArgs`,
`packages/cli/src/commands/bench-schedule.ts`), because a bare
`--flags -ngl 99` would otherwise read `-ngl` as the next token rather than
the flag value. The schedule schema
(`BenchScheduleSchema`, `packages/remote/src/bench/schedule.ts`) refuses
the same combination with `flags is only valid with kind 'suite'`. The
tick loop forwards the list to the suite runner (`runWithOutcome`,
`packages/remote/src/bench/scheduleLoop.ts`), which re-checks a list on a
schedule saved another way and refuses a malformed one naming the schedule
(`invalid flags for schedule '<id>' (expected a non-empty list of
launch-flag tokens)`) before any endpoint work
(`assertDeclaredLaunchFlags`,
`packages/cli/src/commands/bench-schedule.ts`), then records the list in
perf provenance (`collectEvalProvenance`,
`packages/eval/src/perf/provenance.ts`) instead of the gateway reason. So
without a declared `--flags`, `flags` is recorded null with the gateway
reason (`createPerfBenchSuiteRunner`,
`packages/cli/src/commands/bench-schedule.ts`).

### Declared HF revision for a suite schedule

A suite schedule can declare the HF commit hash with `--hf-revision <rev>`
on `llamactl bench schedule add`: the CLI refuses the flag unless
`--kind suite` was given (`--hf-revision is only valid when kind is 'suite'`,
`validateHfRevisionArg`,
`packages/cli/src/commands/bench-schedule.ts`), and refuses a value that is
not a 40-character lowercase hex commit hash (`--hf-revision must be a
40-character lowercase hex commit hash`). The schedule schema
(`BenchScheduleSchema`, `packages/remote/src/bench/schedule.ts`) refuses
the same combination with `hfRevision is only valid with kind 'suite'`. The
tick loop forwards the hash to the suite runner (`runWithOutcome`,
`packages/remote/src/bench/scheduleLoop.ts`), which re-checks a value on a
schedule saved another way and refuses a malformed one naming the schedule
(`invalid hfRevision '<value>' for schedule '<id>' (expected a 40-character
lowercase hex commit hash)`) before any endpoint work
(`createPerfBenchSuiteRunner`,
`packages/cli/src/commands/bench-schedule.ts`), then records the hash in
perf provenance (`collectEvalProvenance`,
`packages/eval/src/perf/provenance.ts`) instead of the gateway reason. So
without a declared `--hf-revision`, `hf_revision` is recorded null with the
gateway reason (`scheduled suites reach <rel> through the agent gateway; no GGUF path to derive an HF revision from`,
`createPerfBenchSuiteRunner`,
`packages/cli/src/commands/bench-schedule.ts`).

### Listing suite schedules

`llamactl bench schedule list` and `llamactl bench schedule status` print
one row per schedule. Two columns show what a suite schedule records:
`KIND` and `DECLARED` (`ROW_HEADERS`,
`packages/cli/src/commands/bench-schedule.ts`). `KIND` is `preset` for a
bench-preset schedule and `suite:<suite>` for a suite schedule
(`scheduleKindCell`). `DECLARED` lists the suite fields the schedule
declares, in the order `engine`, `slots`, `quant`, `ctx`, `flags`,
`hfRevision`, each as `<field>=<value>` joined by commas. For flags the
value is the number of declared launch-flag tokens, not the tokens. A
preset schedule, or a suite schedule that declares none of them, shows `-`
(`declaredSuiteFieldsCell`). A field missing from `DECLARED` falls back as
described above: the engine records `llamacpp`, c2/c4 record unavailable
without a slot count, and quant, ctx, flags and hf_revision record null
with the gateway reason. `--json` still prints every stored field.

### Comparing perf runs for an arm

`perf.sqlite` rows from `llamactl eval perf` and from scheduled suites can
be compared run against run with the perf diff script (`perfDiffMain`,
`packages/eval/src/perf/diff.ts`, #663). `llamactl eval perf-diff` exposes it
on an installed CLI: `llamactl eval` has the `run`, `report`, `leaderboard`,
`perf` and `perf-diff` subcommands (`runEval`,
`packages/cli/src/commands/eval.ts`), and `perf-diff` delegates to
`perfDiffMain`, so it takes the same flags and gives the same exit codes and
`perf-diff:` messages as the script below. Run it from
the repo root. The synopsis is copied verbatim from the script's header
comment:

```text
bun packages/eval/src/perf/diff.ts --base <run_id> --candidate <run_id> \
  [--db <path>] [--model <name>] [--format md|json] [--tolerance <fraction>]
```

`--base` and `--candidate` are required; without either the script exits 1
with `perf-diff: --base and --candidate are required`. `--db` defaults to
`perf.sqlite` under `eval/` in the llamactl home (`defaultPerfDbPath`,
`packages/eval/src/perf/diff.ts`), the same file `eval perf` and `bench
schedule` suites write. The store is opened read-only, so a diff never
writes to it, and a missing file exits 1 with `perf-diff: db not found at
<path>`. A run id with no rows exits 2 with `perf-diff: no perf rows for
run '<id>'`. A run that holds more than one model exits 1 with
`perf-diff: run '<id>' holds more than one model; pass --model <name>`,
and `--model` then filters both runs. Base and candidate may be different
arms or engines. The Markdown output starts with `baseline: <run_id>
(<model>, <engine>)` and `candidate: <run_id> (<model>, <engine>)` lines
(`renderPerfDiffMd`), and `--format json` prints `baseline`, `candidate`,
`diffs` and `provenance` (`renderPerfDiffJson`).

Rows are matched on suite and metric name (`diffPerfRuns`,
`packages/eval/src/perf/diff.ts`). Each metric's direction comes from
`PERF_METRIC_HIGHER_IS_BETTER`: higher is better for `prefill_4k_tps`,
`prefill_16k_tps`, `prefill_32k_tps`, `prefill_64k_tps`, `decode_tps`,
`spec_acceptance`, `c1_tps`, `c2_tps` and `c4_tps`; lower is better for
`load_cold_ms`, `load_warm_ms`, `ttft_ms`, `ssd_read_bytes`,
`ssd_write_bytes`, `peak_rss_bytes` and `peak_gtt_bytes`. A metric with no
direction is reported `unavailable` with `no direction for metric <name>`.
The verdicts are `improved`, `regressed`, `unchanged` and `unavailable`.

`--tolerance <fraction>` defaults to 0 and must be a finite number >= 0.
It is a fraction of the baseline value, not an absolute delta: a change no
larger than `abs(baseline) * <fraction>` is `unchanged` (`compareMetric`,
`packages/eval/src/matrix/diff.ts`). When either side is `unavailable`,
including a metric missing from one run (`missing in baseline` or `missing
in candidate`), the verdict is `unavailable` with both sides' reasons,
never `regressed`.

The script exits 3 when any metric is `regressed` and 0 otherwise. An
`unavailable` metric never counts as a regression, so exit 0 does not mean
every metric was measured: read the verdict column. The diff compares perf
metrics and provenance, not promotion metrics, so the promotion cells in
the table above stay `unavailable`.

### Provenance in a perf diff

After the metric table, the Markdown output has a second table headed
`| Provenance | Baseline | Candidate | Verdict |` (`renderPerfDiffMd`,
`packages/eval/src/perf/diff.ts`). It compares the provenance of the first
row of each run, the same row the header's engine comes from
(`perfDiffMain`), field by field in the order of
`PERF_PROVENANCE_DIFF_FIELDS`: `engine`, `engine_version`, `engine_commit`,
`binary_sha256`, `gguf_sha256`, `hf_revision`, `quant`, `ctx`, `flags` and
`host` (`diffPerfProvenance`). A field is `same` when both values are equal,
with `flags` compared token by token, and `differs` otherwise. A field that
is null on either side, including a field missing from an older row, is
`unavailable` and never `differs`. Its reason is that side's `unavailable`
entry from the recorded provenance, or `not recorded` when the row holds
none, prefixed with the side as for metrics. An unavailable value renders as
`unavailable`, and an empty `flags` list, which declares an engine launched
with no flags, renders as `(none)`. The JSON output carries the same
comparison under `provenance`, one entry per field with its baseline and
candidate values, verdict and reason; an unavailable side is null there
(`renderPerfDiffJson`). Provenance never changes the exit code: a pair of
runs whose only difference is provenance exits 0, so a `differs` row
explains a metric change but is not a regression.

### Load and prefill metrics for an arm

`load_cold_ms` and `load_warm_ms` are measured only when the caller injects
load hooks (`PerfSuiteLoadHooks` and `runLoadHook`,
`packages/eval/src/perf/runner.ts`). The runner times each hook and trusts it
to resolve only once the engine can serve; it performs no readiness probe of
its own. An optional `beforeWarm` hook runs untimed before the warm hook's
clock starts. A scheduled suite never injects load hooks, and `llamactl eval perf`
injects them only with `--launch`, so from a scheduled suite, and from
`eval perf` without `--launch`, the two load metrics are always recorded
`unavailable`, each with a reason naming the caller. `eval perf` records
`eval perf runs against an engine already serving '<model>' at <url>; it does not launch or reload the engine, so cold/warm model-load time is not measured`
(`buildOpts`, `packages/cli/src/commands/eval-perf.ts`). A scheduled suite
records
`model load for <rel> happens on node '<node>'; scheduled suites reach an already-serving engine through the agent gateway and do not load or reload it, so cold/warm load time is not measured`
(`createPerfBenchSuiteRunner`, `packages/cli/src/commands/bench-schedule.ts`).
A caller that passes neither hooks nor a reason gets
`no load hooks injected (engine not managed by the suite)`. A hook that throws
records `<metric> failed: <message>`, and a non-finite or negative elapsed
time records `non-finite load time`. Because an `unavailable` metric never
counts as a regression, the perf diff reports both load metrics `unavailable`
for runs from these commands, never `regressed`.

A scheduled suite never measures prefill, even when the schedule declares
`--ctx`. The suite runner sets `prefillReason` to
`prefill for <rel> on node '<node>' is not measured; scheduled suites reach the engine through the agent gateway, which forwards only /v1/* and not the engine's /tokenize`
(`createPerfBenchSuiteRunner`, `packages/cli/src/commands/bench-schedule.ts`).
`runPrefillSize` records that reason for every prefill size before any context
check and without calling `/tokenize` (`runPrefillSize`,
`packages/eval/src/perf/runner.ts`). For background, the gateway's
`/v1/models` entries carry no `context_length`, `max_model_len` or `meta`
(`buildListOpenAIModels`, `packages/core/src/openaiProxy.ts`). The gateway
routes only `/v1/*` paths, and `/tokenize` is not one of them. For prefill
evidence on an arm, run `llamactl eval perf` against the engine's own URL.

Prefill runs after the load phase. The model context comes from the suite's
`ctx` option (`--ctx` on `eval perf`), then the provenance `ctx`, then the
first `/v1/models` entry's `context_length`, `max_model_len`, `meta.n_ctx` or
`meta.n_ctx_train` (`resolveModelCtx`, `packages/eval/src/perf/runner.ts`).
With no context, each of `prefill_4k_tps`, `prefill_16k_tps`,
`prefill_32k_tps` and `prefill_64k_tps` is recorded `unavailable` with
`model context unknown`. Otherwise each size builds a token-exact prompt
through the engine's `/tokenize` endpoint (the `tokenizePath` default in
`createHttpPerfEngineClient`, `packages/eval/src/perf/client.ts`) before the
context guard, so a missing tokenize endpoint is reported the same way at
every size. An HTTP error records
`<metric> failed: tokenize HTTP <status> at /tokenize`, and a prompt that
cannot be matched to the target count records
`could not build a token-exact prompt`. A size whose tokens plus the suite's
decode tokens (16 for `perf-quick`, 64 for `perf-full`; `PERF_SUITES`,
`packages/eval/src/perf/suites.ts`) exceed the context records
`prefill <n> tokens exceeds model context <ctx>`. An engine whose own
prompt-token count is more than 8 off the target records
`engine counted <n> prompt tokens for target <target>` (`runPrefillSize`,
`packages/eval/src/perf/runner.ts`).

### Measured load with --launch

With `--launch`, `eval perf` starts llama-server itself through the eval
matrix lifecycle. In order, the cold hook calls `ensureModelServing`, the
untimed `beforeWarm` hook calls `teardownIfOwned`, the warm hook calls
`ensureModelServing` again, and a final `teardownIfOwned` runs in `finally`
even when the suite throws. Cold is the first launch and warm is the relaunch
after that teardown; the runner calls `beforeWarm` before it starts the warm
clock, so `load_warm_ms` excludes tearing the cold boot down. Each load is
timed until `/health` and the `/v1` boot probe pass (`ensureModelServing`,
`packages/eval/src/matrix/lifecycle.ts`). `load_cold_ms` and `load_warm_ms`
are measured only for an engine eval perf starts. The OS page cache is not
dropped, so warm load includes whatever cache the cold boot left behind.

The residency group comes from the `--gguf` path relative to
`LLAMA_CPP_MODELS` when that relative path names a catalog row, falling back
to `--model` (`launchRefusal`, `packages/cli/src/commands/eval-perf-launch.ts`).
Provenance flags are the launch args: the `--flags` list becomes the launched
spec's `extra_args`, and no `--flags` records an explicit empty list rather
than the not-known reason used for an externally launched engine.

Validation refuses, in order, with
`--launch starts llama-server through the eval matrix lifecycle and supports only --engine llamacpp (got <engine>)`,
`--launch does not support an IPv6 --url (got <host>); use 127.0.0.1 or localhost`,
`--launch needs a loopback --url (got <host>); the engine is started on this machine`,
`--launch needs an explicit port in --url`,
`--launch needs --binary <path> and --gguf <path>`,
`--launch needs an existing --binary (not found: <path>)`,
`--launch needs an existing --gguf (not found: <path>)`, and
`--pid cannot be combined with --launch; the launched engine's PID is not known before the suite starts`.
Giving the boolean a value refuses with `--launch takes no value`.

Before launching, `preflightLaunch` (`packages/cli/src/commands/eval-perf-launch.ts`)
probes `GET /health`. Any resolved response, even a non-2xx response, means
the port is occupied and refuses with
`--launch needs a free port, but something is already answering at <url> (GET /health returned HTTP <status>)`;
a rejected fetch means the port is free. The residency gate is the same
read-only exclusive-group gate used by sandbox eval launches and can refuse
with
`residency lifecycle refused <model> downloaded -> loading: ExclusiveGroupOccupied: exclusive group <group> is held by <member> in state <state>`
(`exclusiveGroupLaunchRefusal`, `packages/remote/src/residency/direct-lifecycle.ts`).

On Linux, `peak_rss_bytes` is `VmHWM` in `/proc/<pid>/status` of the boot that
`eval perf` owns when the memory phase runs, which is the warm relaunch
(`createLaunchLoadHooks`, `packages/cli/src/commands/eval-perf-launch.ts`, and
`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`). If no launched
engine has a PID then, it records `peak-RSS reader failed: engine PID
not known when the reader ran`. SSD I/O records
`--launch relaunches the engine between the cold and warm load, so no single
engine process spans the suite; per-process SSD I/O (/proc/<pid>/io) is not
measured` (`LAUNCH_IO_REASON`, `packages/cli/src/commands/eval-perf-launch.ts`),
because the cold and warm boots are different processes. GTT is unchanged. On macOS, SSD
I/O records the same `LAUNCH_IO_REASON`, peak RSS is read through `proc_pid_rusage` for
the warm relaunch PID, and GTT keeps its Linux-only reason.

Because the engine is not up before the suite starts, `GET /props` is not
probed. Without an explicit `--slots <n>`, c2/c4 record
`--launch starts the engine inside the perf suite, so GET /props is not probed before the run; pass --slots <n> to measure c2/c4`
(`LAUNCH_SLOTS_REASON`, `packages/cli/src/commands/eval-perf-launch.ts`).

In this race, a boot that is not `owned` means another engine won the port race. The load
metric records
`an engine was already serving at <host>:<port> before --launch started one; cold/warm load is measured only for an engine eval perf starts`,
and after the table prints the run exits 1 with
`--launch did not start the engine at <url>; run <run-id> measured an engine it did not launch`.
If the launch itself fails, the suite still stores the rows it captured and
the run exits 1 with
`--launch failed to start the engine at <url>: <message>`.

### Host reader failures for an arm

When a host reader is present but produces no sample, `runPerfSuite`
(packages/eval/src/perf/runner.ts) records why, and the metric is never
recorded as 0. The I/O reasons live in `runIoPhase`
(`packages/eval/src/perf/runner.ts`): a reader that throws at the start or
the end sample records `I/O reader failed: <message>` (the start sample
wins), and a present reader that returns null or an invalid sample at
either point records `I/O reader returned no sample`. When both samples are valid but either counter is smaller at the end than at the start, `runIoPhase` records both SSD metrics as unavailable with `I/O counters decreased between the start and end samples (read_bytes <start> -> <end>, write_bytes <start> -> <end>); the sampled process likely restarted`, because per-process counters never decrease; equal start and end counters record 0, since that is a measured zero delta. Peak RSS works the
same way through `readPeakRss` and `runMemoryPhase`: a throwing peak-RSS
reader records `peak-RSS reader failed: <message>`, and a present
reader returning null or a non-positive number records
`peak-RSS reader returned no sample`. For GTT, `readPeakGtt`
records `GTT reader failed: <message>` for a throw and `GTT reader
returned no sample` for a null observation, and `gttObservationReason`
names a non-ok observation `GTT reader returned no sample (status:
<status>)`, or `GTT reader returned no sample
(status: <status>, source: <source>)` when the observation names a source;
an observation with status ok and an invalid `usedBytes` is named with its
`usedBytes` value. The
first failure message comes from `readerErrorMessage`, which passes a
thrown `Error`'s message through and stringifies anything else. An ok GTT
sample from any phase still wins over a failed one (`peakGttMetric`,
`packages/eval/src/perf/runner.ts`). Absent readers keep their
caller-named reasons, as described in Capturing evidence for an arm.

The shipped `createPerfHostReaders` (packages/eval/src/perf/readers.ts)
turns a failed /proc read into null. On macOS it turns a non-zero
`proc_pid_rusage` return, or a counter above `Number.MAX_SAFE_INTEGER`, into
null the same way. So `eval perf` records `I/O reader returned no sample` and
`peak-RSS reader returned no sample`, and the `... reader failed:
<message>` reasons apply only to an injected reader that throws. The GTT probe `probeGpuGtt`
(packages/fleet-supervisor/src/node-probe.ts) reports `denied` when the
counters are not readable, `unavailable` when no card exposes them, and
`unsupported` off Linux, and reports an empty source for each of them. On
a loopback Linux `eval perf` run, the stored `peak_gtt_bytes` reason is
therefore the status-only form, for example `GTT reader returned no sample
(status: denied)`. The source clause appears only for an injected reader
that names a source.

### Unscored matrix cells for an arm

A matrix cell is unscored when its `n_rows` is 0 or less.

The matrix runner writes such a cell in two cases. When a model or judge
boot fails or is refused, including a pre-launch gate refusal,
`recordBootError` stores `n_rows` 0, `primary_metric_value` 0, `errors`
1 and `per_class_metrics_json` `{"error":"<reason>"}`. The reason is
`model boot failed: <first line of the boot error>` for a model and
`judge <judge> boot failed: <first line of the boot error>` for a judge
(verify `bootErrorReason` at `packages/eval/src/matrix/runner.ts`).
When a corpus fails to load, `runWorkloadCell` stores `n_rows` 0,
`primary_metric_value` -1 and `per_class_metrics_json`
`{"error":"corpus_load_failed"}` (verify
`packages/eval/src/matrix/runner.ts`).

The reason is truncated on purpose: only the first line of the boot error
is stored, so a llama-server stderr tail never lands on the cell. The
full text still goes to the `[matrix] failed to boot ...` warning. So a
boot error cell reads `no rows scored (model boot failed: <first line of
the boot error>)`, and a corpus failure reads
`no rows scored (corpus_load_failed)` (verify
`packages/eval/src/matrix/report.ts`).

`cellUnavailableReason` returns `no rows scored`, or `no rows scored
(<error>)` when `per_class_metrics_json` carries a non-empty string
`error`, so a boot error cell reads `no rows scored (model boot failed:
<first line of the boot error>)` and a corpus failure reads `no rows
scored (corpus_load_failed)`.

An unreachable gufo arm reads `no rows scored (model boot failed: model
<name>: engine gufo is not managed by eval and is not reachable at
<host>:<port>; run the server externally)`; that engine text is copied
byte-for-byte from `packages/eval/src/matrix/lifecycle.ts`.

The matrix CLI writes the report for the run it just ran with `--report
md|csv|both` and `--report-out <path>`, or for every run with
`--report-all-runs`. Each report renders `unavailable` for an unscored
cell's primary metric, latency and throughput, and keeps its errors
count (verify `packages/eval/src/matrix/cli.ts`).

The markdown report adds a `## Unavailable cells` section, between
`## Errors` and `## Per-workload winner`, with one `- <model> / <workload>:
<reason>` line per unscored cell, and omits the section when every cell
scored.

The per-workload winner skips unscored cells, and a workload where no cell
scored reads `- <workload>: unavailable (no cell scored any rows)`.

With `--report-all-runs` the report keeps the latest cell per model and
workload by `finished_at`, so a later unscored cell replaces an earlier
scored one.

These cells never count as promotion evidence; see Qualification and
promotion.

`bun packages/eval/src/matrix/diff.ts` renders `unavailable` for the
value, tps and p50_ms of an unscored cell and, in markdown, sorts it
after the scored cells of its workload. `--format json` keeps the raw
numeric fields (verify `packages/eval/src/matrix/diff.ts`).

Without `--all-runs` the diff keeps the latest cell per model and
workload by `started_at`, scored or not.

### Provenance in a matrix report

Every matrix run collects provenance for each model through `collectEvalProvenance` and stores it in the `matrix_provenance` table (`insertMatrixProvenance`, `packages/eval/src/matrix/store.ts`). The markdown report written with `--report md` or `--report both` ends with a `## Provenance` section (`renderMarkdownReport`, `packages/eval/src/matrix/report.ts`). It is loaded from that table for the report's run, or for every run with `--report-all-runs` (`writeReport`, `packages/eval/src/matrix/cli.ts`). Its table is headed `| Run | Model | Field | Value |` and lists one row per field, in the order of `PERF_PROVENANCE_DIFF_FIELDS` (`packages/eval/src/perf/diff.ts`). A null field renders `unavailable (<reason>)` with the reason recorded in `provenance.unavailable`, or `unavailable (not recorded)` when the row holds none; it never renders a guessed value. An empty `flags` list renders `(none)`. A model that has cells in the report but no provenance row, for example because provenance collection failed, gets a single `(all)` row reading `unavailable (not recorded)`. The section follows `## Unavailable cells` and `## Per-workload winner`, so it comes after the unscored-cell lines described in Unscored matrix cells for an arm. The runner collects provenance before it boots the model, so a model whose cells are unscored because its boot failed or was refused still has a provenance row. The CSV report carries no provenance.

### Launch flags in matrix provenance

The matrix runner builds each model's provenance input from its ModelSpec
(`matrixProvenanceInput`, `packages/eval/src/matrix/runner.ts`). The `flags`
field is the spec's `start_args` followed by its `extra_args`. Eval never
launches a `gufo` or `kapitsa` engine (`isExternalOnlyEngine`,
`packages/eval/src/matrix/types.ts`). It also never launches a spec without
`managed: true`: `ensureModelServing`
(`packages/eval/src/matrix/lifecycle.ts`) only adopts an engine that is
already serving. `loadModels` requires `extra_args`
(`validateModelSpec`, `packages/eval/src/matrix/cli.ts`), so for these specs
an empty list does not say how the engine was started. When such a spec
declares no flag tokens, `flags` is recorded null with
`ModelSpec <name> declares no launch flags (engine <engine> runs outside
eval)` for gufo and kapitsa. For any other engine it is recorded with
`ModelSpec <name> declares no launch flags (managed=false, so eval does not
launch it)` (`flagsUnavailableReason`,
`packages/eval/src/matrix/runner.ts`). The matrix report then renders
`unavailable (<reason>)` for the field instead of `(none)`. A spec that
lists flag tokens keeps them as declared flags. A `managed: true` spec keeps
its list even when it is empty, because eval boots the engine from that
spec. Provenance is collected before boot, so a `managed: true` spec whose
port is already answering still records its declared list.
