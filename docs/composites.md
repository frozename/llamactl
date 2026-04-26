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