# Pipelines → Composite Bridge — Design

**Status:** Approved (brainstorm), pending implementation plan
**Date:** 2026-04-26
**Phase:** Convergence follow-up — closes the "Pipelines→Composite bridge" item from `~/.claude/plans/radiant-converging-knuth.md`
**Spec scope:** Composites can declare RAG pipelines as a new component kind. The composite applier registers each pipeline through the existing `ragPipelineApply` proc with a `CompositeOwnership` marker; reference-counted destroy mirrors the gateway-catalog pattern. First ingest run is fire-and-forget on apply. Pipelines participate in topo order via an implicit edge to their `destination.ragNode`.

## Goal

Let operators declare a RAG ingestion pipeline inside a Composite manifest so applying the composite also bootstraps the pipeline (registered + first-ingest triggered + scheduled if `schedule:` is set). Closes the deferred item that the Composites system left at "services + workloads + ragNodes + gateways" — pipelines were the missing fifth component kind to make composites a complete deployment unit for "stand up a RAG-fed inference stack atomically."

## Background

`docs/composites.md` shipped composites as declarative multi-component infra: services + workloads + ragNodes + gateways with a topo-ordered DAG, atomic apply, and `onFailure: rollback | leave-partial`. The convergence plan flagged "Pipelines→Composite bridge" as a remaining follow-up.

`docs/rag-nodes.md` and `packages/remote/src/rag/pipeline/` ship the RAG pipeline runtime: declarative ingestion specs (filesystem/http/git sources, chunk/transform stages, schedule), the `ragPipelineApply`/`ragPipelineRun`/`ragPipelineDelete` tRPC surface, and a scheduler that walks each pipeline on its declared cadence.

The two systems have a clean seam: `RagPipelineSpec.destination.ragNode` references a name that *could* live in the same composite's `ragNodes:` list. Bridging them means letting a composite manifest carry inline pipeline specs, route them through the existing `ragPipelineApply` proc, and tie their lifecycle into composite apply/destroy.

The user's actual operating model is one composite per concept ("vision composite", "code composite") with each carrying its own RAG ingestion. Multi-composite shared-pipeline ownership is plausible but secondary; v1 supports it via reference-counted ownership but defaults are tuned for the single-owner case.

This work landed shortly after `composite-gateway-auto-populate` (gateway-catalog ownership-marker). That ownership-marker schema is reused verbatim here: `CompositeOwnership` in `packages/remote/src/workload/gateway-catalog/schema.ts` was designed as a generic primitive, and pipelines need exactly the same ownership semantics (operator entries protected, composite-managed reference-counted, idempotent re-apply via specHash).

## Decisions

### D1. Entry shape — inline `RagPipelineSpec` minus metadata

The composite declares pipelines in a new `pipelines: [{ name, spec }]` array. The `spec` is the existing `RagPipelineSpec` verbatim — sources, transforms, destination, schedule, on_duplicate, cost, concurrency. The composite supplies the pipeline `metadata.name` from the entry's `name` field; no `metadata.name` inside the entry. No composite-specific subset of the pipeline schema; operators get the full surface.

Rationale: every other component kind in `CompositeSpec` is inline (services use `ServiceSpec`, workloads use `ModelRunSpec`, ragNodes/gateways use composite-entry schemas with embedded specs). A composite manifest is the single source of truth for the components it declares; ref-by-name (rejected as Option B) introduces indirection that fights atomic apply, spec-hash drift detection, and rollback semantics.

### D2. Cross-component ragNode resolution — implicit topo edge

When a pipeline's `destination.ragNode` matches an inline `ragNodes[i].name`, the composite applier infers an `pipelines[j] depends on ragNodes[i]` edge and applies the rag node first. Operator does NOT need to declare this in the explicit `dependencies:` list. Same pattern as the existing gateway → upstream-workload inference.

Rationale: a pipeline structurally cannot register against an unregistered rag node; the dependency is always one direction; making the operator restate it is duplication. Explicit `dependencies:` edges still work for cross-kind relations (pipeline → service, etc.).

### D3. Initial-run policy on apply — fire-and-forget async

`compositeApply` registers each pipeline via the existing `ragPipelineApply` proc, then triggers exactly one first run via `ragPipelineRun` async (no await). Composite reaches `Ready` once registration succeeds, not when the first run completes. Subsequent scheduled runs (when `spec.schedule` is set) are picked up by the existing scheduler. On-demand pipelines (no `spec.schedule`) get the implicit kick from apply, then sit dormant until the operator invokes `ragPipelineRun` again.

Rationale: register-only (Option A) creates a two-step deployment footgun; sync-on-apply (Option C) makes apply unbounded for large sources (a 50 GB git crawl could block the apply for an hour); per-entry override (Option D) is YAGNI — async covers the use case, and the override can be added later as a strict superset if real need emerges. First-run errors live in the pipeline journal; that's the right place because composite apply succeeded (registration) and the runtime owns ingest status.

### D4. Conflict policy — adopt with ownership marker (reference-counted)

Composite-applied pipelines carry `ownership: { source: 'composite'; compositeNames: string[]; specHash: string }` on their stored manifest. Operator-applied pipelines have no marker. Conflict matrix:

- **No marker, ownership param empty (operator path)** → existing operator-edit behavior, unchanged.
- **No marker, ownership param non-empty (composite trying to claim operator-owned)** → `Pending: PipelineNameCollision` with `existingOwner: 'operator'`. Operator must remove or rename.
- **Marker present, no ownership param (operator trying to overwrite composite-managed)** → `Pending: PipelineNameCollision` with `existingOwner: 'composite'`. Operator destroys the composite or passes the right `compositeName` to release ownership.
- **Marker present, same composite, same specHash** → no-op (idempotent).
- **Marker present, different composite, same specHash** → union `compositeNames`, mark changed. Two composites co-own one pipeline.
- **Marker present, different specHash** → `Pending: PipelineShapeMismatch`. Operator reconciles.

Reference-counted destroy: composite destroy strips its own name from `compositeNames`; pipeline (file + scheduler entry + journal cleanup) is removed only when the list empties.

Rationale: this is the same decision as `composite-gateway-auto-populate` (shipped earlier today) for the same problem shape (globally-named YAML store written by both composites and operators). Consistency keeps the operator mental model uniform; composite-namespaced names (Option C) would force migrations across the pipeline runtime/journal/scheduler/CLI, which the collision problem doesn't justify.

### D5. Implementation seam — composite applier delegates to `ragPipelineApply`

The composite applier doesn't reimplement pipeline-write logic. It calls the existing `ragPipelineApply` proc via the in-process tRPC caller (`baseRouter.createCaller({})`), passing `ownership` as an optional input. The proc's logic gains the ownership-aware merge rules; both composite-driven and operator-driven applies flow through the same proc.

Rationale: single source of truth for "what does it mean to apply a pipeline." Two paths drift. Same pattern is already used in this codebase (`router.ts:2935` shows project-indexing delegating to `ragPipelineApply` via the in-process caller).

### D6. Apply order tier — pipelines between ragNodes and gateways

Topo phases: `services → ragNodes → workloads → pipelines → gateways`. Pipelines slot after ragNodes (their structural prerequisite) and before gateways (which are the last-to-bring-up component since they're the routable surface). Workloads stay between ragNodes and pipelines because pipelines never depend on workloads (pipelines pull from sources, not from llama-server).

Rationale: matches structural dependencies; minimizes the "everything else is up but X is pending" window for any one tier.

## Architecture

### Server side (`packages/remote/src`)

```
composite/
├── schema.ts                MODIFY
│   PipelineCompositeEntrySchema    ← NEW
│     = z.object({ name, spec: RagPipelineSpecSchema })
│   CompositeSpecSchema gains:
│     pipelines: z.array(PipelineCompositeEntrySchema).default([])
│   collectComponentNames + uniqueness superRefine + DependencyEdgeSchema
│   allowed kinds gain `pipeline`.
│
├── dag.ts                   MODIFY
│   Implicit-edge derivation gains pipeline.destination.ragNode →
│   ragNodes[].name. Topo tier insertion places `pipeline` between
│   ragNodes and gateways.
│
├── apply.ts                 MODIFY
│   Component dispatch gains `pipeline` arm calling
│   composite/handlers/pipeline.ts. Destroy adds a pipeline-cleanup
│   phase invoking ragPipelineDelete with compositeName.
│
└── handlers/pipeline.ts     ← NEW
    apply(entry, ctx):
      1. specHash = entrySpecHash(entry.spec)
      2. caller.ragPipelineApply({
           manifest: { apiVersion, kind, metadata: { name: entry.name },
                       spec: entry.spec },
           ownership: {
             source: 'composite',
             compositeNames: [composite.name],
             specHash,
           },
         })
      3. on { conflict: 'name', existingOwner: 'operator' }:
         return Pending(reason: 'PipelineNameCollision', detail: ...)
      4. on { conflict: 'shape' }:
         return Pending(reason: 'PipelineShapeMismatch', detail: ...)
      5. on { ok: true, changed: true }:
         void caller.ragPipelineRun({ name: entry.name }).catch(...)
         return Ready
      6. on { ok: true, changed: false }:
         return Ready  // idempotent re-apply, no first-run trigger

rag/pipeline/
├── schema.ts                MODIFY
│   RagPipelineManifestSchema gains:
│     ownership: CompositeOwnershipSchema.optional()
│
├── store.ts                 MODIFY
│   YAML round-trip preserves ownership field.
│
├── apply.ts (or applyPipeline location)  MODIFY
│   Augmented ownership-aware merge logic per the data-flow section.
│   Returns ApplyResult discriminated union.
│
└── delete.ts (or deletePipeline location)  MODIFY
    Accepts optional `compositeName`. Ref-counted strip; delete-when-empty.
    Operator-owned entries (no marker) refuse composite-driven delete.

router.ts                    MODIFY
  ragPipelineApply input gains ownership?: CompositeOwnership.
  Output becomes ApplyResult (existing 'ok' shape preserved on success).
  ragPipelineDelete input gains compositeName?: string.
```

### Reused primitives

| Primitive | Source | Usage |
|---|---|---|
| `CompositeOwnershipSchema` | `packages/remote/src/workload/gateway-catalog/schema.ts` | Verbatim reuse — same marker shape across stores |
| `entrySpecHash` | `packages/remote/src/workload/gateway-catalog/hash.ts` | Verbatim reuse — stable-stringify-+-sha256 works for any object |
| `baseRouter.createCaller({})` | `packages/app/electron/trpc/dispatcher.ts:386` (existing pattern in `packages/remote/src/router.ts:2935`) | In-process caller for `ragPipelineApply`/`ragPipelineRun`/`ragPipelineDelete` |

### Schema additions

```ts
// packages/remote/src/composite/schema.ts (additive)

export const PipelineCompositeEntrySchema = z.object({
  name: z.string().min(1).regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'pipeline name must be lowercase-alphanumeric-hyphens',
  ),
  spec: RagPipelineSpecSchema,   // verbatim reuse — no composite-specific subset
});
export type PipelineCompositeEntry = z.infer<typeof PipelineCompositeEntrySchema>;

export const CompositeSpecSchema = z.object({
  services: z.array(ServiceSpecSchema).default([]),
  workloads: z.array(ModelRunSpecSchema).default([]),
  ragNodes: z.array(RagNodeCompositeEntrySchema).default([]),
  gateways: z.array(GatewayCompositeEntrySchema).default([]),
  pipelines: z.array(PipelineCompositeEntrySchema).default([]),  // NEW
  dependencies: z.array(DependencyEdgeSchema).default([]),
  onFailure: z.enum(['rollback', 'leave-partial']).default('rollback'),
  runtime: CompositeRuntimeSchema.optional(),
});
```

```ts
// packages/remote/src/rag/pipeline/schema.ts (additive)

import { CompositeOwnershipSchema } from '../../workload/gateway-catalog/schema.js';

export const RagPipelineManifestSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('RagPipeline'),
  metadata: z.object({ name: z.string().min(1) }),
  spec: RagPipelineSpecSchema,
  ownership: CompositeOwnershipSchema.optional(),  // NEW
});
```

### Result types (`rag/pipeline/apply.ts`)

```ts
export type ApplyConflict =
  | { kind: 'name'; name: string; existingOwner: 'operator' | 'composite' }
  | { kind: 'shape'; name: string; reason: string };

export type ApplyResult =
  | { ok: true; changed: boolean }
  | { ok: false; conflict: ApplyConflict };
```

## Data flow

### Apply lifecycle

```
compositeApply(spec)
  └─ Phase 0: validate, compute topo order
        Implicit edges added:
          - gateways[i].upstreamWorkloads → workloads[j]      (existing)
          - pipelines[i].destination.ragNode → ragNodes[j]    (NEW)
        Explicit edges from spec.dependencies merge.
        Topo tiers: services → ragNodes → workloads → pipelines → gateways

  └─ Phase 1: per-component apply, in topo order
        For each component:
          handler ← dispatch(kind)
          status ← await handler.apply(component, ctx)
          if status.failed && spec.onFailure === 'rollback':
            roll back every prior successful component (reverse order)
            return composite Failed

        pipeline handler: see composite/handlers/pipeline.ts shape above.

  └─ Phase 2: persist composite status (existing)
```

### `applyPipeline` core logic (server-side, ownership-aware)

```
applyPipeline(manifest, opts):
  cur ← loadPipeline(manifest.metadata.name)   // null if absent
  newHash ← entrySpecHash(manifest.spec)

  if !cur:                                      // brand new
    storePipeline(manifest, opts.ownership)
    if manifest.spec.schedule: scheduler.add(manifest)
    return { ok: true, changed: true }

  if !cur.ownership:
    if opts.ownership:                          // composite trying to claim operator-owned
      return { ok: false, conflict: { kind: 'name', existingOwner: 'operator', name: ... } }
    // operator updating their own pipeline — existing behavior, unchanged
    const changed = entrySpecHash(cur.spec) !== newHash
    storePipeline(manifest, undefined)
    return { ok: true, changed }

  // cur has marker
  if !opts.ownership:
    // operator trying to overwrite composite-managed
    return { ok: false, conflict: { kind: 'name', existingOwner: 'composite', name: ... } }

  if cur.ownership.specHash === newHash &&
     cur.ownership.compositeNames.includes(opts.ownership.compositeNames[0]):
    return { ok: true, changed: false }         // idempotent

  if cur.ownership.specHash !== newHash:
    return { ok: false, conflict: { kind: 'shape', name: ..., reason: ... } }

  // same shape, different composite — union
  storePipeline(manifest, {
    source: 'composite',
    compositeNames: union(cur.ownership.compositeNames, opts.ownership.compositeNames),
    specHash: newHash,
  })
  return { ok: true, changed: true }
```

### Destroy lifecycle

```
compositeDestroy(name)
  └─ Phase 0: load composite status, identify components owned/co-owned

  └─ Phase 1: tear down in reverse topo order
        gateways → pipelines → workloads → ragNodes → services

        pipeline tear-down:
          caller.ragPipelineDelete({
            name: entry.name,
            compositeName: composite.name,
          })
          → strip composite.name from ownership.compositeNames
          → if list empties: delete pipeline file + scheduler entry + journal cleanup
          → idempotent if pipeline already absent

  └─ Phase 2: remove composite's own status record
```

### Re-apply (idempotency)

Re-applying the same composite spec returns `{ changed: false }` from `applyPipeline` for every pipeline (specHash matches; this composite is already in `compositeNames`). Handler skips the first-run trigger. Scheduler entry untouched. Zero scheduler thrash on noop apply.

## Error handling

- **Pipeline references inline ragNode that fails to apply.** Implicit topo edge ensures pipeline tier runs after ragNode tier. ragNode failure halts topo; pipeline never runs. With `onFailure: rollback`, the composite rolls back; pipeline was never applied so nothing to undo.
- **Pipeline applies successfully but first-run fails.** Apply path completed (registration ok); composite reaches `Ready`. First-run failure surfaces in the pipeline journal; next scheduled run retries. Composite-apply does not block on or report first-run errors (D3 decision).
- **Operator-name collision** → `Pending: PipelineNameCollision` (`existingOwner: 'operator'`). Composite halts at this entry; topo dependents downstream pick up the dependent-failed condition. Operator's pipeline is never touched.
- **Composite-claim by operator** → `ragPipelineApply` (operator path, no `ownership` param) against a composite-managed pipeline returns `Pending: PipelineNameCollision` (`existingOwner: 'composite'`). Operator either destroys the composite or passes the right `compositeName` to release ownership.
- **Inter-composite shape disagreement** → `Pending: PipelineShapeMismatch`. Operator reconciles by either renaming the pipeline in one composite or unifying the spec across composites.
- **Pipeline runtime offline (RAG node unreachable, embedder unavailable).** Apply still registers the pipeline; first-run errors get journaled. Pipeline is registered even if not currently runnable. Existing pipeline-runtime behavior; this work doesn't change it.
- **Disk-full on pipeline-store write.** `applyPipeline` returns an error the way it does today for operator-driven applies; composite handler maps it to `Pending: PipelineStoreWriteFailed` (new reason). Reload of the scheduler is skipped.
- **Composite destroyed while a first run is in flight.** The pipeline file removal races against the runtime's in-flight ingest. Best-effort — runtime detects the missing manifest at next chunk-store and bails. No data corruption because each chunk write is independent.

## Testing

### Server (`packages/remote/test/`)

| Test | Coverage |
|---|---|
| `pipeline-apply-ownership.test.ts` | `applyPipeline` ownership-aware merge — 9 cases: brand-new, idempotent re-apply (same composite + same shape), union compositeNames (same shape, different composite), operator-name collision, composite-claim-on-operator collision, shape mismatch between two composites, operator updating their own pipeline (no-marker path unchanged), composite + same-shape + new compositeName unions correctly, schema round-trip of ownership field |
| `pipeline-delete-refcounted.test.ts` | `deletePipeline({ compositeName })` — single-owner removal, multi-owner ref-count, no-op when name absent, operator-owned protected from composite-driven destroy |
| `composite-pipeline-apply.test.ts` | End-to-end via the composite applier: a composite manifest with `pipelines: [{...}]` applies; ragPipelineApply called with the right shape; first-run triggered async; idempotent re-apply produces zero changes; rollback unwinds the pipeline. Uses `LLAMACTL_TEST_PROFILE`. |
| `composite-pipeline-destroy.test.ts` | End-to-end: `compositeDestroy` strips the composite's name from each pipeline's `ownership.compositeNames`; pipelines owned solely by the destroyed composite disappear; co-owned pipelines stay. |
| `composite-dag-pipeline.test.ts` | DAG + topo: implicit edge from `pipeline.destination.ragNode` to inline `ragNodes[]`; explicit `dependencies:` edges with `kind: pipeline` work; cycle detection picks up cycles that include pipeline nodes. |
| `composite-schema-pipeline.test.ts` | Schema: `pipelines:` field defaults to `[]`; pipeline-name uniqueness within a composite; pipeline-name regex; cross-component name collisions allowed across kinds (a pipeline named `docs` and a service named `docs` is fine — namespaces are per-kind). |

All tests run under existing hermetic `LLAMACTL_TEST_PROFILE` / `DEV_STORAGE` patterns.

### Cross-repo verification (pre-merge)

```
cd /Volumes/WorkSSD/repos/personal/llamactl       && bun test 2>&1 | tail -3
cd /Volumes/WorkSSD/repos/personal/sirius-gateway && bun test 2>&1 | tail -3
cd /Volumes/WorkSSD/repos/personal/embersynth     && bun test 2>&1 | tail -3
cd /Volumes/WorkSSD/repos/personal/nova           && bun test 2>&1 | tail -3
```

Expected: llamactl rises with the new tests; sirius/embersynth/nova counts unchanged.

### E2E (opt-in)

Extend `packages/remote/test/composite-e2e.test.ts` (gated on `LLAMACTL_COMPOSITE_E2E=1` + Docker socket): a composite with one inline `ragNodes:` (chroma-on-docker) + one `pipelines:` (filesystem source ingesting a fixture dir) should apply cleanly; the pipeline appears with the ownership marker; the first run completes (writes chunks to chroma); destroy removes both.

## Rollout

Single PR, all-or-nothing in `packages/remote`. Tag the merge `composite-pipelines-bridge`. No app-side changes; no cross-repo coordination.

**Pre-merge sequence:**

1. Schema additions (`composite/schema.ts` `pipelines:` array; `rag/pipeline/schema.ts` ownership field) + tests.
2. `composite/dag.ts` topo updates (implicit pipeline → ragNode edge, tier insertion) + tests.
3. `rag/pipeline/apply.ts` ownership-aware merge logic + `pipeline-apply-ownership.test.ts`.
4. `rag/pipeline/delete.ts` ref-counted removal + `pipeline-delete-refcounted.test.ts`.
5. `router.ts` proc input augmentation.
6. `composite/handlers/pipeline.ts` + dispatch wiring + `composite-pipeline-apply.test.ts`.
7. `composite/apply.ts` destroy-path cleanup + `composite-pipeline-destroy.test.ts`.
8. Cross-repo regression sweep.
9. Docs update (`docs/composites.md` adds "Composite-managed RAG pipelines" section; `docs/rag-pipelines.md` cross-references).
10. Tag + merge.

**Migration / data:** none. Existing pipelines authored via `ragPipelineApply` continue working unchanged (no marker → operator-owned → protected). Existing composites without a `pipelines:` field continue working (default `[]`).

## Out of scope (deferred)

- **App-side composite-detail UI for pipelines.** The Composites module shows services/workloads/ragNodes/gateways. Adding a "Pipelines" pane is a follow-up. Source of truth in v1 is `compositeStatus` + the pipeline store + CLI.
- **`pipelineRef:` (Option B/C from D1).** Pipelines are inline-only in v1; ref-by-name deferred until usage shows it's needed.
- **Per-entry `runOnApply: 'sync' | 'async' | 'never'` (Option D from D3).** v1 always async. Tunable knob is a strict-superset follow-up.
- **First-run progress in `compositeStatus`.** v1's `compositeStatus.components[]` shows pipeline state as `Pending` / `Ready` / `Failed` based on registration only, not first-run progress. Operators read first-run state via the existing pipeline status surface (`ragPipelineStatus`).
- **CLI ergonomics (`llamactl composite pipelines list`, `llamactl composite pipelines logs <name>`).** v1 reuses existing composite + pipeline CLI commands; no new subcommands.
- **Auto-merge on `PipelineShapeMismatch`.** Operator handles conflicts manually — no `--force-replace`, no migration helper.
- **Pipelines depending on workloads or gateways.** v1 implicit edge is pipeline → ragNode only. Cross-kind pipeline dependencies require explicit `dependencies:` edges.
- **Shared "ownership-aware store helper" extraction.** v1 reuses `CompositeOwnershipSchema` verbatim but doesn't yet extract a shared helper. If a third store needs the same pattern, that helper extraction is the natural follow-up.

## Success criteria

1. A composite manifest with a `pipelines:` block applies cleanly. The pipeline appears in the pipeline store with `ownership: { source: 'composite', compositeNames: [<name>], specHash: <hash> }`. The first ingest run triggers asynchronously (visible in the pipeline journal); composite reaches `Ready` once registration succeeds.
2. Re-applying the same composite spec is a no-op: `applyPipeline` returns `{ changed: false }` for every pipeline; no scheduler thrash; no first-run trigger.
3. Two composites declaring the same pipeline (same shape) union into one entry with `compositeNames: [a, b]`. Destroying either one strips its name; the entry stays. Destroying both removes the entry and its scheduler registration.
4. A composite naming a pipeline that already exists as operator-owned returns `Pending: PipelineNameCollision` (`existingOwner: 'operator'`). The operator's pipeline is never touched.
5. Two composites declaring the same pipeline name with different sources/transforms/schedule produces `Pending: PipelineShapeMismatch` on the second apply; first composite's pipeline stays as-is.
6. An inline pipeline with `destination.ragNode` matching an inline `ragNodes[]` entry causes the topo applier to apply the rag node first; the pipeline applies after. Operator can declare cross-kind explicit `dependencies:` edges (pipeline → service, service → pipeline) and they merge cleanly with implicit edges.
7. `compositeApply` rollback (`onFailure: rollback`) un-registers any pipelines this apply added if a later component fails. Pipelines from prior composite applies (different `compositeNames`) are untouched.
8. `compositeDestroy` strips the destroyed composite's name from each owned pipeline; entries owned solely by it disappear (file + scheduler entry); co-owned entries persist with shorter `compositeNames`.
9. Operator-driven `ragPipelineApply` and `ragPipelineDelete` continue working without regression for pipelines that have no ownership marker.
10. Cross-repo sweep stays green; sirius/embersynth/nova unchanged.
