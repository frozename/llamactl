## Gateway catalog auto-populate

When a composite spec routes upstream workloads through a sirius or
embersynth gateway, llamactl writes the corresponding catalog entries
into `sirius-providers.yaml` / `embersynth.yaml` (the `nodes:` list)
*before* calling the gateway's reload endpoint. Operators no longer
need to run `llamactl sirius add-provider` or `llamactl embersynth
sync` as a precondition for `llamactl composite apply`.

Composite-authored entries carry an `ownership` marker:

    ownership:
      source: composite
      compositeNames: [<name>, ...]
      specHash: <hash>

Operator-authored entries omit this object and are never modified.
Two composites referencing the same upstream workload union into one
entry with both names in `compositeNames`. Destroying a composite
strips its name from `compositeNames`; entries owned solely by the
destroyed composite are removed; co-owned entries persist with a
shorter list.

If a composite-derived entry name collides with an operator-authored
entry, the apply returns `Pending` with reason
`SiriusUpstreamNameCollision` / `EmbersynthUpstreamNameCollision`.
If two composites disagree on an entry's shape (e.g., different
baseUrl), the second apply returns `Pending` with reason
`SiriusUpstreamShapeMismatch` / `EmbersynthUpstreamShapeMismatch`.

Re-applying a composite with no spec changes is a no-op: zero YAML
write, zero reload.

## Composite-managed RAG pipelines

A composite can declare RAG pipelines as a fifth component kind. Each
entry in `spec.pipelines: []` is `{ name, spec }` where `spec` is a
verbatim `RagPipelineSpec` (sources, transforms, destination, schedule,
on_duplicate, cost, concurrency).

```yaml
apiVersion: llamactl/v1
kind: Composite
metadata: { name: vision-stack }
spec:
  ragNodes:
    - name: kb-chroma
      kind: rag
      rag: { provider: chroma, endpoint: http://localhost:8000, collection: docs }
  pipelines:
    - name: docs-ingest
      spec:
        destination: { ragNode: kb-chroma, collection: docs }
        sources: [{ kind: filesystem, root: /Users/me/docs }]
        schedule: '@hourly'
        on_duplicate: replace
```

The composite applier wires implicit DAG edges from `pipelines[].destination.ragNode`
to inline `ragNodes[]` so apply order is `services → ragNodes → workloads
→ pipelines → gateways`. Cross-kind dependencies (e.g., a pipeline that
needs a transform service first) go in the explicit `dependencies:` list.

Composite-managed pipelines carry an `ownership` marker
(`source: 'composite'`, `compositeNames: [...]`, `specHash`) and are
reference-counted on destroy: a pipeline shared by two composites
disappears only when both are destroyed. Operator-authored pipelines
(`ragPipelineApply` outside a composite) are never touched by composite
apply or destroy.

Conflict reasons surface as `Pending` in `compositeStatus.components[]`:

  - `PipelineNameCollision` — a pipeline with the same name already
    exists, owned by either an operator or a different composite that
    didn't co-own this name.
  - `PipelineShapeMismatch` — two composites declare the same pipeline
    name with different specs (different `specHash`).

The first ingest run is fire-and-forget on apply: the composite reaches
`Ready` once the pipeline is registered, not when the first ingest
completes. First-run progress lives in the pipeline journal; surface
it via `ragPipelineList` / `ragPipelineRunning`.