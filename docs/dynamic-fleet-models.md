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
  the plan did not observe is reconciled to downloaded and logged. Enforcement
  in the reconciler and ModelHost is still pending
  #276. What enforces today is the
  finite-budget admission math plus the per-node residency-group start
  guard described below. `llamactl residency status`, the
  `residencyStatus` procedure and the MCP tool now report the serving
  process's `residency_states` rows and any exclusive-group violation
  (`findExclusiveGroupViolations`, previously used only by the planner).
  Lifecycle-row boot recovery has landed, and direct ModelHost
  `modelHostStart`/`modelHostStop` now drive their `residency_states` rows
  through the same fenced walks (`direct-lifecycle.ts`), reconciling
  proven-down same-group peers and refusing an occupied exclusive group or
  an in-flight switch. The direct ModelRun `serverStart`/`serverStop` writers
  now do the same, recording the group from the agent-side ModelRun
  `llamactl.io/residency-group` label; the switch's own `applyManifest` calls
  run in a switch scope and are walked only by the switch. Still pending:
  reconciliation outside a switch.
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
  the plan did not observe is reconciled to downloaded and logged.
  `llamactl residency status`, the `residencyStatus` procedure and the MCP
  tool now report the serving process's `residency_states` rows and any
  exclusive-group violation (`findExclusiveGroupViolations`, previously
  used only by the planner). Lifecycle-row boot recovery has landed, and
  direct ModelHost `modelHostStart`/`modelHostStop` now drive their
  `residency_states` rows (see Residency lifecycle states), as do the direct
  ModelRun `serverStart`/`serverStop` writers, recording the group from the
  agent-side ModelRun `llamactl.io/residency-group` label; the switch's own
  `applyManifest` calls run in a switch scope and are walked only by the
  switch. Still pending: reconciliation outside a switch.
- Group declarations are not persisted. They come from the caller
  (default `RESIDENCY_GROUPS`).

Still pending #276: enforcement in the reconciler and ModelHost,
recovery, stale-revision rejection, and summing reservations against a
node memory budget. The enforcement in place today is the following:

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
`llamactl.io/residency-group` label, and operator force-unload
(`residencyForceUnload`) routes its stop through the same wrapper after the
lease drain commits. Bookkeeping never blocks a stop: a stop
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
example an engine that outlived its agent, keeps its row. The group is not
wedged forever: before the window elapses an operator stop or
`llamactl residency force-unload` also clears it. Any nonterminal operation row keeps
this sweep off, and it fails closed: `evict:` rows have no boot recovery
yet, so a crashed eviction's nonterminal `evict:` row disables the
outside-a-switch sweep on every later boot until that row is terminalized;
until then an operator stop or `llamactl residency force-unload` clears a
stuck interrupted row, and an `evict:` row does not block either. It is implemented in
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
stable advertisement only against stable peers; an experimental
advertisement is judged against all candidates, so it can neither shadow
nor intrude on a stable alias or replica group. The embersynth bench
scorer never picks an experimental rel as a fusion node's `modelId`: it
reads stages through `embersynthQualificationStages`
(`packages/remote/src/config/embersynth.ts`), which is
`catalogQualificationStages` with pin overrides applied. `llamactl
embersynth promote-private <rel>` exits 1 for an experimental rel, with
stderr "experimental models are served only on an exact model pin and
never under fusion-private-first" (#725). Under #728/#729 the ranked
replica hint never lifts an experimental replica over a non-experimental
one, and a session already bound to an experimental workload stays on it.

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
the read-only consumer of `evaluateQualification` and `applyQualification`.
`proposePromotion`, `applyPromotion`, `proposeDemotion` and the writer path
of `applyQualification` remain library-only; the writer consumers of the
apply path are pending E-14 / #284. The overrides reader has one consumer:
routing applies its pin rows (see Overrides).

`llamactl qualification propose <rel> --evidence <file> --policy <file>
[--json]` reads an evidence file and a policy file and reports a promotion,
a demotion or a refusal without writing anything. The evidence file is
validated by `parsePromotionEvidence` against the strict
`PromotionEvidenceSchema`, so unknown keys are refused and each metric
carries its threshold's bound (ratios in [0, 1], `improvement` in [-1, 1]),
which refuses percent-scaled evidence; the policy file is validated by
`PromotionPolicySchema`, which also refuses unknown top-level keys such as
an `autoapply` typo. The declared stage is the catalog
stage, falling back to the pin stage, and an unstaged rel is refused. The
freeze and pin rows come from the shared overrides file. `applyQualification`
is called without a writer, so `autoApply: true` still reports `proposed`
and nothing is written.

## Overrides

Pin/freeze override rows live in `qualification-overrides.tsv`
(`packages/core/src/qualification/overrides.ts`), keyed on
`(rel, action)`:

- `pin` freezes promotion while declaring the stage the model is held
  at — it requires a stage.
- `freeze` blocks promotion and must carry an empty stage.

Columns: `rel`, `action`, `stage`, `author`, `reason`, `updated_at`.

Resolution order: `LOCAL_AI_QUALIFICATION_OVERRIDES_FILE`, otherwise
`qualification-overrides.tsv` under the runtime dir.

Writer semantics: a write replaces the `(rel, action)` row and drops
`#` comments and invalid rows present before the write. A delete
removes the file entirely when it empties.

Routing reads this one shared file. `catalogQualificationStages`
applies each `pin` row's stage over the catalog stage for its `rel`
(also for a rel the catalog never staged), so a pin changes the stage
the route builders and `/v1/models` see. A `freeze` row has no routing
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
qualification unfreeze <rel>` removes it. `llamactl qualification status
<rel>` and `llamactl qualification list` report the catalog stage, the pin,
the freeze, `effectiveStage` and the routing stage. The overrides file is
node-local, so every subcommand refuses a non-local `--node` target.

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
2. Record the current state with `llamactl get workloads`.
3. Stop production: `llamactl disable <production-workload>` (the
   node-local production workload name; it is not in this repo).
   Confirm it reads Stopped in `llamactl get workloads`.
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
8. Run the eval.
9. Exit the window: `llamactl disable <name>`, then
   `llamactl enable <production-workload>`, then verify Running and
   readiness. A disable is never blocked by this bookkeeping and at
   worst logs "not recorded" (#741).

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
`[--suite perf-quick|perf-full] [--pid <n>] [--binary <path>] [--gguf <path>] [--hf-revision <rev>] [--quant <q>] [--ctx <n>] [--slots <n>] [--flags=<args>] [--db <path>] [--run-id <id>]`.
Both are copied verbatim from the USAGE text (`USAGE`,
`packages/cli/src/commands/eval.ts`), and every valued flag in it is in
`VALUED_FLAGS` (`packages/cli/src/commands/eval-perf.ts`).

The command runs the perf suite against an engine that is already serving at
`--url`. It never starts or stops the engine, so the operator runs it inside
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
(`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`). GTT comes from the GTT probe on
any loopback Linux run, with or without `--pid`
(`hostReaders`, `packages/cli/src/commands/eval-perf.ts`). These counters are
Linux-only; on macOS each is recorded `unavailable` with a named reason
(`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`, and
`hostReaders`, `packages/cli/src/commands/eval-perf.ts`). With a non-loopback URL, every
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
`engine_commit`, `binary_sha256`, `gguf_sha256`, `hf_revision`, `quant` and
`ctx` — is either a value or null with a reason in `provenance.unavailable`.
For example, "gguf path is not under an HF snapshots/<rev>/ directory"
(`collectHfRevision`, `packages/eval/src/perf/provenance.ts`). `gguf_sha256` hashes only the
file passed as `--gguf`. Per-shard verification against the HF LFS oid stays
the manual step in
[Download, checksum and rollback](#download-checksum-and-rollback).

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
      [--kind suite --suite <perf-quick|perf-full> [--engine <llamacpp|omlx|gufo|kapitsa>]]
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
are recorded null, each with an unavailable reason stating that scheduled suites
reach <rel> through the agent gateway. SSD I/O, peak RSS and GTT are recorded
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

Scheduled suite runs never set a slot count: the agent gateway forwards
only `/v1/*`, so the engine's `/props` is unreachable, and c2 and c4 are
recorded `unavailable` with a reason naming the rel, the node and the
gateway (`createPerfBenchSuiteRunner`,
`packages/cli/src/commands/bench-schedule.ts`). For c2/c4 evidence on an
arm, run `llamactl eval perf` against the engine's own URL with `--slots
<n>`, or with the default `llamacpp` engine so `/props` is probed.
