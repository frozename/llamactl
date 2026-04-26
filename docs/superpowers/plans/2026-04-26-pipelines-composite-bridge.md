# Pipelines → Composite Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Composites declare RAG pipelines as a new component kind. The composite applier registers each pipeline through the existing `ragPipelineApply` proc with a `CompositeOwnership` marker (reused verbatim from gateway-catalog). Reference-counted destroy mirrors the gateway-catalog pattern. First ingest run is fire-and-forget on apply. Pipelines participate in topo order via an implicit edge to their `destination.ragNode`.

**Architecture:** New `PipelineCompositeEntrySchema` in `composite/schema.ts` (`{ name, spec: RagPipelineSpec }`), routed through a new `composite/handlers/pipeline.ts`. The handler delegates to `ragPipelineApply` via the existing in-process tRPC caller (`router.createCaller({})`), passing `ownership`. `applyPipeline` in `rag/pipeline/store.ts` gains ownership-aware merge logic. `removePipeline` gains ref-counted strip-and-delete. No new tRPC procs; existing `ragPipelineApply` and `ragPipelineRemove` procs gain optional ownership-related fields.

**Tech Stack:** TypeScript, Zod, Bun test, the existing `composite/apply.ts` topo applier, the existing `rag/pipeline/store.ts` (uses `~/.llamactl/rag-pipelines/<name>/spec.yaml` per-pipeline directory layout), `CompositeOwnershipSchema` from `packages/remote/src/workload/gateway-catalog/schema.ts`, in-process caller (`router.createCaller({})`).

**Spec:** `docs/superpowers/specs/2026-04-26-pipelines-composite-bridge-design.md`

---

## File Structure

### Created

- `packages/remote/src/composite/handlers/pipeline.ts` — pipeline component handler
- `packages/remote/test/pipeline-apply-ownership.test.ts` — ownership-aware merge logic
- `packages/remote/test/pipeline-remove-refcounted.test.ts` — ref-counted removal
- `packages/remote/test/composite-pipeline-apply.test.ts` — end-to-end apply
- `packages/remote/test/composite-pipeline-destroy.test.ts` — end-to-end destroy
- `packages/remote/test/composite-dag-pipeline.test.ts` — DAG implicit-edge inference
- `packages/remote/test/composite-schema-pipeline.test.ts` — schema additions

### Modified

- `packages/remote/src/composite/schema.ts` — add `PipelineCompositeEntrySchema`; `pipelines:` array on `CompositeSpecSchema`; uniqueness check; `DependencyEdgeSchema` allowed kinds
- `packages/remote/src/composite/dag.ts` — implicit edge derivation pipeline → ragNode
- `packages/remote/src/composite/apply.ts` — dispatch the pipeline handler; destroy cleanup
- `packages/remote/src/rag/pipeline/schema.ts` — `ownership: CompositeOwnershipSchema.optional()` on `RagPipelineManifestSchema`
- `packages/remote/src/rag/pipeline/store.ts` — `applyPipeline` gains ownership-aware merge; `removePipeline` gains ref-counted variant
- `packages/remote/src/router.ts` — `ragPipelineApply` input gains `ownership?`; `ragPipelineRemove` input gains `compositeName?`
- `docs/composites.md` — add "Composite-managed RAG pipelines" section

---

## Conventions

**Test runner.** `bun test --cwd packages/remote`. Hermetic on-disk paths via `LLAMACTL_TEST_PROFILE` / `DEV_STORAGE` (set in `beforeEach`); pipeline dirs land at `${DEV_STORAGE}/rag-pipelines/<name>/`.

**Real typecheck.** `bunx tsc -p packages/remote/tsconfig.json --noEmit`. Record the baseline at Task 1 step 8 — Task 9 step 4 must show **equal** count, not "fewer than before."

**Spec source of truth.** `docs/superpowers/specs/2026-04-26-pipelines-composite-bridge-design.md`. Decisions D1–D6 are locked. If a real implementation gap surfaces, surface it before improvising.

**Reuse, don't reinvent.** `CompositeOwnershipSchema` and `entrySpecHash` are already shipped in `packages/remote/src/workload/gateway-catalog/`. Import them; do not redefine.

**Conventional Commits.** One commit per task. No AI/co-author trailers.

**The proc is `ragPipelineRemove`, not `ragPipelineDelete`.** Use the actual name throughout.

---

## Task 1: Schema additions

**Files:**
- Modify: `packages/remote/src/composite/schema.ts`
- Modify: `packages/remote/src/rag/pipeline/schema.ts`
- Test: `packages/remote/test/composite-schema-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/composite-schema-pipeline.test.ts
import { describe, expect, test } from 'bun:test';
import { CompositeSchema, CompositeSpecSchema, PipelineCompositeEntrySchema } from '../src/composite/schema';
import { RagPipelineManifestSchema } from '../src/rag/pipeline/schema';

describe('PipelineCompositeEntrySchema', () => {
  test('accepts a valid entry', () => {
    const out = PipelineCompositeEntrySchema.safeParse({
      name: 'docs-ingest',
      spec: {
        destination: { ragNode: 'kb-chroma', collection: 'docs' },
        sources: [{ kind: 'filesystem', path: '/tmp/docs' }],
      },
    });
    expect(out.success).toBe(true);
  });

  test('rejects uppercase or invalid name', () => {
    expect(
      PipelineCompositeEntrySchema.safeParse({
        name: 'DocsIngest',
        spec: { destination: { ragNode: 'kb', collection: 'd' }, sources: [{ kind: 'filesystem', path: '/x' }] },
      }).success,
    ).toBe(false);
  });
});

describe('CompositeSpecSchema with pipelines', () => {
  test('pipelines field defaults to []', () => {
    const out = CompositeSpecSchema.parse({});
    expect(out.pipelines).toEqual([]);
  });

  test('rejects duplicate pipeline names within a composite', () => {
    const result = CompositeSchema.safeParse({
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'mc' },
      spec: {
        pipelines: [
          { name: 'docs', spec: { destination: { ragNode: 'kb', collection: 'd' }, sources: [{ kind: 'filesystem', path: '/x' }] } },
          { name: 'docs', spec: { destination: { ragNode: 'kb', collection: 'd' }, sources: [{ kind: 'filesystem', path: '/x' }] } },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  test('allows the same name across different kinds (per-kind namespace)', () => {
    const result = CompositeSchema.safeParse({
      apiVersion: 'llamactl/v1',
      kind: 'Composite',
      metadata: { name: 'mc' },
      spec: {
        services: [{ name: 'docs', image: 'nginx' }],
        pipelines: [
          { name: 'docs', spec: { destination: { ragNode: 'kb', collection: 'd' }, sources: [{ kind: 'filesystem', path: '/x' }] } },
        ],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('RagPipelineManifestSchema with ownership', () => {
  test('round-trips ownership marker', () => {
    const out = RagPipelineManifestSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'RagPipeline',
      metadata: { name: 'docs' },
      spec: { destination: { ragNode: 'kb', collection: 'd' }, sources: [{ kind: 'filesystem', path: '/x' }] },
      ownership: {
        source: 'composite',
        compositeNames: ['mc'],
        specHash: 'abc',
      },
    });
    expect(out.ownership?.compositeNames).toEqual(['mc']);
  });

  test('parses operator manifest without ownership marker', () => {
    const out = RagPipelineManifestSchema.parse({
      apiVersion: 'llamactl/v1',
      kind: 'RagPipeline',
      metadata: { name: 'docs' },
      spec: { destination: { ragNode: 'kb', collection: 'd' }, sources: [{ kind: 'filesystem', path: '/x' }] },
    });
    expect(out.ownership).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/composite-schema-pipeline.test.ts`
Expected: FAIL — `PipelineCompositeEntrySchema` not exported; `pipelines:` not on CompositeSpecSchema; `ownership` field rejected on RagPipelineManifestSchema.

- [ ] **Step 3: Add `PipelineCompositeEntrySchema` to `composite/schema.ts`**

Open `packages/remote/src/composite/schema.ts`. Add the import for `RagPipelineSpecSchema` near the existing imports:

```ts
import { RagPipelineSpecSchema } from '../rag/pipeline/schema.js';
```

Near the existing `RagNodeCompositeEntrySchema` / `GatewayCompositeEntrySchema` definitions, add:

```ts
export const PipelineCompositeEntrySchema = z.object({
  name: z.string().min(1).regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'pipeline name must be lowercase-alphanumeric-hyphens',
  ),
  spec: RagPipelineSpecSchema,
});
export type PipelineCompositeEntry = z.infer<typeof PipelineCompositeEntrySchema>;
```

- [ ] **Step 4: Add `pipelines:` to `CompositeSpecSchema`**

In the same file, find the `CompositeSpecSchema` and add the new field:

```ts
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

- [ ] **Step 5: Update `collectComponentNames` and the unique-name `superRefine`**

In the `collectComponentNames` function, add a `pipeline` set:

```ts
function collectComponentNames(spec: CompositeSpec): {
  service: Set<string>;
  workload: Set<string>;
  rag: Set<string>;
  gateway: Set<string>;
  pipeline: Set<string>;  // NEW
} {
  return {
    service: new Set(spec.services.map((s) => s.name)),
    workload: new Set(spec.workloads.map((w) => w.node /* placeholder */)),
    rag: new Set(spec.ragNodes.map((r) => r.name)),
    gateway: new Set(spec.gateways.map((g) => g.name)),
    pipeline: new Set(spec.pipelines.map((p) => p.name)),  // NEW
  };
}
```

In the `superRefine` block (around the existing per-kind uniqueness checks), add:

```ts
const seen = {
  service: new Map<string, number>(),
  workload: new Map<string, number>(),
  rag: new Map<string, number>(),
  gateway: new Map<string, number>(),
  pipeline: new Map<string, number>(),  // NEW
} as const;
// ...existing per-kind seen.set loops...
for (const p of spec.pipelines) {  // NEW
  seen.pipeline.set(p.name, (seen.pipeline.get(p.name) ?? 0) + 1);
}
```

Then add the duplicate-name issue path in the same style as the existing per-kind blocks:

```ts
for (const [name, count] of seen.pipeline) {
  if (count > 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['spec', 'pipelines'],
      message: `duplicate pipeline name '${name}' (${count} times)`,
    });
  }
}
```

- [ ] **Step 6: Update `DependencyEdgeSchema` allowed `kind` enum**

In the same file (or wherever `DependencyEdgeSchema` is defined — search via `grep -n "DependencyEdgeSchema\|ComponentKind" packages/remote/src/composite/schema.ts`), find the kind enum and add `pipeline`:

```ts
// Before:  z.enum(['service', 'workload', 'rag', 'gateway'])
// After:
z.enum(['service', 'workload', 'rag', 'gateway', 'pipeline'])
```

- [ ] **Step 7: Add `ownership` to `RagPipelineManifestSchema`**

Open `packages/remote/src/rag/pipeline/schema.ts`. Add the import near the top:

```ts
import { CompositeOwnershipSchema } from '../../workload/gateway-catalog/schema.js';
```

Find `RagPipelineManifestSchema` (around line 146) and add the optional field:

```ts
export const RagPipelineManifestSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('RagPipeline'),
  metadata: z.object({ name: z.string().min(1) }),
  spec: RagPipelineSpecSchema,
  ownership: CompositeOwnershipSchema.optional(),  // NEW
});
```

- [ ] **Step 8: Real typecheck — record baseline**

Run: `bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | wc -l`
Record this number. It is the baseline; subsequent tasks must keep equal counts.

- [ ] **Step 9: Run, verify pass**

Run: `bun test --cwd packages/remote test/composite-schema-pipeline.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 10: Run full remote suite — no regressions**

Run: `bun test --cwd packages/remote 2>&1 | tail -5`
Expected: all tests pass. (If a composite test fails because it reads `collectComponentNames` output and didn't expect `pipeline:` key, update its assertion to include the new key.)

- [ ] **Step 11: Commit**

```bash
git add packages/remote/src/composite/schema.ts \
        packages/remote/src/rag/pipeline/schema.ts \
        packages/remote/test/composite-schema-pipeline.test.ts
git commit -m "feat(remote/composite,rag/pipeline): schema additions for pipeline component

CompositeSpec gains pipelines: PipelineCompositeEntry[] (each entry is
{ name, spec: RagPipelineSpec }). RagPipelineManifest gains optional
ownership: CompositeOwnership (reused verbatim from gateway-catalog).
Per-kind name namespacing preserved — a pipeline named 'docs' and a
service named 'docs' coexist."
```

---

## Task 2: DAG implicit-edge inference for pipelines

**Files:**
- Modify: `packages/remote/src/composite/dag.ts`
- Test: `packages/remote/test/composite-dag-pipeline.test.ts`

- [ ] **Step 1: Read the existing implicit-edge derivation**

Run: `grep -n "upstreamWorkloads\|implicit\|inferEdges\|buildDag" packages/remote/src/composite/dag.ts | head -10`

Find where the existing gateway → upstream-workload edges are inferred. The new pipeline → ragNode edge mirrors that pattern verbatim.

- [ ] **Step 2: Write the failing test**

```ts
// packages/remote/test/composite-dag-pipeline.test.ts
import { describe, expect, test } from 'bun:test';
import { topoOrder, inferEdges } from '../src/composite/dag';
// (Adapt the import names to the actual exports — search:
//  grep -n "export.*function\|export.*const" packages/remote/src/composite/dag.ts)

const baseSpec = {
  services: [],
  workloads: [],
  ragNodes: [
    { name: 'kb-chroma', kind: 'rag' as const, rag: { provider: 'chroma' as const, endpoint: 'http://localhost:8000', collection: 'd' } },
  ],
  gateways: [],
  pipelines: [
    {
      name: 'docs-ingest',
      spec: {
        destination: { ragNode: 'kb-chroma', collection: 'docs' },
        sources: [{ kind: 'filesystem' as const, path: '/tmp/docs' }],
      },
    },
  ],
  dependencies: [],
  onFailure: 'rollback' as const,
};

describe('composite DAG — pipeline edges', () => {
  test('infers edge from pipeline.destination.ragNode to inline ragNodes[]', () => {
    const edges = inferEdges(baseSpec);
    const found = edges.some(
      (e) => e.from.kind === 'pipeline' && e.from.name === 'docs-ingest' &&
             e.to.kind === 'rag' && e.to.name === 'kb-chroma',
    );
    expect(found).toBe(true);
  });

  test('topo order places pipeline after its rag node', () => {
    const order = topoOrder(baseSpec);
    const ragIdx = order.findIndex((c) => c.kind === 'rag' && c.name === 'kb-chroma');
    const pipeIdx = order.findIndex((c) => c.kind === 'pipeline' && c.name === 'docs-ingest');
    expect(ragIdx).toBeLessThan(pipeIdx);
  });

  test('no edge when pipeline.destination.ragNode does not match any inline ragNode', () => {
    const spec = { ...baseSpec, pipelines: [{
      name: 'p',
      spec: {
        destination: { ragNode: 'external-kb', collection: 'd' },
        sources: [{ kind: 'filesystem' as const, path: '/x' }],
      },
    }] };
    const edges = inferEdges(spec);
    const fromPipeline = edges.filter((e) => e.from.kind === 'pipeline');
    expect(fromPipeline.length).toBe(0);
  });

  test('explicit dependencies edges with pipeline kind merge with inferred ones', () => {
    const spec = {
      ...baseSpec,
      services: [{ name: 'preflight', image: 'busybox' }],
      dependencies: [
        { from: { kind: 'pipeline' as const, name: 'docs-ingest' }, to: { kind: 'service' as const, name: 'preflight' } },
      ],
    };
    const edges = inferEdges(spec);
    const explicitFound = edges.some(
      (e) => e.from.kind === 'pipeline' && e.to.kind === 'service' && e.to.name === 'preflight',
    );
    const implicitFound = edges.some(
      (e) => e.from.kind === 'pipeline' && e.to.kind === 'rag' && e.to.name === 'kb-chroma',
    );
    expect(explicitFound).toBe(true);
    expect(implicitFound).toBe(true);
  });

  test('cycle detection picks up pipeline → service → pipeline cycle', () => {
    const spec = {
      ...baseSpec,
      services: [{ name: 'preflight', image: 'busybox' }],
      dependencies: [
        { from: { kind: 'pipeline' as const, name: 'docs-ingest' }, to: { kind: 'service' as const, name: 'preflight' } },
        { from: { kind: 'service' as const, name: 'preflight' }, to: { kind: 'pipeline' as const, name: 'docs-ingest' } },
      ],
    };
    expect(() => topoOrder(spec)).toThrow(/cycle/i);
  });
});
```

- [ ] **Step 3: Run, verify failure**

Run: `bun test --cwd packages/remote test/composite-dag-pipeline.test.ts`
Expected: FAIL — `inferEdges` doesn't yet emit pipeline → ragNode edges.

- [ ] **Step 4: Implement implicit-edge inference**

In `packages/remote/src/composite/dag.ts`, find the loop that emits gateway → upstream-workload edges (search via `grep -n "upstreamWorkloads" packages/remote/src/composite/dag.ts`). Add a parallel loop for pipelines:

```ts
// After the existing gateway → upstreamWorkloads loop:
const ragNodeNames = new Set(spec.ragNodes.map((r) => r.name));
for (const p of spec.pipelines) {
  const destRagNode = p.spec.destination.ragNode;
  if (ragNodeNames.has(destRagNode)) {
    edges.push({
      from: { kind: 'pipeline', name: p.name },
      to:   { kind: 'rag',      name: destRagNode },
    });
  }
}
```

If `inferEdges` and `topoOrder` are private to the file (not exported), add the necessary exports for the test:

```ts
export function inferEdges(spec: CompositeSpec): DependencyEdge[] {
  // existing logic...
}
export function topoOrder(spec: CompositeSpec): ComponentRef[] {
  // existing logic...
}
```

- [ ] **Step 5: Run, verify pass**

Run: `bun test --cwd packages/remote test/composite-dag-pipeline.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 6: Run full remote suite — no regressions**

Run: `bun test --cwd packages/remote 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 7: Real typecheck — count unchanged**

Run: `bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | wc -l`
Expected: equal to Task 1 step 8 baseline.

- [ ] **Step 8: Commit**

```bash
git add packages/remote/src/composite/dag.ts \
        packages/remote/test/composite-dag-pipeline.test.ts
git commit -m "feat(remote/composite/dag): infer implicit edge from pipeline.destination.ragNode to inline ragNodes"
```

---

## Task 3: `applyPipeline` ownership-aware merge logic

**Files:**
- Modify: `packages/remote/src/rag/pipeline/store.ts`
- Test: `packages/remote/test/pipeline-apply-ownership.test.ts`

The existing `applyPipeline(manifest, env?)` does a naive write. We change its signature to accept ownership and add the merge logic from the spec's data-flow section.

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/pipeline-apply-ownership.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPipeline, loadPipeline } from '../src/rag/pipeline/store';
import type { RagPipelineManifest } from '../src/rag/pipeline/schema';

const baseManifest: RagPipelineManifest = {
  apiVersion: 'llamactl/v1',
  kind: 'RagPipeline',
  metadata: { name: 'docs-ingest' },
  spec: {
    destination: { ragNode: 'kb', collection: 'd' },
    sources: [{ kind: 'filesystem', path: '/tmp/docs' }],
    transforms: [],
    concurrency: 4,
    on_duplicate: 'skip',
  },
};

describe('applyPipeline with ownership', () => {
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pipeline-apply-'));
    prev = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('brand-new write with ownership marker', () => {
    const r = applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(true);
    const stored = loadPipeline('docs-ingest');
    expect(stored?.ownership?.compositeNames).toEqual(['mc']);
  });

  test('idempotent re-apply — same composite, same shape', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    const r = applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });

  test('union compositeNames — same shape, different composite', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    const r = applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['other'], specHash: 'h1' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(true);
    const stored = loadPipeline('docs-ingest');
    expect(stored?.ownership?.compositeNames.sort()).toEqual(['mc', 'other']);
  });

  test('shape mismatch — same name, different specHash from another composite', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    const r = applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['other'], specHash: 'h2' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflict.kind).toBe('shape');
      expect(r.conflict.name).toBe('docs-ingest');
    }
  });

  test('composite trying to claim operator-owned pipeline → name collision', () => {
    applyPipeline(baseManifest);  // operator path, no ownership param
    const r = applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflict.kind).toBe('name');
      if (r.conflict.kind === 'name') expect(r.conflict.existingOwner).toBe('operator');
    }
  });

  test('operator trying to overwrite composite-managed pipeline → name collision', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h1' },
    });
    const r = applyPipeline(baseManifest);  // operator path, no ownership param
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflict.kind).toBe('name');
      if (r.conflict.kind === 'name') expect(r.conflict.existingOwner).toBe('composite');
    }
  });

  test('operator updating their own pipeline — no marker path unchanged', () => {
    applyPipeline(baseManifest);
    const next = { ...baseManifest, spec: { ...baseManifest.spec, concurrency: 8 } };
    const r = applyPipeline(next);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(true);
    const stored = loadPipeline('docs-ingest');
    expect(stored?.spec.concurrency).toBe(8);
    expect(stored?.ownership).toBeUndefined();
  });

  test('shape compared via entrySpecHash — semantically equal manifests no-op', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h-computed' },
    });
    // Re-apply with the same logical shape but a freshly-computed hash; the
    // applyPipeline body should compute its own hash and treat this as no-op.
    const r = applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'doesnt-matter' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/pipeline-apply-ownership.test.ts`
Expected: FAIL — `applyPipeline` doesn't yet accept `ownership` opts; old signature returns `{ path, created }`, not `ApplyResult`.

- [ ] **Step 3: Update `applyPipeline` signature + add ownership-aware logic**

Open `packages/remote/src/rag/pipeline/store.ts`. Add the imports near the top:

```ts
import { entrySpecHash } from '../../workload/gateway-catalog/hash.js';
import type { CompositeOwnership } from '../../workload/gateway-catalog/schema.js';
```

Add result types near the top of the file (after the imports, before `applyPipeline`):

```ts
export type ApplyConflict =
  | { kind: 'name'; name: string; existingOwner: 'operator' | 'composite' }
  | { kind: 'shape'; name: string; reason: string };

export type ApplyResult =
  | { ok: true; changed: boolean; path: string }
  | { ok: false; conflict: ApplyConflict };

export interface ApplyPipelineOpts {
  ownership?: CompositeOwnership;
  env?: NodeJS.ProcessEnv;
}
```

Replace the existing `applyPipeline` function body with:

```ts
export function applyPipeline(
  manifest: RagPipelineManifest,
  opts: ApplyPipelineOpts = {},
): ApplyResult {
  const env = opts.env ?? process.env;

  // Re-parse through the schema so we never persist an invalid manifest.
  const parsed = RagPipelineManifestSchema.parse(manifest);
  const newHash = entrySpecHash(parsed.spec);
  const cur = loadPipeline(parsed.metadata.name, env);

  // Brand-new write: just store + return.
  if (!cur) {
    const persisted: RagPipelineManifest = opts.ownership
      ? { ...parsed, ownership: { ...opts.ownership, specHash: newHash } }
      : parsed;
    const path = writeManifest(persisted, env);
    return { ok: true, changed: true, path };
  }

  // Existing entry has no ownership marker.
  if (!cur.ownership) {
    if (opts.ownership) {
      // Composite trying to claim an operator-owned pipeline.
      return {
        ok: false,
        conflict: { kind: 'name', name: parsed.metadata.name, existingOwner: 'operator' },
      };
    }
    // Operator updating their own pipeline.
    const curHash = entrySpecHash(cur.spec);
    const changed = curHash !== newHash;
    const path = writeManifest(parsed, env);
    return { ok: true, changed, path };
  }

  // Existing entry has ownership marker.
  if (!opts.ownership) {
    // Operator trying to overwrite composite-managed pipeline.
    return {
      ok: false,
      conflict: { kind: 'name', name: parsed.metadata.name, existingOwner: 'composite' },
    };
  }

  // Both have markers. Compare shape and union compositeNames.
  const claimingNames = opts.ownership.compositeNames;
  if (cur.ownership.specHash !== newHash) {
    return {
      ok: false,
      conflict: {
        kind: 'shape',
        name: parsed.metadata.name,
        reason: `existing specHash ${cur.ownership.specHash} != new ${newHash}`,
      },
    };
  }

  const allClaimingAlreadyOwn = claimingNames.every((n) =>
    cur.ownership!.compositeNames.includes(n),
  );
  if (allClaimingAlreadyOwn) {
    // Same shape, this composite already in the list → no-op.
    return { ok: true, changed: false, path: specPath(parsed.metadata.name, env) };
  }

  // Same shape, additional composite owner → union and write.
  const merged = Array.from(
    new Set([...cur.ownership.compositeNames, ...claimingNames]),
  ).sort();
  const persisted: RagPipelineManifest = {
    ...parsed,
    ownership: { source: 'composite', compositeNames: merged, specHash: newHash },
  };
  const path = writeManifest(persisted, env);
  return { ok: true, changed: true, path };
}

function writeManifest(manifest: RagPipelineManifest, env: NodeJS.ProcessEnv): string {
  const dir = pipelineDir(manifest.metadata.name, env);
  const path = specPath(manifest.metadata.name, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, stringifyYaml(manifest), 'utf8');
  return path;
}
```

(If `pipelineDir`, `specPath`, or `mkdirSync` aren't already imported in this file, add them — they're already used in the existing `applyPipeline` body so the imports should be there.)

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/pipeline-apply-ownership.test.ts`
Expected: PASS — 8 tests pass.

- [ ] **Step 5: Update existing callers of `applyPipeline`**

`applyPipeline`'s old return shape was `{ path, created }`. The new return shape is `ApplyResult` (a discriminated union). Find every existing caller:

```bash
grep -rn "applyPipeline(" packages/remote/src/ packages/cli/src/ --include="*.ts"
```

For each call site (most likely the `ragPipelineApply` proc and any project-indexing path that delegates to it):
- Old: `const { path, created } = applyPipeline(parsed.data);`
- New: `const result = applyPipeline(parsed.data); if (!result.ok) throw new TRPCError({ code: 'CONFLICT', message: ... }); const { path, changed } = result;`

(The `ragPipelineApply` proc adapter is Task 5; for this task, just unblock the typecheck on existing callers by mapping old-shape destructuring to the new shape with a thin wrapper or inline change.)

- [ ] **Step 6: Run full remote suite — no regressions**

Run: `bun test --cwd packages/remote 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 7: Real typecheck — count unchanged**

Run: `bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | wc -l`
Expected: equal to Task 1 step 8 baseline.

- [ ] **Step 8: Commit**

```bash
git add packages/remote/src/rag/pipeline/store.ts \
        packages/remote/src/router.ts \
        packages/remote/test/pipeline-apply-ownership.test.ts
git commit -m "feat(remote/rag/pipeline): applyPipeline gains ownership-aware merge logic

applyPipeline returns ApplyResult (ok+changed | conflict). Operator
path (no ownership param) preserved unchanged; composite path adds
the marker on disk and enforces:
  - operator-owned + composite claim → name conflict (operator)
  - composite-owned + operator overwrite → name conflict (composite)
  - same composite + same specHash → no-op
  - different composite + same specHash → union compositeNames
  - any composite + different specHash → shape conflict

specHash is recomputed inside applyPipeline via entrySpecHash so
callers can pass a placeholder; the ground truth is derived from the
manifest spec."
```

---

## Task 4: `removePipeline` ref-counted variant

**Files:**
- Modify: `packages/remote/src/rag/pipeline/store.ts`
- Test: `packages/remote/test/pipeline-remove-refcounted.test.ts`

`removePipeline(name, env?): boolean` exists today (deletes the pipeline directory). Add an optional `compositeName` parameter that triggers ref-counted removal.

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/pipeline-remove-refcounted.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPipeline, loadPipeline, removePipeline } from '../src/rag/pipeline/store';
import type { RagPipelineManifest } from '../src/rag/pipeline/schema';

const baseManifest: RagPipelineManifest = {
  apiVersion: 'llamactl/v1',
  kind: 'RagPipeline',
  metadata: { name: 'docs-ingest' },
  spec: {
    destination: { ragNode: 'kb', collection: 'd' },
    sources: [{ kind: 'filesystem', path: '/tmp/docs' }],
    transforms: [],
    concurrency: 4,
    on_duplicate: 'skip',
  },
};

describe('removePipeline ref-counted', () => {
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pipeline-rm-'));
    prev = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('single-owner: composite removal deletes the pipeline', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h' },
    });
    const r = removePipeline('docs-ingest', { compositeName: 'mc' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deleted).toBe(true);
    expect(loadPipeline('docs-ingest')).toBeNull();
  });

  test('multi-owner: removal of one composite strips its name; entry stays', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h' },
    });
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['other'], specHash: 'h' },
    });
    const r = removePipeline('docs-ingest', { compositeName: 'mc' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deleted).toBe(false);
    const stored = loadPipeline('docs-ingest');
    expect(stored?.ownership?.compositeNames).toEqual(['other']);
  });

  test('operator-owned protected from composite-driven removal', () => {
    applyPipeline(baseManifest);  // operator path
    const r = removePipeline('docs-ingest', { compositeName: 'mc' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflict.kind).toBe('name');
      if (r.conflict.kind === 'name') expect(r.conflict.existingOwner).toBe('operator');
    }
    expect(loadPipeline('docs-ingest')).not.toBeNull();
  });

  test('no-op when name not present', () => {
    const r = removePipeline('does-not-exist', { compositeName: 'mc' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deleted).toBe(false);
  });

  test('operator path preserved: removePipeline(name) deletes regardless of owner', () => {
    applyPipeline(baseManifest, {
      ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h' },
    });
    const ok = removePipeline('docs-ingest');  // legacy operator-side delete
    expect(ok).toBe(true);
    expect(loadPipeline('docs-ingest')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/pipeline-remove-refcounted.test.ts`
Expected: FAIL — `removePipeline` doesn't accept the new options shape; legacy path returns `boolean` not `RemoveResult`.

- [ ] **Step 3: Add the ref-counted variant**

In `packages/remote/src/rag/pipeline/store.ts`, change the existing `removePipeline` from a single-shape function to an overloaded one:

```ts
export type RemoveConflict =
  | { kind: 'name'; name: string; existingOwner: 'operator' };

export type RemoveResult =
  | { ok: true; deleted: boolean }
  | { ok: false; conflict: RemoveConflict };

export interface RemovePipelineOpts {
  compositeName?: string;
  env?: NodeJS.ProcessEnv;
}

// Legacy operator-side overload — preserved for backwards compatibility.
export function removePipeline(name: string, env?: NodeJS.ProcessEnv): boolean;
// Composite-aware overload — ref-counted strip-and-delete.
export function removePipeline(name: string, opts: RemovePipelineOpts): RemoveResult;
export function removePipeline(
  name: string,
  envOrOpts?: NodeJS.ProcessEnv | RemovePipelineOpts,
): boolean | RemoveResult {
  // Distinguish the two overloads. Legacy callers pass the env directly
  // (or nothing); composite callers pass an object with compositeName.
  const isOptsObject =
    typeof envOrOpts === 'object' &&
    envOrOpts !== null &&
    ('compositeName' in envOrOpts || 'env' in envOrOpts);

  if (!isOptsObject) {
    // Legacy operator-side path — unchanged behavior.
    const env = (envOrOpts as NodeJS.ProcessEnv | undefined) ?? process.env;
    const dir = pipelineDir(name, env);
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // Composite-aware path.
  const opts = envOrOpts as RemovePipelineOpts;
  const env = opts.env ?? process.env;
  const cur = loadPipeline(name, env);
  if (!cur) return { ok: true, deleted: false };

  if (!cur.ownership) {
    // Operator-owned — refuse composite-driven removal.
    return {
      ok: false,
      conflict: { kind: 'name', name, existingOwner: 'operator' },
    };
  }

  if (!opts.compositeName) {
    // Composite path called without a compositeName — bug; no-op.
    return { ok: true, deleted: false };
  }

  const remaining = cur.ownership.compositeNames.filter((n) => n !== opts.compositeName);
  if (remaining.length === 0) {
    // Last owner removed — delete the pipeline.
    const dir = pipelineDir(name, env);
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, deleted: true };
  }

  // Strip the compositeName, keep the entry.
  const persisted: RagPipelineManifest = {
    ...cur,
    ownership: { ...cur.ownership, compositeNames: remaining },
  };
  const path = specPath(name, env);
  writeFileSync(path, stringifyYaml(persisted), 'utf8');
  return { ok: true, deleted: false };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/pipeline-remove-refcounted.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Run full remote suite — no regressions**

Run: `bun test --cwd packages/remote 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 6: Real typecheck — count unchanged**

Run: `bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | wc -l`
Expected: equal to Task 1 step 8 baseline.

- [ ] **Step 7: Commit**

```bash
git add packages/remote/src/rag/pipeline/store.ts \
        packages/remote/test/pipeline-remove-refcounted.test.ts
git commit -m "feat(remote/rag/pipeline): removePipeline gains ref-counted composite-aware overload

Operator-side legacy signature preserved (returns boolean). New
composite-aware overload accepts { compositeName } and:
  - operator-owned → refuses composite-driven removal (name conflict)
  - composite-owned + name in list → strips name; deletes only when
    list empties
  - missing name → no-op { ok: true, deleted: false }"
```

---

## Task 5: `ragPipelineApply` + `ragPipelineRemove` proc augmentation

**Files:**
- Modify: `packages/remote/src/router.ts`

The procs gain optional ownership-related fields and thread them into `applyPipeline` / `removePipeline`. Existing operator CLI/UI callers that don't pass the new fields are unchanged.

- [ ] **Step 1: Update `ragPipelineApply` proc input**

In `packages/remote/src/router.ts`, find the `ragPipelineApply` proc (near line 2554). Replace its input + body with:

```ts
ragPipelineApply: t.procedure
  .input(
    z.object({
      manifestYaml: z.string().min(1),
      ownership: z.lazy(() =>
        // import lazily to avoid pulling the gateway-catalog schema into
        // the router's hot import path
        require('./workload/gateway-catalog/schema.js').CompositeOwnershipSchema,
      ).optional(),
    }),
  )
  .mutation(async ({ input }) => {
    const { parse: parseYaml } = await import('yaml');
    const { RagPipelineManifestSchema } = await import('./rag/pipeline/index.js');
    const { applyPipeline } = await import('./rag/pipeline/store.js');
    let parsedYaml: unknown;
    try {
      parsedYaml = parseYaml(input.manifestYaml);
    } catch (err) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `RagPipeline manifest is not valid YAML: ${(err as Error).message}`,
      });
    }
    const parsed = RagPipelineManifestSchema.safeParse(parsedYaml);
    if (!parsed.success) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `invalid RagPipeline manifest: ${JSON.stringify(parsed.error.issues)}`,
      });
    }
    const result = applyPipeline(parsed.data, {
      ...(input.ownership ? { ownership: input.ownership } : {}),
    });
    if (!result.ok) {
      // Surface conflicts as structured BAD_REQUEST so tRPC clients can
      // act on conflict.kind. Composite handler interprets this and
      // translates to Pending status; operator CLI treats as error.
      return {
        ok: false as const,
        conflict: result.conflict,
        name: parsed.data.metadata.name,
      };
    }
    return {
      ok: true as const,
      name: parsed.data.metadata.name,
      path: result.path,
      changed: result.changed,
    };
  }),
```

(The `z.lazy(() => require(...))` pattern is awkward; if the file already imports `CompositeOwnershipSchema` for other reasons, just use the named import directly. Otherwise add it to the existing import block at the top of `router.ts`:

```ts
import { CompositeOwnershipSchema } from './workload/gateway-catalog/schema.js';
```

and write the proc input as:

```ts
.input(z.object({
  manifestYaml: z.string().min(1),
  ownership: CompositeOwnershipSchema.optional(),
}))
```

That's cleaner. Do this if the import doesn't introduce a cycle.)

- [ ] **Step 2: Update `ragPipelineRemove` proc input**

Find `ragPipelineRemove` (near line 2667). Replace with:

```ts
ragPipelineRemove: t.procedure
  .input(
    z.object({
      name: z.string().min(1),
      compositeName: z.string().optional(),
    }),
  )
  .mutation(async ({ input }) => {
    const { removePipeline } = await import('./rag/pipeline/store.js');
    if (input.compositeName) {
      const r = removePipeline(input.name, { compositeName: input.compositeName });
      if (!r.ok) {
        return {
          ok: false as const,
          conflict: r.conflict,
        };
      }
      return { ok: true as const, deleted: r.deleted };
    }
    // Legacy operator path — boolean return.
    const removed = removePipeline(input.name);
    return { ok: true as const, removed };
  }),
```

- [ ] **Step 3: Run full remote suite — no regressions**

Run: `bun test --cwd packages/remote 2>&1 | tail -5`
Expected: all tests pass. Existing operator-side tests for `ragPipelineApply` and `ragPipelineRemove` should still work because they don't pass the new fields.

- [ ] **Step 4: Real typecheck — count unchanged**

Run: `bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | wc -l`
Expected: equal to Task 1 step 8 baseline.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/router.ts
git commit -m "feat(remote/router): ragPipelineApply gains ownership; ragPipelineRemove gains compositeName

Both procs preserve their existing operator-side input shape and
behavior. Composite-aware paths:
  - ragPipelineApply: ownership? threads through to applyPipeline
  - ragPipelineRemove: compositeName? routes to ref-counted removal

Conflicts surface in the response body as { ok: false, conflict }
rather than throwing — composite handler translates to Pending."
```

---

## Task 6: Composite pipeline handler

**Files:**
- Create: `packages/remote/src/composite/handlers/pipeline.ts`

The handler is what the composite applier calls for each `pipelines:[]` entry. It builds the manifest, computes the spec hash, calls `ragPipelineApply` via the in-process caller, translates conflicts to `Pending`, and fires-and-forgets the first run.

- [ ] **Step 1: Read the existing handler shape**

Run: `ls packages/remote/src/composite/handlers/ 2>/dev/null && grep -rn "export\|function apply" packages/remote/src/composite/handlers/ 2>/dev/null | head -20`

If `composite/handlers/` doesn't exist as a directory yet (the existing per-kind logic might be inline in `apply.ts`), look at how the existing service/workload/ragNode/gateway components are dispatched:

```bash
grep -n "kind === 'service'\|kind === 'rag'\|switch.*kind\|case 'workload'\|services?\.forEach\|gatewayHandler" packages/remote/src/composite/apply.ts | head -20
```

Adapt the new pipeline handler to whatever pattern the existing dispatch uses. The handler interface below assumes a per-kind handler file — if `composite/apply.ts` does it inline, the pipeline-handler logic goes inline there too (Task 7 will integrate).

- [ ] **Step 2: Implement the handler**

```ts
// packages/remote/src/composite/handlers/pipeline.ts
import { stringify as stringifyYaml } from 'yaml';
import { entrySpecHash } from '../../workload/gateway-catalog/hash.js';
import type { PipelineCompositeEntry } from '../schema.js';
import type { CompositeStatusComponent } from '../schema.js';

export interface PipelineHandlerCtx {
  /** The composite's metadata.name — used as the ownership.compositeNames entry. */
  compositeName: string;
  /** In-process tRPC caller. Composite applier creates this once per apply. */
  caller: {
    ragPipelineApply: (input: {
      manifestYaml: string;
      ownership?: { source: 'composite'; compositeNames: string[]; specHash: string };
    }) => Promise<
      | { ok: true; name: string; path: string; changed: boolean }
      | { ok: false; conflict: { kind: 'name' | 'shape'; name: string; existingOwner?: 'operator' | 'composite'; reason?: string } }
    >;
    ragPipelineRun: (input: { name: string; dryRun?: boolean }) => Promise<unknown>;
  };
  /** Optional logger for fire-and-forget first-run errors. Default: silent. */
  onFirstRunError?: (err: Error, name: string) => void;
}

export interface PipelineHandlerResult {
  status: CompositeStatusComponent;
  /** Whether applyPipeline reported the spec changed on disk this call. */
  changed: boolean;
}

/**
 * Apply a single pipeline component. Builds the RagPipeline manifest from
 * the entry, computes specHash, calls ragPipelineApply via the in-process
 * caller, and on success fires-and-forgets ragPipelineRun (first-run
 * trigger per spec D3).
 *
 * Conflicts ('name' / 'shape') translate to Pending status with the
 * canonical reason names so operators see consistent messaging.
 */
export async function applyPipelineComponent(
  entry: PipelineCompositeEntry,
  ctx: PipelineHandlerCtx,
): Promise<PipelineHandlerResult> {
  const manifest = {
    apiVersion: 'llamactl/v1' as const,
    kind: 'RagPipeline' as const,
    metadata: { name: entry.name },
    spec: entry.spec,
  };
  const specHash = entrySpecHash(entry.spec);
  const manifestYaml = stringifyYaml(manifest);

  const result = await ctx.caller.ragPipelineApply({
    manifestYaml,
    ownership: {
      source: 'composite',
      compositeNames: [ctx.compositeName],
      specHash,
    },
  });

  if (!result.ok) {
    const reasonMap: Record<string, string> = {
      name: 'PipelineNameCollision',
      shape: 'PipelineShapeMismatch',
    };
    const reason = reasonMap[result.conflict.kind] ?? 'PipelineConflict';
    const detail =
      result.conflict.kind === 'name'
        ? `pipeline '${result.conflict.name}' already exists as ${result.conflict.existingOwner}-managed`
        : `pipeline '${result.conflict.name}' shape disagrees with prior composite (${result.conflict.reason ?? 'specHash mismatch'})`;
    return {
      changed: false,
      status: {
        ref: { kind: 'pipeline', name: entry.name },
        state: 'Pending',
        message: `${reason}: ${detail}`,
      },
    };
  }

  if (result.changed) {
    // Fire-and-forget first run. Errors surface in the pipeline journal,
    // not in this handler — composite reaches Ready as soon as
    // registration succeeded.
    void ctx.caller.ragPipelineRun({ name: entry.name }).catch((err) => {
      ctx.onFirstRunError?.(err as Error, entry.name);
    });
  }

  return {
    changed: result.changed,
    status: {
      ref: { kind: 'pipeline', name: entry.name },
      state: 'Ready',
    },
  };
}

/**
 * Tear-down for a single pipeline component owned by `compositeName`.
 * Calls removePipeline via the in-process caller with ref-counting.
 */
export async function removePipelineComponent(
  entry: PipelineCompositeEntry,
  ctx: {
    compositeName: string;
    caller: {
      ragPipelineRemove: (input: { name: string; compositeName?: string }) => Promise<
        | { ok: true; deleted?: boolean; removed?: boolean }
        | { ok: false; conflict: { kind: 'name'; name: string; existingOwner: 'operator' } }
      >;
    };
  },
): Promise<{ deleted: boolean }> {
  const result = await ctx.caller.ragPipelineRemove({
    name: entry.name,
    compositeName: ctx.compositeName,
  });
  if (!result.ok) {
    // Operator-owned pipeline that was never composite-managed; nothing
    // for us to clean up. Best-effort destroy.
    return { deleted: false };
  }
  return { deleted: result.deleted ?? false };
}
```

- [ ] **Step 3: Real typecheck — count unchanged**

Run: `bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | wc -l`
Expected: equal to Task 1 step 8 baseline.

- [ ] **Step 4: Run full remote suite — no regressions**

Run: `bun test --cwd packages/remote 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/composite/handlers/pipeline.ts
git commit -m "feat(remote/composite/handlers): add pipeline handler

applyPipelineComponent builds the RagPipeline manifest from a composite
entry, calls ragPipelineApply via the in-process caller with ownership
marker, translates name/shape conflicts to canonical Pending reasons
(PipelineNameCollision, PipelineShapeMismatch), and fires the first
ingest run async on apply success. removePipelineComponent does the
ref-counted destroy via ragPipelineRemove."
```

---

## Task 7: Wire pipeline handler into composite/apply.ts

**Files:**
- Modify: `packages/remote/src/composite/apply.ts`
- Test: `packages/remote/test/composite-pipeline-apply.test.ts`
- Test: `packages/remote/test/composite-pipeline-destroy.test.ts`

The composite applier dispatches to the new handler for the `pipeline` kind, both on apply and on destroy. Most of the integration is wiring; the handler does the work.

- [ ] **Step 1: Read the existing apply dispatch**

```bash
grep -n "kind\|switch\|case.*'rag'\|case.*'gateway'\|gatewayHandler\|runRagNode\|applyService" packages/remote/src/composite/apply.ts | head -20
```

Find the per-component dispatch. There are typically two paths — apply-time iteration over topo order, and destroy-time iteration in reverse. Both need a `pipeline` case.

- [ ] **Step 2: Write the failing apply test**

```ts
// packages/remote/test/composite-pipeline-apply.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyComposite } from '../src/composite/apply';
import { loadPipeline } from '../src/rag/pipeline/store';

describe('composite apply with pipelines', () => {
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'composite-pipeline-'));
    prev = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('a composite with one pipeline applies and registers it with ownership', async () => {
    const manifest = {
      apiVersion: 'llamactl/v1' as const,
      kind: 'Composite' as const,
      metadata: { name: 'mc' },
      spec: {
        pipelines: [{
          name: 'docs-ingest',
          spec: {
            destination: { ragNode: 'kb', collection: 'd' },
            sources: [{ kind: 'filesystem' as const, path: '/tmp/docs' }],
            transforms: [],
            concurrency: 4,
            on_duplicate: 'skip' as const,
          },
        }],
      },
    };
    const status = await applyComposite(manifest);
    const pipelineComp = status.components.find((c) => c.ref.kind === 'pipeline');
    expect(pipelineComp?.state).toBe('Ready');
    const stored = loadPipeline('docs-ingest');
    expect(stored?.ownership?.compositeNames).toEqual(['mc']);
  });

  test('idempotent re-apply: second apply produces no new write', async () => {
    const manifest = {
      apiVersion: 'llamactl/v1' as const,
      kind: 'Composite' as const,
      metadata: { name: 'mc' },
      spec: {
        pipelines: [{
          name: 'docs-ingest',
          spec: {
            destination: { ragNode: 'kb', collection: 'd' },
            sources: [{ kind: 'filesystem' as const, path: '/tmp/docs' }],
            transforms: [],
            concurrency: 4,
            on_duplicate: 'skip' as const,
          },
        }],
      },
    };
    await applyComposite(manifest);
    const before = loadPipeline('docs-ingest');
    await applyComposite(manifest);
    const after = loadPipeline('docs-ingest');
    expect(after).toEqual(before);
  });

  test('shape conflict between two composites surfaces as Pending', async () => {
    const baseSpec = {
      destination: { ragNode: 'kb', collection: 'd' },
      sources: [{ kind: 'filesystem' as const, path: '/tmp/docs' }],
      transforms: [],
      concurrency: 4,
      on_duplicate: 'skip' as const,
    };
    await applyComposite({
      apiVersion: 'llamactl/v1', kind: 'Composite',
      metadata: { name: 'mc-a' },
      spec: { pipelines: [{ name: 'docs-ingest', spec: baseSpec }] },
    });
    const status = await applyComposite({
      apiVersion: 'llamactl/v1', kind: 'Composite',
      metadata: { name: 'mc-b' },
      spec: { pipelines: [{ name: 'docs-ingest', spec: { ...baseSpec, concurrency: 8 } }] },
    });
    const comp = status.components.find((c) => c.ref.kind === 'pipeline');
    expect(comp?.state).toBe('Pending');
    expect(comp?.message).toContain('PipelineShapeMismatch');
  });
});
```

- [ ] **Step 3: Run, verify failure**

Run: `bun test --cwd packages/remote test/composite-pipeline-apply.test.ts`
Expected: FAIL — composite applier doesn't yet route the `pipeline` kind.

- [ ] **Step 4: Wire the apply dispatch**

In `packages/remote/src/composite/apply.ts`, find the per-component apply loop (the one that iterates topo-sorted components and dispatches to a per-kind handler). Add the `pipeline` case:

```ts
import { applyPipelineComponent } from './handlers/pipeline.js';
import { router } from '../router.js';   // for the in-proc caller

// Inside the per-component dispatch (the existing switch / if-chain over `ref.kind`):
case 'pipeline': {
  // Resolve the entry by name from spec.pipelines[].
  const entry = spec.pipelines.find((p) => p.name === ref.name);
  if (!entry) {
    statusComponents.push({
      ref,
      state: 'Failed',
      message: `internal: pipeline entry '${ref.name}' not found in spec`,
    });
    break;
  }
  const caller = router.createCaller({}) as unknown as {
    ragPipelineApply: typeof router._def.procedures.ragPipelineApply;
    ragPipelineRun: typeof router._def.procedures.ragPipelineRun;
  };
  // The cast above is awkward; use the established createCaller pattern
  // already in this file (search for `router.createCaller({})` — there's
  // a precedent that handles it cleanly).
  const result = await applyPipelineComponent(entry, {
    compositeName: manifest.metadata.name,
    caller: caller as any,  // see precedent for the type cast pattern
  });
  statusComponents.push(result.status);
  if (result.status.state === 'Pending' && spec.onFailure === 'rollback') {
    // Halt + rollback; existing path handles this.
  }
  break;
}
```

(Adapt the cast and the dispatch shape to match the surrounding code style. The existing `gatewayHandler` integration is the closest precedent; mirror it.)

- [ ] **Step 5: Wire the destroy dispatch**

In the same file, find the destroy loop (reverse topo order). Add the `pipeline` case:

```ts
import { removePipelineComponent } from './handlers/pipeline.js';

// Inside the destroy per-component loop:
case 'pipeline': {
  const entry = spec.pipelines.find((p) => p.name === ref.name);
  if (!entry) break;
  const caller = router.createCaller({}) as any;
  await removePipelineComponent(entry, {
    compositeName: manifest.metadata.name,
    caller,
  });
  break;
}
```

- [ ] **Step 6: Run, verify pass**

Run: `bun test --cwd packages/remote test/composite-pipeline-apply.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 7: Write the destroy failing test**

```ts
// packages/remote/test/composite-pipeline-destroy.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyComposite, destroyComposite } from '../src/composite/apply';
import { loadPipeline } from '../src/rag/pipeline/store';

const baseManifest = (name: string) => ({
  apiVersion: 'llamactl/v1' as const,
  kind: 'Composite' as const,
  metadata: { name },
  spec: {
    pipelines: [{
      name: 'docs-ingest',
      spec: {
        destination: { ragNode: 'kb', collection: 'd' },
        sources: [{ kind: 'filesystem' as const, path: '/tmp/docs' }],
        transforms: [],
        concurrency: 4,
        on_duplicate: 'skip' as const,
      },
    }],
  },
});

describe('compositeDestroy with pipelines', () => {
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'composite-destroy-pipeline-'));
    prev = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('single-owner: destroying the composite deletes the pipeline', async () => {
    await applyComposite(baseManifest('mc'));
    await destroyComposite('mc');
    expect(loadPipeline('docs-ingest')).toBeNull();
  });

  test('co-owned: destroying one composite leaves the pipeline; destroying both removes it', async () => {
    await applyComposite(baseManifest('mc-a'));
    await applyComposite(baseManifest('mc-b'));
    await destroyComposite('mc-a');
    let stored = loadPipeline('docs-ingest');
    expect(stored?.ownership?.compositeNames).toEqual(['mc-b']);

    await destroyComposite('mc-b');
    stored = loadPipeline('docs-ingest');
    expect(stored).toBeNull();
  });
});
```

- [ ] **Step 8: Run, verify pass**

Run: `bun test --cwd packages/remote test/composite-pipeline-destroy.test.ts`
Expected: PASS — 2 tests pass.

- [ ] **Step 9: Run full remote suite — no regressions**

Run: `bun test --cwd packages/remote 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 10: Real typecheck — count unchanged**

Run: `bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | wc -l`
Expected: equal to Task 1 step 8 baseline.

- [ ] **Step 11: Commit**

```bash
git add packages/remote/src/composite/apply.ts \
        packages/remote/test/composite-pipeline-apply.test.ts \
        packages/remote/test/composite-pipeline-destroy.test.ts
git commit -m "feat(remote/composite/apply): dispatch pipeline kind on apply + destroy

Apply path resolves the pipeline entry from spec.pipelines, calls
applyPipelineComponent with the in-process caller, and pushes a
status component with the result. Destroy path calls
removePipelineComponent in reverse topo order. Idempotent re-apply
produces no disk change; shape conflicts surface as Pending."
```

---

## Task 8: Docs + cross-repo regression sweep + tag

**Files:**
- Modify: `docs/composites.md`

- [ ] **Step 1: Add the "Composite-managed RAG pipelines" section to docs**

Find the existing structure in `docs/composites.md` (probably has sections for services, workloads, ragNodes, gateways). Add a parallel section near the end:

```markdown
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
        sources: [{ kind: filesystem, path: /Users/me/docs }]
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
```

- [ ] **Step 2: Cross-repo regression sweep**

```bash
cd /Volumes/WorkSSD/repos/personal/llamactl       && bun test 2>&1 | tail -3
cd /Volumes/WorkSSD/repos/personal/sirius-gateway && bun test 2>&1 | tail -3
cd /Volumes/WorkSSD/repos/personal/embersynth     && bun test 2>&1 | tail -3
cd /Volumes/WorkSSD/repos/personal/nova           && bun test 2>&1 | tail -3
```

Expected: llamactl rises with the new tests (~25 added); sirius/embersynth/nova counts unchanged.

- [ ] **Step 3: Real typecheck — count equal to Task 1 baseline**

Run: `bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | wc -l`
Expected: equal to Task 1 step 8 baseline.

- [ ] **Step 4: Tag**

```bash
git add docs/composites.md
git commit -m "docs(composites): add composite-managed RAG pipelines section"
git tag composite-pipelines-bridge
```

- [ ] **Step 5: Hand off**

Open a PR titled `feat(remote): pipelines→composite bridge` against `main`. Body lists the spec link, summary of changes, the conflict reasons, the implicit topo edge, and the reused gateway-catalog ownership pattern. Reviewer steps: full remote suite, typecheck, then a manual end-to-end with one composite declaring an inline `ragNodes` + an inline `pipelines` ingesting a small fixture dir.

---

## Self-review checklist

**Spec coverage:**
- D1 (inline `RagPipelineSpec` minus metadata) → Task 1 (`PipelineCompositeEntrySchema = { name, spec: RagPipelineSpecSchema }`)
- D2 (implicit topo edge from pipeline.destination.ragNode → inline ragNodes) → Task 2 (`composite/dag.ts` + tests)
- D3 (fire-and-forget async first-run) → Task 6 (`applyPipelineComponent` calls `ragPipelineRun` async on `result.changed`)
- D4 (ownership marker, reference-counted) → Task 1 (schema), Task 3 (apply ownership-aware merge), Task 4 (remove ref-counted), Task 6 (handler propagates)
- D5 (composite applier delegates to `ragPipelineApply`) → Task 5 (proc augmentation), Task 6 (handler uses in-process caller), Task 7 (apply.ts dispatch wires the in-proc caller)
- D6 (apply order tier with implicit edges) → Task 2 (DAG inference produces the order)
- Conflict reasons (`PipelineNameCollision`, `PipelineShapeMismatch`) → Task 6 (handler maps `result.conflict.kind` to reason names)
- Ref-counted destroy → Task 4 + Task 7 destroy dispatch
- Idempotent re-apply via specHash → Task 3 + Task 7 (composite-apply test verifies)
- Reused `CompositeOwnershipSchema` from gateway-catalog → Task 1 imports verbatim
- Reused `entrySpecHash` from gateway-catalog → Task 3 + Task 6 import verbatim

**Placeholder scan:** Tasks 6 (handler types for the in-proc caller) and 7 (dispatch integration into the existing switch/if-chain) include explicit `grep` commands so the engineer can match the existing dispatch shape rather than guess. The `as any` cast in Task 7 step 4 is annotated with "see precedent for the type cast pattern" — the codebase has the precedent already (`router.createCaller({})` is used in multiple call sites in `router.ts`); the engineer should mirror the surrounding style. No "implement later" or "TBD" anywhere.

**Type consistency:** `PipelineCompositeEntry`, `ApplyConflict`, `ApplyResult`, `ApplyPipelineOpts`, `RemoveConflict`, `RemoveResult`, `RemovePipelineOpts`, `PipelineHandlerCtx`, `PipelineHandlerResult` are defined in Tasks 1, 3, 4, 6 — referenced unchanged in Tasks 5, 7, 8. Conflict reason names (`PipelineNameCollision`, `PipelineShapeMismatch`) spelled identically in Task 6 and Task 8 docs. The `kind: 'pipeline'` discriminator is consistent across schema, DAG, handler, dispatch, destroy, and tests.
