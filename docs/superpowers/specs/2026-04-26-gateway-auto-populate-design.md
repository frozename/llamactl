# Gateway Catalog Auto-Populate — Design

**Status:** Approved (brainstorm), pending implementation plan
**Date:** 2026-04-26
**Phase:** Convergence follow-up — closes the K.7 gateway upstream-threading story
**Spec scope:** Sirius and embersynth gateway handlers auto-populate `sirius-providers.yaml` / `embersynth.yaml` from `CompositeGatewayContext.upstreams` so operators stop hand-editing those files before applying a composite.

## Goal

When a composite spec routes upstream workloads through a sirius or embersynth gateway, llamactl should write the corresponding catalog entries before calling reload — so the composite apply succeeds end-to-end without `llamactl sirius add-provider` or `llamactl embersynth sync` as a precondition. Composite-managed entries carry an ownership marker so they coexist with operator-authored entries, are reference-counted across multiple composites, and disappear when the last owning composite is destroyed.

## Background

The K.7 substantive landing (2026-04-21, see `~/.claude/plans/radiant-converging-knuth.md`) shipped `CompositeGatewayContext { compositeName, upstreams[], providerConfig }` and threaded it through `dispatchGatewayApply` to handlers. The plan documented that "auto-population of their catalogs from `upstreamWorkloads` is a documented follow-up" — both `siriusHandler` and `embersynthHandler` currently ignore `opts.composite` entirely. Today the operator must hand-edit `sirius-providers.yaml` (`llamactl sirius add-provider`) or `embersynth.yaml` (`llamactl embersynth sync`) *before* running `compositeApply`, otherwise the apply fails with `SiriusUpstreamMissing` / `EmbersynthSyntheticMissing`. This work closes that gap.

The convergence model (locked in `radiant-converging-knuth.md`) is unchanged: **llamactl is the single authority for the YAML configs the other two read.** Sirius and embersynth re-read on `/providers/reload` and `/config/reload`. So the auto-populate path lives entirely in llamactl; the sibling repos see new entries the next time they reload, no code changes required there.

## Decisions

### D1. Scope: both gateways in one slice

Sirius and embersynth handlers both gain auto-populate in the same plan. Coherent story; the YAML mutation patterns are similar enough that splitting buys nothing.

### D2. Ownership: composite-namespaced marker, reference-counted

Every composite-authored entry carries a small `ownership` object:

```ts
type CompositeOwnership = {
  source: 'composite';
  compositeNames: string[];   // length >= 1
  specHash: string;
};
```

Operator-authored entries omit the field entirely. Two composites referencing the same upstream union into one entry with `compositeNames: [a, b]`. Destroy strips a composite's name from the list; only deletes the entry when the list empties. This handles co-ownership correctly without growing a new state machine or new CLI command.

### D3. `providerConfig` shape: typed common fields + escape hatch

`CompositeGatewayContext.providerConfig` becomes:

```ts
type ProviderConfigCommon = {
  tags?: string[];
  displayName?: string;
  priority?: number;
  extra?: Record<string, unknown>;
};
```

Replaces today's opaque `Record<string, unknown>`. Strict where it matters cross-handler (`tags`, `displayName`, `priority`); flexible where it doesn't (`extra` for handler-specific opaque overrides).

### D4. Cross-repo scope: pure llamactl-side change

No code in sirius or embersynth. The new schema fields are optional; sibling parsers ignore unknown keys (or pass them through verbatim — see precondition D8). The convergence model already declares llamactl as YAML authority.

### D5. Where the YAML mutation lives

A new pure module `packages/remote/src/workload/gateway-catalog/`. Handlers call into it; the composite destroy path also calls into it (for cleanup). Pure functions everywhere except `io.ts`, which is the single side-effecting boundary. Keeps testing trivial and reuses one set of conflict/merge rules across both apply and destroy paths.

### D6. Conflict policy

Conflicts surface as `Pending` with named reasons (matching existing handler convention):

- **Operator-owned name collision** → `NameCollision`. Composite halts at that gateway entry. Operator's entry is never touched.
- **Two composites disagree on entry shape** (e.g., different `baseUrl` for the same name) → `ShapeMismatch`. Operator must reconcile.
- Same name + same shape across composites → union `compositeNames`, no conflict.

Conflicts are returned by the pure `applyCompositeEntries` function; handlers translate to `Pending` with the appropriate reason.

### D7. Idempotency

`specHash` on the ownership marker is a deterministic hash of `(kind, name, baseUrl, tags, apiKeyRef, displayName, priority, extra)`. On re-apply, if the derived entry's hash matches what's on disk, `applyCompositeEntries` returns `{ changed: false }` and the handler skips both the YAML write and the reload call. No-op apply is truly no-op. (Plain ModelRun-driven gateway applies — no composite — keep their current always-reload behavior; the `changed: false` short-circuit only affects composite-driven calls.)

### D8. Sibling-schema precondition (verify before merge)

Sirius and embersynth must not reject the new optional `ownership` field. Verify with:

```bash
cd /Volumes/WorkSSD/repos/personal/sirius-gateway
grep -rn "providers:\|SiriusProvider\|ProviderSchema" libs/ apps/ --include="*.ts" | head -10

cd /Volumes/WorkSSD/repos/personal/embersynth
grep -rn "syntheticModels\|SyntheticModel\|EmbersynthConfig" src/ --include="*.ts" | head -10
```

If either schema uses Zod `.strict()`, ship a one-line PR per repo to `.passthrough()` (or to extend with the optional `ownership` field) **before** the llamactl PR merges. Both PRs are trivial; this is a precondition, not part of the v1 scope.

## Architecture

### Server (`packages/remote/src/`)

```
workload/gateway-catalog/                      ← NEW
├── schema.ts                CompositeOwnership zod schema, derived-entry types
├── sirius-entries.ts        deriveSiriusEntries(ctx) → DerivedSiriusEntry[]
├── embersynth-entries.ts    deriveEmbersynthEntries(ctx) → DerivedEmbersynthEntry[]
├── hash.ts                  entrySpecHash(entry) — stable, ignores compositeNames order
├── apply.ts                 applyCompositeEntries(...) — pure merge + conflict detection
├── remove.ts                removeCompositeEntries(...) — pure ref-counted removal
├── io.ts                    readGatewayCatalog(kind), writeGatewayCatalog(kind, yaml)
└── index.ts                 public re-exports

workload/gateway-handlers/
├── types.ts                 CompositeGatewayContext.providerConfig becomes typed (ProviderConfigCommon)
├── sirius.ts                apply() gains catalog-mutate prelude when opts.composite is set
└── embersynth.ts            symmetric

config/
├── sirius-providers.ts      SiriusProviderSchema gains optional `ownership?: CompositeOwnership`
└── embersynth.ts            EmbersynthNodeSchema gains optional
                             `ownership?: CompositeOwnership`. Composite-managed nodes carry
                             the marker; operator-authored nodes do not. Composites do NOT
                             write `syntheticModels` mappings in v1 — that map stays a flat
                             `Record<string, string>` and operator-managed (via the existing
                             `llamactl embersynth sync`). Composite-authored nodes have unique
                             ids (`<compositeName>-<upstream.name>`); operators wire them into
                             a friendly synthetic name manually or via `embersynth sync`.

composite/
├── schema.ts                providerConfig: opaque Record → typed ProviderConfigCommon
└── destroy.ts (or wherever) call removeCompositeEntries() per kind after teardown, then reload
```

### Result types

```ts
export type ApplyConflict =
  | { kind: 'name'; name: string; existingOwner: 'operator' }
  | { kind: 'shape'; name: string; reason: string };

export interface ApplyResult {
  nextYaml: GatewayYaml;       // tagged union
  changed: boolean;
  conflicts: ApplyConflict[];  // empty when fully applied
}

export interface RemoveResult {
  nextYaml: GatewayYaml;
  changed: boolean;
  removedNames: string[];
}
```

`applyCompositeEntries` returns conflicts rather than throwing; handlers translate to `Pending`.

### Handler prelude (sirius)

```
siriusHandler.apply(opts):
  1. if opts.composite is undefined → existing flow (host-side validate, reload). DONE.
  2. derived ← deriveSiriusEntries(opts.composite)
  3. cur ← readGatewayCatalog('sirius')
  4. res ← applyCompositeEntries({ kind: 'sirius', derived, current: cur })
  5. if res.conflicts.length > 0:
       return Pending with NameCollision or ShapeMismatch (named per first conflict)
  6. if res.changed:
       writeGatewayCatalog('sirius', res.nextYaml)
  7. existing host-side validation (now passes — entries exist)
  8. POST /providers/reload  (skipped if !res.changed AND no shape changes — strict idempotent)
  9. existing success path
```

Embersynth handler mirrors this exactly, swapping `deriveEmbersynthEntries` and the reload URL.

### Composite destroy cleanup

After existing teardown (workloads + services in reverse topo order):

```
for kind in ['sirius', 'embersynth']:
  cur ← readGatewayCatalog(kind)
  res ← removeCompositeEntries({ kind, compositeName, current: cur })
  if res.changed:
    writeGatewayCatalog(kind, res.nextYaml)
    POST <reload endpoint>   // sirius drops the routes; embersynth drops the syntheticModels
```

Operator-authored entries are untouched throughout. Reference-counted removal: a destroyed composite's name is stripped from every entry's `compositeNames`; entries with empty lists are dropped; entries with remaining owners are kept.

## Data flow

### Apply lifecycle

```
compositeApply(spec)
  └─ services → workloads → ragNodes → gateways  (existing topo order)
        └─ gateway entry G:
             ├─ resolve upstream endpoints → CompositeGatewayContext ctx
             ├─ handler.apply({ manifest, node, composite: ctx, ... })
             │    ├─ deriveXxxEntries(ctx) → derived entries
             │    ├─ readGatewayCatalog(kind) → current YAML
             │    ├─ applyCompositeEntries():
             │    │    new entry → append (changed=true)
             │    │    same name + same composite → no-op
             │    │    same name + diff composite + same shape → union compositeNames (changed=true)
             │    │    same name + diff composite + diff shape → conflict { kind: 'shape' }
             │    │    same name + no marker (operator entry) → conflict { kind: 'name' }
             │    ├─ if conflicts → Pending (NameCollision / ShapeMismatch). STOP.
             │    ├─ if changed → writeGatewayCatalog(kind, nextYaml)
             │    ├─ host-side validate
             │    └─ POST <reload>  (skipped if !changed)
             └─ existing handler success/failure path
```

### Re-apply (idempotency)

Re-applying the same composite spec:
- Each derived entry's `specHash` matches the one on disk → `applyCompositeEntries` returns `changed: false`.
- Handler skips `writeGatewayCatalog` and skips reload.
- Net effect: zero disk write, zero HTTP, zero reload-induced bench recompute on embersynth's side.

### Destroy lifecycle

```
compositeDestroy(name)
  └─ workloads + services teardown (existing reverse topo)
  └─ NEW: gateway-catalog cleanup:
        for kind in ['sirius', 'embersynth']:
          cur ← readGatewayCatalog(kind)
          res ← removeCompositeEntries({ kind, compositeName: name, current: cur })
          if res.changed:
            writeGatewayCatalog(kind, res.nextYaml)
            POST <reload>
```

`removeCompositeEntries` walks every entry; for any entry where `ownership.compositeNames.includes(name)`:
- Strip `name` from the list.
- If the list is now empty → drop the entry.
- Otherwise → rewrite with the shorter list.

Operator entries (no `ownership`) are skipped entirely.

### Atomicity

If YAML write succeeds but reload fails:
- Entries persist; sirius/embersynth haven't yet seen them.
- Handler returns `Pending: SiriusReloadFailed` (existing reason).
- Re-apply is a no-op on the YAML side and retries the reload.
- Match the existing semantics — no rollback of the YAML write because (a) entries are correct (just unloaded), (b) rolling back would race other in-flight composites updating the same file.

### Multi-composite ownership

Two composites referencing the same upstream → one YAML entry with `compositeNames: [a, b]`. `specHash` is computed from entry shape (not the names list), so adding/removing composite ownership doesn't trigger a "shape changed" reapply for the other composite.

## Error handling

- **Operator-name collision** → `Pending: NameCollision`, message names the conflicting entry. Composite halts at that gateway. Topo dependents fail with the existing dependent-failed condition.
- **Inter-composite shape disagreement** → `Pending: ShapeMismatch`, message names the conflicting field (e.g., `baseUrl differs from composite '<other>'`).
- **YAML unreadable** → existing `SiriusProvidersUnreadable` / `EmbersynthConfigUnreadable` reasons.
- **YAML write failure (disk full, permission)** → new reasons `SiriusCatalogWriteFailed` / `EmbersynthCatalogWriteFailed`. Reload is skipped.
- **Reload fails after successful YAML write** → existing `SiriusReloadFailed` / `EmbersynthReloadFailed` reasons. YAML stays. Re-apply retries reload.
- **Sibling schema rejects ownership field** → caught by D8 precondition before merge. Should never hit production.

## Testing

### Server

| Test | Coverage |
|---|---|
| `gateway-catalog-schema.test.ts` | `CompositeOwnership` round-trip through YAML; loading entry without marker still parses |
| `gateway-catalog-derive-sirius.test.ts` | One upstream → one openai-compatible provider; empty upstreams → empty list; `tags` flow into entry; `extra` preserved verbatim |
| `gateway-catalog-derive-embersynth.test.ts` | Upstreams → node entries (one per upstream pointing at endpoint); `tags` flow into the node's `tags`; `priority` flows into the node's priority; ownership marker attached. SyntheticModels mapping is NOT touched. |
| `gateway-catalog-hash.test.ts` | Deterministic for same shape; differs on tag changes; ignores `compositeNames` order |
| `gateway-catalog-apply.test.ts` | New entry append; idempotent re-apply; union compositeNames on same shape; name conflict against operator entry; shape conflict between two composites |
| `gateway-catalog-remove.test.ts` | Reference-counted removal; entry deleted when last composite removed; entry kept (shorter list) when other composite still references it; no-op when name not present |
| `gateway-catalog-io.test.ts` | `readGatewayCatalog` / `writeGatewayCatalog` round-trip under `LLAMACTL_TEST_PROFILE` |
| `gateway-handler-sirius-composite.test.ts` (extends existing) | With `opts.composite` set: writes entries, calls reload; conflict surfaces `Pending: NameCollision`; YAML write failure surfaces `Pending: SiriusCatalogWriteFailed`; idempotent re-apply skips reload |
| `gateway-handler-embersynth-composite.test.ts` (extends existing) | Symmetric |
| `composite-destroy-catalog-cleanup.test.ts` (extends existing destroy test) | Destroy strips name from entries; entries with no remaining composites disappear; reload triggered when changed; reload skipped when nothing changed |

All run under the existing hermetic `LLAMACTL_TEST_PROFILE` / `DEV_STORAGE` pattern.

### Cross-repo verification (pre-merge)

```
cd /Volumes/WorkSSD/repos/personal/llamactl && bun test
cd /Volumes/WorkSSD/repos/personal/sirius-gateway && (sirius's test command)
cd /Volumes/WorkSSD/repos/personal/embersynth && bun test
cd /Volumes/WorkSSD/repos/personal/nova && bun test
```

Expected: llamactl number rises (new tests); sirius / embersynth / nova unchanged.

### E2E (opt-in)

Extend `packages/remote/test/composite-e2e.test.ts` (gated on `LLAMACTL_COMPOSITE_E2E=1` + Docker socket): a composite that names an llama-server workload + sirius gateway should apply cleanly without any pre-existing `llamactl sirius add-provider`. The provider entry should appear with `ownership` marker; destroy should remove it.

## Rollout

Single PR, all-or-nothing in llamactl. Tag `composite-gateway-auto-populate`.

**Pre-merge sequence:**
1. D8 precondition check on sirius + embersynth schemas; ship one-line `passthrough()` PR per sibling if needed.
2. Schema additions (sirius-providers, embersynth, composite spec) + their tests.
3. Pure `gateway-catalog/` modules + tests.
4. `gateway-catalog/io.ts` + integration test.
5. Handler integration (sirius, embersynth) + composite-aware tests.
6. Composite destroy cleanup integration + test.
7. Docs update (`docs/composites.md` follow-up note → real description).
8. Cross-repo regression sweep.
9. Merge + tag.

## Out of scope (deferred)

- **Composite-authored `syntheticModels` mapping in embersynth.** v1 only auto-populates `nodes`. Operator continues to author `syntheticModels` entries (manually or via `llamactl embersynth sync`). A future slice can add ownership tracking for synthetic-name mappings — the cleanest shape is probably a Zod union or a sidecar ownership index; defer until usage shows the need.
- **CLI inspection** (`llamactl sirius list-managed --composite=<name>` etc.). Source of truth is `compositeStatus` + the YAML files; `cat` and `grep` work.
- **Endpoint-change reactivity.** v1 ties entry to endpoint at apply time; if a workload moves nodes (rare), operator runs `compositeApply` again.
- **Drift detection.** No background reconciler. Apply is the trigger.
- **Per-composite YAML files.** Single shared `sirius-providers.yaml` / `embersynth.yaml` continue to host all entries.
- **Sirius/embersynth UI surfacing of `ownership`** (would-be Q5-B). Future enhancement.
- **Acknowledge endpoint** (would-be Q5-C). HTTP reload response code is enough for v1.
- **`extra` field semantics** — stored verbatim, not validated; handler-specific consumption is a future slice.
- **Conflict auto-renaming.** No `--rename` flag; v1 surfaces `NameCollision` and stops.
- **Provider catalog templates / DRY across composites.** Each composite spells out its upstreams.

## Success criteria

1. A composite spec that names a workload as a gateway upstream applies cleanly **without** `llamactl sirius add-provider` or `llamactl embersynth sync` as a precondition. Auto-populated entry appears in YAML with correct `ownership`.
2. Re-applying the same composite with no spec changes is a no-op: zero YAML write, zero reload.
3. Destroying a composite strips its name from `compositeNames`; entries owned solely by the destroyed composite disappear; co-owned entries stay (with shorter list).
4. Composite naming an entry that already exists as operator-owned returns `Pending: NameCollision`. Operator's entry is never touched.
5. Two composites referencing the same upstream union into one entry with `compositeNames: [a, b]`. Destroying either leaves the entry; destroying both removes it.
6. `opts.composite === undefined` (plain ModelRun gateway apply) handler behavior is bit-identical to today.
7. All existing handler + composite tests still pass unchanged. New tests added per the test surface.
8. Cross-repo sweep stays green at existing tallies.
