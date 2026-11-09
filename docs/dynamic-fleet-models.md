# Dynamic fleet models

Operator guide for the large-GPU candidate fleet: catalog metadata,
residency exclusion, qualification and promotion, the exclusive-window
runbook, and the download/rollback procedure. This extends the existing
catalog, router and workload lifecycle — it is not a parallel registry
(refs #522 and #273).

Open items:

- The residency state contract is pending #276; what ships today is
  the finite-budget admission math plus the per-node residency-group
  start guard described below.
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

The residency state contract (#276) is not implemented at this commit.
What exists today:

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

Effective status at this commit: `effectiveStage`,
`proposePromotion`, `applyPromotion` and the overrides reader are
library-only — no router, catalog, lifecycle or CLI code calls them.
Consumers are pending E-14 / #284.

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

This is the wire format future consumers will read. Editing it today
changes no routing or lifecycle behaviour — the reader is library-only
until #284.

## Exclusive-window runbook

Manual procedure, before DF-06 / #279 automates the swap.

Every z13 template is committed `enabled: false`. Enabling one needs
an operator-approved window that swaps production out, as the template
headers say. The residency-group guard above blocks a second
same-group ModelHost, but it does not cover the production workload,
whose name and group membership are node-local and not in this repo —
swapping production out stays an operator step.

The ten z13-large-gpu templates (runtime-arm label where present, and
port):

| metadata.name                         | runtime arm                | port |
| ------------------------------------- | -------------------------- | ---- |
| `gufo-glm53-exp`                      | `G2c8-incoai-dc77ff1c99ee` | 8081 |
| `libosmos-ds41-ud-iq1m`               | `libosmos-934b51b932be`    | 8085 |
| `libosmos-ds41-ud-iq1s`               | `libosmos-934b51b932be`    | 8092 |
| `llamacpp-deepseek41-flash-iq1s`      | none                       | 8084 |
| `llamacpp-ds41-ud-iq1m-hip-b12206`    | `D-L-cf34d311332e`         | 8090 |
| `llamacpp-glm53-hip-b12206`           | `G-H1-cf34d311332e`        | 8087 |
| `llamacpp-glm53-vulkan-halo`          | `G-V1-e742170e08db`        | 8086 |
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
   first.
7. Wait for the readiness probe, then `llamactl describe workload <name>`.
8. Run the eval.
9. Exit the window: `llamactl disable <name>`, then
   `llamactl enable <production-workload>`, then verify Running and
   readiness.

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

Rollback: delete partial shards and run the runbook exit step.
Override rows have no runtime effect yet — do not list them as a
rollback lever. TTM/GTT kernel-parameter rollback is not covered by
repo code and is out of scope.

## GLM-5.3-Flash z13 eval record

One row per GLM template arm; one column per promotion metric.

| arm                        | template                     | `firstAttemptSuccess` | `repairSuccess` | `toolCallCorrectness` | `structuredOutputValidity` | `regression`  | `improvement` | `memoryStability` | `runtimeReliability` |
| -------------------------- | ---------------------------- | --------------------- | --------------- | --------------------- | -------------------------- | ------------- | ------------- | ----------------- | -------------------- |
| `G2c8-incoai-dc77ff1c99ee` | `gufo-glm53-exp`             | `unavailable`         | `unavailable`   | `unavailable`         | `unavailable`              | `unavailable` | `unavailable` | `unavailable`     | `unavailable`        |
| `G-V1-e742170e08db`        | `llamacpp-glm53-vulkan-halo` | `unavailable`         | `unavailable`   | `unavailable`         | `unavailable`              | `unavailable` | `unavailable` | `unavailable`     | `unavailable`        |
| `G-H1-cf34d311332e`        | `llamacpp-glm53-hip-b12206`  | `unavailable`         | `unavailable`   | `unavailable`         | `unavailable`              | `unavailable` | `unavailable` | `unavailable`     | `unavailable`        |

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
