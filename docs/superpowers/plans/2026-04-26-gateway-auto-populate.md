# Gateway Catalog Auto-Populate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sirius and embersynth gateway handlers auto-populate `sirius-providers.yaml` / `embersynth.yaml` from `CompositeGatewayContext.upstreams` so operators stop hand-editing those files before applying composites; composite-managed entries carry an ownership marker, are reference-counted across composites, and disappear when the last owning composite is destroyed.

**Architecture:** New pure module `packages/remote/src/workload/gateway-catalog/` owns derivation, hash-based idempotency, conflict-aware merge, and reference-counted removal. Handlers call into it; the composite destroy path also calls into it. The single side-effecting boundary is `gateway-catalog/io.ts`. Sibling repos (sirius, embersynth) re-read on existing reload endpoints; no code there.

**Tech Stack:** TypeScript, Zod, Bun test, the existing `loadSiriusProviders` / `saveSiriusProviders` / `loadEmbersynthConfig` / `saveEmbersynthConfig` helpers, `crypto.createHash` for spec hashing.

**Spec:** `docs/superpowers/specs/2026-04-26-gateway-auto-populate-design.md`

---

## File Structure

### Server (`packages/remote/src/`)

**Created (`workload/gateway-catalog/`):**
- `schema.ts` — `CompositeOwnership` Zod, `DerivedSiriusEntry`, `DerivedEmbersynthEntry`, `ApplyResult`, `RemoveResult`, `ApplyConflict` types
- `sirius-entries.ts` — `deriveSiriusEntries(ctx)`
- `embersynth-entries.ts` — `deriveEmbersynthEntries(ctx)` (nodes only — no syntheticModels per spec D)
- `hash.ts` — `entrySpecHash(entry)`
- `apply.ts` — `applyCompositeEntries({...})`
- `remove.ts` — `removeCompositeEntries({...})`
- `io.ts` — `readGatewayCatalog(kind)`, `writeGatewayCatalog(kind, yaml)`
- `index.ts` — public re-exports

**Modified:**
- `config/sirius-providers.ts` — `SiriusProviderSchema` gains optional `ownership?: CompositeOwnership`
- `config/embersynth.ts` — `EmbersynthNodeSchema` gains optional `ownership?: CompositeOwnership`
- `composite/schema.ts` — typed `ProviderConfigCommon`; replace opaque `Record<string, unknown>` on the gateway entry's `providerConfig`
- `workload/gateway-handlers/types.ts` — `CompositeGatewayContext.providerConfig` becomes `ProviderConfigCommon`
- `workload/gateway-handlers/sirius.ts` — apply gains catalog-mutate prelude when `opts.composite` is set
- `workload/gateway-handlers/embersynth.ts` — symmetric
- `composite/apply.ts` — `destroyComposite` calls `removeCompositeEntries` for each kind after teardown; reload if changed

**Tests (`packages/remote/test/`):**
- `gateway-catalog-schema.test.ts`
- `gateway-catalog-derive-sirius.test.ts`
- `gateway-catalog-derive-embersynth.test.ts`
- `gateway-catalog-hash.test.ts`
- `gateway-catalog-apply.test.ts`
- `gateway-catalog-remove.test.ts`
- `gateway-catalog-io.test.ts`
- `gateway-handler-sirius-composite.test.ts` (extends `gateway-handlers.test.ts` patterns)
- `gateway-handler-embersynth-composite.test.ts`
- `composite-destroy-catalog-cleanup.test.ts` (extends `composite-apply.test.ts` patterns)

---

## Conventions

**Test runner.** `bun test --cwd packages/remote`. Hermetic on-disk paths via `LLAMACTL_TEST_PROFILE` / `DEV_STORAGE` (set in `beforeEach`); existing `loadSiriusProviders` / `loadEmbersynthConfig` honour the `LLAMACTL_SIRIUS_PROVIDERS` / `LLAMACTL_EMBERSYNTH_CONFIG` env-var path overrides.

**Real typecheck.** `bunx tsc -p packages/remote/tsconfig.json --noEmit`. Existing pre-existing remote-package errors are OK; this plan must not add any. Verify count stays unchanged at each task boundary.

**Conventional Commits.** One commit per task. `feat(remote/gateway-catalog): ...`, `feat(remote/gateway-handlers): ...`, etc. No AI/co-author trailers.

**Spec source of truth.** Decisions are locked in `docs/superpowers/specs/2026-04-26-gateway-auto-populate-design.md`. Don't re-litigate — if you spot a real implementation gap, surface it before improvising.

**Cross-repo precondition (D8).** Before merging, verify that sirius and embersynth schemas tolerate the new optional `ownership` field. See Task 11.

---

## Task 1: Schemas — `CompositeOwnership`, `ProviderConfigCommon`, extend `SiriusProvider` and `EmbersynthNode`

**Files:**
- Create: `packages/remote/src/workload/gateway-catalog/schema.ts`
- Modify: `packages/remote/src/config/sirius-providers.ts`
- Modify: `packages/remote/src/config/embersynth.ts`
- Modify: `packages/remote/src/composite/schema.ts`
- Modify: `packages/remote/src/workload/gateway-handlers/types.ts`
- Test: `packages/remote/test/gateway-catalog-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/gateway-catalog-schema.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSiriusProviders,
  saveSiriusProviders,
} from '../src/config/sirius-providers';
import { loadEmbersynthConfig, saveEmbersynthConfig } from '../src/config/embersynth';
import { CompositeOwnershipSchema } from '../src/workload/gateway-catalog/schema';

describe('CompositeOwnership schema', () => {
  test('accepts shape with non-empty compositeNames', () => {
    const ok = CompositeOwnershipSchema.safeParse({
      source: 'composite',
      compositeNames: ['a'],
      specHash: 'h1',
    });
    expect(ok.success).toBe(true);
  });

  test('rejects empty compositeNames', () => {
    const out = CompositeOwnershipSchema.safeParse({
      source: 'composite',
      compositeNames: [],
      specHash: 'h1',
    });
    expect(out.success).toBe(false);
  });
});

describe('SiriusProvider schema with ownership', () => {
  let tmp: string;
  let path: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sp-'));
    path = join(tmp, 'sirius-providers.yaml');
    prev = process.env.LLAMACTL_SIRIUS_PROVIDERS;
    process.env.LLAMACTL_SIRIUS_PROVIDERS = path;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LLAMACTL_SIRIUS_PROVIDERS;
    else process.env.LLAMACTL_SIRIUS_PROVIDERS = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('round-trips ownership marker', () => {
    saveSiriusProviders([
      {
        name: 'mc-llama',
        kind: 'openai-compatible',
        baseUrl: 'http://host.lan:8080/v1',
        ownership: {
          source: 'composite',
          compositeNames: ['mc'],
          specHash: 'abc',
        },
      } as any,
    ]);
    const out = loadSiriusProviders();
    expect(out[0]!.ownership).toEqual({
      source: 'composite',
      compositeNames: ['mc'],
      specHash: 'abc',
    } as any);
  });

  test('parses operator entry without ownership marker', () => {
    saveSiriusProviders([
      { name: 'openai', kind: 'openai', apiKeyRef: '$OPENAI' } as any,
    ]);
    const out = loadSiriusProviders();
    expect(out[0]!.name).toBe('openai');
    expect((out[0] as any).ownership).toBeUndefined();
  });
});

describe('EmbersynthNode schema with ownership', () => {
  let tmp: string;
  let path: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'em-'));
    path = join(tmp, 'embersynth.yaml');
    prev = process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    process.env.LLAMACTL_EMBERSYNTH_CONFIG = path;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    else process.env.LLAMACTL_EMBERSYNTH_CONFIG = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('round-trips ownership marker on a node', () => {
    saveEmbersynthConfig({
      nodes: [
        {
          id: 'mc-llama',
          label: 'mc/llama',
          endpoint: 'http://host.lan:8080/v1',
          transport: 'http',
          enabled: true,
          capabilities: ['reasoning'],
          tags: ['vision'],
          providerType: 'openai-compatible',
          modelId: 'default',
          priority: 5,
          ownership: {
            source: 'composite',
            compositeNames: ['mc'],
            specHash: 'abc',
          },
        } as any,
      ],
      profiles: [],
      syntheticModels: {},
      server: { host: '127.0.0.1', port: 7777 },
    });
    const out = loadEmbersynthConfig();
    expect((out!.nodes[0] as any).ownership.compositeNames).toEqual(['mc']);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/gateway-catalog-schema.test.ts`
Expected: FAIL — `CompositeOwnershipSchema` not found; `ownership` not a recognized field.

- [ ] **Step 3: Create `gateway-catalog/schema.ts`**

```ts
// packages/remote/src/workload/gateway-catalog/schema.ts
import { z } from 'zod';

/**
 * Marker on YAML entries that llamactl writes on behalf of a composite.
 * Operator-authored entries omit this object entirely. Reference-counted
 * across composites — the same entry can be co-owned by multiple
 * composites, the union of which lives in `compositeNames`.
 */
export const CompositeOwnershipSchema = z.object({
  source: z.literal('composite'),
  compositeNames: z.array(z.string().min(1)).min(1),
  specHash: z.string().min(1),
});
export type CompositeOwnership = z.infer<typeof CompositeOwnershipSchema>;

/**
 * Common per-handler config carried on a composite gateway entry.
 * Strict on cross-handler fields (tags, displayName, priority) so
 * typos surface at apply time; `extra` is the escape hatch for
 * handler-specific opaque overrides.
 */
export const ProviderConfigCommonSchema = z
  .object({
    tags: z.array(z.string()).optional(),
    displayName: z.string().optional(),
    priority: z.number().int().min(1).max(10).optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ProviderConfigCommon = z.infer<typeof ProviderConfigCommonSchema>;

export interface ApplyConflict {
  kind: 'name' | 'shape';
  name: string;
  /** When kind=='name': 'operator'. When kind=='shape': describes the differing field. */
  detail: string;
}
```

- [ ] **Step 4: Extend `SiriusProviderSchema`**

In `packages/remote/src/config/sirius-providers.ts`, add the import and the optional field:

```ts
import { CompositeOwnershipSchema } from '../workload/gateway-catalog/schema.js';

// In SiriusProviderSchema definition, add:
//   ownership: CompositeOwnershipSchema.optional(),
```

- [ ] **Step 5: Extend `EmbersynthNodeSchema`**

In `packages/remote/src/config/embersynth.ts`, find `EmbersynthNodeSchema` (around line 46) and add inside its `z.object({...})`:

```ts
ownership: CompositeOwnershipSchema.optional(),
```

Add the import at the top:

```ts
import { CompositeOwnershipSchema } from '../workload/gateway-catalog/schema.js';
```

- [ ] **Step 6: Update `composite/schema.ts` with `ProviderConfigCommon`**

Find the gateway-entry schema in `packages/remote/src/composite/schema.ts` (search for `providerConfig` — `grep -n "providerConfig" packages/remote/src/composite/schema.ts`). Replace its current `z.record(z.string(), z.unknown())` with `ProviderConfigCommonSchema.optional()`. Add the import.

- [ ] **Step 7: Thread typed `ProviderConfigCommon` through handler types**

In `packages/remote/src/workload/gateway-handlers/types.ts`, change `CompositeGatewayContext.providerConfig` from `Readonly<Record<string, unknown>>` to `ProviderConfigCommon`. Add the import.

- [ ] **Step 8: Run, verify pass**

Run: `bun test --cwd packages/remote test/gateway-catalog-schema.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 9: Run remote suite — no regressions**

Run: `bun test --cwd packages/remote 2>&1 | tail -10`
Expected: All previously-passing tests still pass.

- [ ] **Step 10: Real typecheck**

Run: `bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | wc -l`
Record this number; subsequent tasks must not exceed it.

- [ ] **Step 11: Commit**

```bash
git add packages/remote/src/workload/gateway-catalog/schema.ts \
        packages/remote/src/config/sirius-providers.ts \
        packages/remote/src/config/embersynth.ts \
        packages/remote/src/composite/schema.ts \
        packages/remote/src/workload/gateway-handlers/types.ts \
        packages/remote/test/gateway-catalog-schema.test.ts
git commit -m "feat(remote): add CompositeOwnership marker and ProviderConfigCommon schema"
```

---

## Task 2: `deriveSiriusEntries`

**Files:**
- Create: `packages/remote/src/workload/gateway-catalog/sirius-entries.ts`
- Test: `packages/remote/test/gateway-catalog-derive-sirius.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/gateway-catalog-derive-sirius.test.ts
import { describe, expect, test } from 'bun:test';
import { deriveSiriusEntries } from '../src/workload/gateway-catalog/sirius-entries';
import type { CompositeGatewayContext } from '../src/workload/gateway-handlers/types';

const ctx: CompositeGatewayContext = {
  compositeName: 'mc',
  upstreams: [
    { name: 'llama-31-8b', endpoint: 'http://host.lan:8080/v1', nodeName: 'macbook-pro' },
    { name: 'qwen-72b', endpoint: 'http://atlas.lan:8080/v1', nodeName: 'atlas' },
  ],
  providerConfig: { tags: ['vision'], displayName: 'My Llama' },
};

describe('deriveSiriusEntries', () => {
  test('produces one openai-compatible provider per upstream', () => {
    const out = deriveSiriusEntries(ctx);
    expect(out.length).toBe(2);
    expect(out.every((e) => e.kind === 'openai-compatible')).toBe(true);
  });

  test('names are deterministic: <compositeName>-<upstream.name>', () => {
    const out = deriveSiriusEntries(ctx);
    expect(out.map((e) => e.name)).toEqual(['mc-llama-31-8b', 'mc-qwen-72b']);
  });

  test('baseUrl flows from upstream.endpoint', () => {
    const out = deriveSiriusEntries(ctx);
    expect(out[0]!.baseUrl).toBe('http://host.lan:8080/v1');
  });

  test('displayName from providerConfig wins per-entry', () => {
    const out = deriveSiriusEntries(ctx);
    expect(out[0]!.displayName).toBe('My Llama');
  });

  test('empty upstreams returns []', () => {
    expect(deriveSiriusEntries({ ...ctx, upstreams: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/gateway-catalog-derive-sirius.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/workload/gateway-catalog/sirius-entries.ts
import type { CompositeGatewayContext } from '../gateway-handlers/types.js';

export interface DerivedSiriusEntry {
  name: string;
  kind: 'openai-compatible';
  baseUrl: string;
  apiKeyRef?: string;
  displayName?: string;
}

export function deriveSiriusEntries(
  ctx: CompositeGatewayContext,
): DerivedSiriusEntry[] {
  return ctx.upstreams.map((u) => ({
    name: `${ctx.compositeName}-${u.name}`,
    kind: 'openai-compatible' as const,
    baseUrl: u.endpoint,
    displayName: ctx.providerConfig.displayName,
  }));
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/gateway-catalog-derive-sirius.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/workload/gateway-catalog/sirius-entries.ts \
        packages/remote/test/gateway-catalog-derive-sirius.test.ts
git commit -m "feat(remote/gateway-catalog): add deriveSiriusEntries"
```

---

## Task 3: `deriveEmbersynthEntries` (nodes only)

**Files:**
- Create: `packages/remote/src/workload/gateway-catalog/embersynth-entries.ts`
- Test: `packages/remote/test/gateway-catalog-derive-embersynth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/gateway-catalog-derive-embersynth.test.ts
import { describe, expect, test } from 'bun:test';
import { deriveEmbersynthEntries } from '../src/workload/gateway-catalog/embersynth-entries';
import type { CompositeGatewayContext } from '../src/workload/gateway-handlers/types';

const ctx: CompositeGatewayContext = {
  compositeName: 'mc',
  upstreams: [
    { name: 'llama-31-8b', endpoint: 'http://host.lan:8080/v1', nodeName: 'macbook-pro' },
  ],
  providerConfig: { tags: ['vision'], priority: 3, displayName: 'Llama 3.1' },
};

describe('deriveEmbersynthEntries', () => {
  test('one upstream → one node entry', () => {
    const out = deriveEmbersynthEntries(ctx);
    expect(out.length).toBe(1);
  });

  test('id is deterministic: <compositeName>-<upstream.name>', () => {
    const out = deriveEmbersynthEntries(ctx);
    expect(out[0]!.id).toBe('mc-llama-31-8b');
  });

  test('endpoint flows from upstream.endpoint', () => {
    const out = deriveEmbersynthEntries(ctx);
    expect(out[0]!.endpoint).toBe('http://host.lan:8080/v1');
  });

  test('tags flow into node.tags', () => {
    const out = deriveEmbersynthEntries(ctx);
    expect(out[0]!.tags).toEqual(['vision']);
  });

  test('priority flows from providerConfig.priority', () => {
    const out = deriveEmbersynthEntries(ctx);
    expect(out[0]!.priority).toBe(3);
  });

  test('default priority is 10 when providerConfig.priority absent', () => {
    const out = deriveEmbersynthEntries({ ...ctx, providerConfig: {} });
    expect(out[0]!.priority).toBe(10);
  });

  test('empty upstreams returns []', () => {
    expect(deriveEmbersynthEntries({ ...ctx, upstreams: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/gateway-catalog-derive-embersynth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/workload/gateway-catalog/embersynth-entries.ts
import type { CompositeGatewayContext } from '../gateway-handlers/types.js';
import type { EmbersynthNode } from '../../config/embersynth.js';

export type DerivedEmbersynthEntry = EmbersynthNode;

export function deriveEmbersynthEntries(
  ctx: CompositeGatewayContext,
): DerivedEmbersynthEntry[] {
  const tags = ctx.providerConfig.tags ?? [];
  const priority = ctx.providerConfig.priority ?? 10;
  return ctx.upstreams.map((u) => ({
    id: `${ctx.compositeName}-${u.name}`,
    label: ctx.providerConfig.displayName ?? `${ctx.compositeName}/${u.name}`,
    endpoint: u.endpoint,
    transport: 'http' as const,
    enabled: true,
    capabilities: [],
    tags,
    providerType: 'openai-compatible' as const,
    modelId: 'default',
    priority,
  }));
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/gateway-catalog-derive-embersynth.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/workload/gateway-catalog/embersynth-entries.ts \
        packages/remote/test/gateway-catalog-derive-embersynth.test.ts
git commit -m "feat(remote/gateway-catalog): add deriveEmbersynthEntries (nodes)"
```

---

## Task 4: `entrySpecHash`

**Files:**
- Create: `packages/remote/src/workload/gateway-catalog/hash.ts`
- Test: `packages/remote/test/gateway-catalog-hash.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/gateway-catalog-hash.test.ts
import { describe, expect, test } from 'bun:test';
import { entrySpecHash } from '../src/workload/gateway-catalog/hash';

describe('entrySpecHash — sirius shape', () => {
  test('deterministic for same shape', () => {
    const a = { name: 'x', kind: 'openai-compatible', baseUrl: 'http://h:1/v1' };
    expect(entrySpecHash(a)).toBe(entrySpecHash(a));
  });

  test('differs when baseUrl changes', () => {
    const a = { name: 'x', kind: 'openai-compatible', baseUrl: 'http://h:1/v1' };
    const b = { name: 'x', kind: 'openai-compatible', baseUrl: 'http://h:2/v1' };
    expect(entrySpecHash(a)).not.toBe(entrySpecHash(b));
  });

  test('ignores compositeNames inside ownership block', () => {
    const a = {
      name: 'x',
      kind: 'openai-compatible',
      baseUrl: 'http://h:1/v1',
      ownership: { source: 'composite', compositeNames: ['a'], specHash: '' },
    };
    const b = {
      name: 'x',
      kind: 'openai-compatible',
      baseUrl: 'http://h:1/v1',
      ownership: { source: 'composite', compositeNames: ['a', 'b'], specHash: '' },
    };
    expect(entrySpecHash(a)).toBe(entrySpecHash(b));
  });
});

describe('entrySpecHash — embersynth shape', () => {
  test('differs when tags change', () => {
    const a = { id: 'x', endpoint: 'http://h:1/v1', tags: ['vision'], priority: 5 };
    const b = { id: 'x', endpoint: 'http://h:1/v1', tags: ['code'], priority: 5 };
    expect(entrySpecHash(a)).not.toBe(entrySpecHash(b));
  });

  test('differs when priority changes', () => {
    const a = { id: 'x', endpoint: 'http://h:1/v1', tags: ['vision'], priority: 5 };
    const b = { id: 'x', endpoint: 'http://h:1/v1', tags: ['vision'], priority: 7 };
    expect(entrySpecHash(a)).not.toBe(entrySpecHash(b));
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/gateway-catalog-hash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/workload/gateway-catalog/hash.ts
import { createHash } from 'node:crypto';

/**
 * Stable hash of an entry's "shape" — deliberately ignores the
 * `ownership` block (so adding/removing a composite from compositeNames
 * doesn't trigger a "shape changed" reapply for the entry's other
 * owners) and ignores the `specHash` field on the existing ownership
 * if any (chicken-and-egg).
 */
export function entrySpecHash(entry: unknown): string {
  const stripped = stripOwnership(entry);
  const json = stableStringify(stripped);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function stripOwnership(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOwnership);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      if (k === 'ownership') continue;
      out[k] = stripOwnership((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + stableStringify((value as any)[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/gateway-catalog-hash.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/workload/gateway-catalog/hash.ts \
        packages/remote/test/gateway-catalog-hash.test.ts
git commit -m "feat(remote/gateway-catalog): add entrySpecHash"
```

---

## Task 5: `applyCompositeEntries`

**Files:**
- Create: `packages/remote/src/workload/gateway-catalog/apply.ts`
- Test: `packages/remote/test/gateway-catalog-apply.test.ts`

The apply function is parameterized over kind. For sirius, it operates on `SiriusProvider[]`. For embersynth, on `EmbersynthNode[]`. Same merge logic; per-kind matching is by `name` (sirius) or `id` (embersynth).

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/gateway-catalog-apply.test.ts
import { describe, expect, test } from 'bun:test';
import { applyCompositeEntries } from '../src/workload/gateway-catalog/apply';
import type { SiriusProvider } from '../src/config/sirius-providers';

const baseDerived: SiriusProvider = {
  name: 'mc-llama',
  kind: 'openai-compatible',
  baseUrl: 'http://h:1/v1',
} as SiriusProvider;

describe('applyCompositeEntries — sirius', () => {
  test('appends new entry on empty current', () => {
    const r = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      derived: [baseDerived],
      current: [],
    });
    expect(r.changed).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.next.length).toBe(1);
    const o = (r.next[0] as any).ownership;
    expect(o.compositeNames).toEqual(['mc']);
    expect(o.specHash).toBeTruthy();
  });

  test('idempotent on re-apply by same composite (same shape)', () => {
    const first = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      derived: [baseDerived],
      current: [],
    });
    const second = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      derived: [baseDerived],
      current: first.next as SiriusProvider[],
    });
    expect(second.changed).toBe(false);
  });

  test('unions compositeNames when same shape from different composite', () => {
    const first = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      derived: [baseDerived],
      current: [],
    });
    const second = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'other',
      derived: [baseDerived],
      current: first.next as SiriusProvider[],
    });
    expect(second.changed).toBe(true);
    const o = (second.next[0] as any).ownership;
    expect(o.compositeNames.sort()).toEqual(['mc', 'other']);
  });

  test('shape mismatch between two composites returns conflict', () => {
    const first = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      derived: [baseDerived],
      current: [],
    });
    const second = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'other',
      derived: [{ ...baseDerived, baseUrl: 'http://different:1/v1' }],
      current: first.next as SiriusProvider[],
    });
    expect(second.conflicts.length).toBe(1);
    expect(second.conflicts[0]!.kind).toBe('shape');
    expect(second.conflicts[0]!.name).toBe('mc-llama');
  });

  test('name collision against operator entry returns conflict', () => {
    const operator: SiriusProvider = {
      name: 'mc-llama',
      kind: 'openai',
      apiKeyRef: '$OPENAI',
    } as SiriusProvider;
    const r = applyCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      derived: [baseDerived],
      current: [operator],
    });
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0]!.kind).toBe('name');
    expect(r.conflicts[0]!.detail).toBe('operator');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/gateway-catalog-apply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/workload/gateway-catalog/apply.ts
import { entrySpecHash } from './hash.js';
import type { ApplyConflict, CompositeOwnership } from './schema.js';

type AnyEntry = Record<string, unknown> & { ownership?: CompositeOwnership };

export interface ApplyOpts<T> {
  kind: 'sirius' | 'embersynth';
  compositeName: string;
  derived: T[];
  current: T[];
}

export interface ApplyResult<T> {
  next: T[];
  changed: boolean;
  conflicts: ApplyConflict[];
}

const KEY_OF: Record<string, string> = { sirius: 'name', embersynth: 'id' };

export function applyCompositeEntries<T extends AnyEntry>(
  opts: ApplyOpts<T>,
): ApplyResult<T> {
  const key = KEY_OF[opts.kind]!;
  const map = new Map<string, T>();
  for (const e of opts.current) {
    map.set(String((e as any)[key]), e);
  }
  const conflicts: ApplyConflict[] = [];
  let changed = false;
  for (const d of opts.derived) {
    const k = String((d as any)[key]);
    const existing = map.get(k);
    const newHash = entrySpecHash(d);
    if (!existing) {
      const next = {
        ...d,
        ownership: {
          source: 'composite' as const,
          compositeNames: [opts.compositeName],
          specHash: newHash,
        },
      };
      map.set(k, next as T);
      changed = true;
      continue;
    }
    if (!existing.ownership) {
      conflicts.push({ kind: 'name', name: k, detail: 'operator' });
      continue;
    }
    const existingHash = entrySpecHash(existing);
    if (existingHash !== newHash) {
      conflicts.push({
        kind: 'shape',
        name: k,
        detail: `existing shape (specHash=${existingHash}) does not match composite-derived shape (specHash=${newHash})`,
      });
      continue;
    }
    if (existing.ownership.compositeNames.includes(opts.compositeName)) {
      // Already owned by this composite + same shape → no-op.
      continue;
    }
    const next = {
      ...existing,
      ownership: {
        ...existing.ownership,
        compositeNames: [...existing.ownership.compositeNames, opts.compositeName].sort(),
        specHash: newHash,
      },
    };
    map.set(k, next as T);
    changed = true;
  }
  return { next: [...map.values()], changed, conflicts };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/gateway-catalog-apply.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/workload/gateway-catalog/apply.ts \
        packages/remote/test/gateway-catalog-apply.test.ts
git commit -m "feat(remote/gateway-catalog): add applyCompositeEntries with conflict detection"
```

---

## Task 6: `removeCompositeEntries`

**Files:**
- Create: `packages/remote/src/workload/gateway-catalog/remove.ts`
- Test: `packages/remote/test/gateway-catalog-remove.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/gateway-catalog-remove.test.ts
import { describe, expect, test } from 'bun:test';
import { removeCompositeEntries } from '../src/workload/gateway-catalog/remove';

const own = (names: string[]) => ({
  source: 'composite' as const,
  compositeNames: names,
  specHash: 'h',
});

describe('removeCompositeEntries', () => {
  test('drops entry when last composite removed', () => {
    const r = removeCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      current: [
        { name: 'a', kind: 'openai-compatible', baseUrl: 'http://h/v1', ownership: own(['mc']) },
      ] as any,
    });
    expect(r.changed).toBe(true);
    expect(r.removedNames).toEqual(['a']);
    expect(r.next.length).toBe(0);
  });

  test('keeps entry with shorter compositeNames list when others remain', () => {
    const r = removeCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      current: [
        {
          name: 'a',
          kind: 'openai-compatible',
          baseUrl: 'http://h/v1',
          ownership: own(['mc', 'other']),
        },
      ] as any,
    });
    expect(r.changed).toBe(true);
    expect(r.removedNames).toEqual([]);
    expect(r.next.length).toBe(1);
    expect((r.next[0] as any).ownership.compositeNames).toEqual(['other']);
  });

  test('leaves operator-owned entries untouched', () => {
    const r = removeCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      current: [
        { name: 'op', kind: 'openai', apiKeyRef: '$X' },
        { name: 'cm', kind: 'openai-compatible', baseUrl: 'http://h/v1', ownership: own(['mc']) },
      ] as any,
    });
    expect(r.next.length).toBe(1);
    expect((r.next[0] as any).name).toBe('op');
    expect(r.removedNames).toEqual(['cm']);
  });

  test('no-op when composite name not present', () => {
    const r = removeCompositeEntries({
      kind: 'sirius',
      compositeName: 'mc',
      current: [
        { name: 'a', kind: 'openai-compatible', baseUrl: 'http://h/v1', ownership: own(['other']) },
      ] as any,
    });
    expect(r.changed).toBe(false);
    expect(r.next.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/gateway-catalog-remove.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/workload/gateway-catalog/remove.ts
import type { CompositeOwnership } from './schema.js';

type AnyEntry = Record<string, unknown> & { ownership?: CompositeOwnership };

export interface RemoveOpts<T> {
  kind: 'sirius' | 'embersynth';
  compositeName: string;
  current: T[];
}

export interface RemoveResult<T> {
  next: T[];
  changed: boolean;
  removedNames: string[];
}

const KEY_OF: Record<string, string> = { sirius: 'name', embersynth: 'id' };

export function removeCompositeEntries<T extends AnyEntry>(
  opts: RemoveOpts<T>,
): RemoveResult<T> {
  const key = KEY_OF[opts.kind]!;
  const next: T[] = [];
  const removedNames: string[] = [];
  let changed = false;
  for (const e of opts.current) {
    if (!e.ownership) {
      next.push(e);
      continue;
    }
    if (!e.ownership.compositeNames.includes(opts.compositeName)) {
      next.push(e);
      continue;
    }
    const remaining = e.ownership.compositeNames.filter((n) => n !== opts.compositeName);
    changed = true;
    if (remaining.length === 0) {
      removedNames.push(String((e as any)[key]));
      continue;
    }
    next.push({ ...e, ownership: { ...e.ownership, compositeNames: remaining } } as T);
  }
  return { next, changed, removedNames };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/gateway-catalog-remove.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/workload/gateway-catalog/remove.ts \
        packages/remote/test/gateway-catalog-remove.test.ts
git commit -m "feat(remote/gateway-catalog): add removeCompositeEntries (ref-counted)"
```

---

## Task 7: `gateway-catalog/io.ts`

**Files:**
- Create: `packages/remote/src/workload/gateway-catalog/io.ts`
- Create: `packages/remote/src/workload/gateway-catalog/index.ts`
- Test: `packages/remote/test/gateway-catalog-io.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/gateway-catalog-io.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readGatewayCatalog,
  writeGatewayCatalog,
} from '../src/workload/gateway-catalog/io';

describe('gateway-catalog io', () => {
  let tmp: string;
  let prevSp: string | undefined;
  let prevEm: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gc-io-'));
    prevSp = process.env.LLAMACTL_SIRIUS_PROVIDERS;
    prevEm = process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    process.env.LLAMACTL_SIRIUS_PROVIDERS = join(tmp, 'sp.yaml');
    process.env.LLAMACTL_EMBERSYNTH_CONFIG = join(tmp, 'em.yaml');
  });

  afterEach(() => {
    if (prevSp === undefined) delete process.env.LLAMACTL_SIRIUS_PROVIDERS;
    else process.env.LLAMACTL_SIRIUS_PROVIDERS = prevSp;
    if (prevEm === undefined) delete process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    else process.env.LLAMACTL_EMBERSYNTH_CONFIG = prevEm;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('sirius round-trip', () => {
    writeGatewayCatalog('sirius', [
      { name: 'a', kind: 'openai-compatible', baseUrl: 'http://h/v1' } as any,
    ]);
    const out = readGatewayCatalog('sirius');
    expect(out.length).toBe(1);
    expect((out[0] as any).name).toBe('a');
  });

  test('embersynth round-trip — preserves nodes', () => {
    writeGatewayCatalog('embersynth', [
      {
        id: 'a',
        label: 'a',
        endpoint: 'http://h/v1',
        transport: 'http',
        enabled: true,
        capabilities: [],
        tags: [],
        providerType: 'openai-compatible',
        modelId: 'default',
        priority: 5,
      } as any,
    ]);
    const out = readGatewayCatalog('embersynth');
    expect(out.length).toBe(1);
    expect((out[0] as any).id).toBe('a');
  });

  test('reading missing sirius file returns empty array', () => {
    const out = readGatewayCatalog('sirius');
    expect(out).toEqual([]);
  });

  test('reading missing embersynth file returns empty array', () => {
    const out = readGatewayCatalog('embersynth');
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/gateway-catalog-io.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `io.ts`**

```ts
// packages/remote/src/workload/gateway-catalog/io.ts
import {
  loadSiriusProviders,
  saveSiriusProviders,
  type SiriusProvider,
} from '../../config/sirius-providers.js';
import {
  loadEmbersynthConfig,
  saveEmbersynthConfig,
  type EmbersynthNode,
} from '../../config/embersynth.js';

export type GatewayKind = 'sirius' | 'embersynth';

export function readGatewayCatalog(kind: 'sirius'): SiriusProvider[];
export function readGatewayCatalog(kind: 'embersynth'): EmbersynthNode[];
export function readGatewayCatalog(kind: GatewayKind): SiriusProvider[] | EmbersynthNode[] {
  if (kind === 'sirius') return loadSiriusProviders();
  const cfg = loadEmbersynthConfig();
  return cfg ? cfg.nodes : [];
}

export function writeGatewayCatalog(kind: 'sirius', entries: SiriusProvider[]): void;
export function writeGatewayCatalog(kind: 'embersynth', entries: EmbersynthNode[]): void;
export function writeGatewayCatalog(
  kind: GatewayKind,
  entries: SiriusProvider[] | EmbersynthNode[],
): void {
  if (kind === 'sirius') {
    saveSiriusProviders(entries as SiriusProvider[]);
    return;
  }
  // For embersynth, preserve any non-node fields the operator may
  // already have (profiles, syntheticModels, etc.).
  const cur = loadEmbersynthConfig() ?? {
    server: { host: '127.0.0.1', port: 7777 },
    nodes: [],
    profiles: [],
    syntheticModels: {},
  };
  saveEmbersynthConfig({
    ...cur,
    nodes: entries as EmbersynthNode[],
  });
}
```

- [ ] **Step 4: Implement `index.ts`**

```ts
// packages/remote/src/workload/gateway-catalog/index.ts
export { CompositeOwnershipSchema, ProviderConfigCommonSchema } from './schema.js';
export type {
  CompositeOwnership,
  ProviderConfigCommon,
  ApplyConflict,
} from './schema.js';
export { deriveSiriusEntries } from './sirius-entries.js';
export type { DerivedSiriusEntry } from './sirius-entries.js';
export { deriveEmbersynthEntries } from './embersynth-entries.js';
export type { DerivedEmbersynthEntry } from './embersynth-entries.js';
export { entrySpecHash } from './hash.js';
export { applyCompositeEntries } from './apply.js';
export type { ApplyOpts, ApplyResult } from './apply.js';
export { removeCompositeEntries } from './remove.js';
export type { RemoveOpts, RemoveResult } from './remove.js';
export { readGatewayCatalog, writeGatewayCatalog } from './io.js';
export type { GatewayKind } from './io.js';
```

- [ ] **Step 5: Run, verify pass**

Run: `bun test --cwd packages/remote test/gateway-catalog-io.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/remote/src/workload/gateway-catalog/io.ts \
        packages/remote/src/workload/gateway-catalog/index.ts \
        packages/remote/test/gateway-catalog-io.test.ts
git commit -m "feat(remote/gateway-catalog): add io module + public index"
```

---

## Task 8: Sirius handler — composite-aware prelude

**Files:**
- Modify: `packages/remote/src/workload/gateway-handlers/sirius.ts`
- Test: `packages/remote/test/gateway-handler-sirius-composite.test.ts`

The handler's existing apply path (no composite) is unchanged. When `opts.composite` is set, we add a prelude that derives entries, merges into the on-disk catalog, returns Pending on conflict, otherwise writes and falls through to the existing reload logic. The reload itself fires only when the merge changed something (D7 idempotency).

- [ ] **Step 1: Write the failing test**

Read the existing patterns first: `head -80 packages/remote/test/gateway-handlers.test.ts`. Use the same fetch-mock approach for `/providers/reload`. Then:

```ts
// packages/remote/test/gateway-handler-sirius-composite.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { siriusHandler } from '../src/workload/gateway-handlers/sirius';
import { readGatewayCatalog } from '../src/workload/gateway-catalog/io';

const node = {
  name: 'sirius-1',
  kind: 'gateway',
  cloud: { provider: 'sirius', baseUrl: 'http://sirius.test' },
} as any;

const manifest = {
  apiVersion: 'llamactl/v1',
  kind: 'ModelRun',
  metadata: { name: 'm', labels: {} },
  spec: {
    node: 'sirius-1',
    target: { kind: 'rel' as const, value: 'mc-llama/x' },
    extraArgs: [],
    timeoutSeconds: 60,
    workers: [],
    gateway: true,
  },
} as any;

const composite = {
  compositeName: 'mc',
  upstreams: [{ name: 'llama', endpoint: 'http://h:1/v1', nodeName: 'mac' }],
  providerConfig: {},
};

describe('siriusHandler with composite context', () => {
  let tmp: string;
  let prev: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sh-'));
    prev = process.env.LLAMACTL_SIRIUS_PROVIDERS;
    process.env.LLAMACTL_SIRIUS_PROVIDERS = join(tmp, 'sp.yaml');
    origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as any;
    // also stub kubeconfig lookup; reuse what the existing handler test does.
    // (See gateway-handlers.test.ts for the pattern; copy verbatim.)
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LLAMACTL_SIRIUS_PROVIDERS;
    else process.env.LLAMACTL_SIRIUS_PROVIDERS = prev;
    globalThis.fetch = origFetch;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('writes entries before reload', async () => {
    await siriusHandler.apply({
      manifest,
      node,
      getClient: (() => null) as any,
      composite,
    });
    const out = readGatewayCatalog('sirius');
    expect(out.find((e) => e.name === 'mc-llama')).toBeDefined();
  });

  test('returns Pending NameCollision when operator entry exists with same name', async () => {
    const path = join(tmp, 'sp.yaml');
    const fs = require('node:fs');
    fs.writeFileSync(
      path,
      'apiVersion: llamactl/v1\nkind: SiriusProviderList\nproviders:\n  - name: mc-llama\n    kind: openai\n    apiKeyRef: $K\n',
      'utf8',
    );
    const r = await siriusHandler.apply({
      manifest,
      node,
      getClient: (() => null) as any,
      composite,
    });
    expect(r.action).toBe('pending');
    expect(r.statusSection.conditions[0]!.reason).toBe('SiriusUpstreamNameCollision');
  });

  test('idempotent re-apply skips reload', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response('ok', { status: 200 });
    }) as any;
    await siriusHandler.apply({ manifest, node, getClient: (() => null) as any, composite });
    const before = calls.length;
    await siriusHandler.apply({ manifest, node, getClient: (() => null) as any, composite });
    expect(calls.length).toBe(before); // no new reload on second apply
  });
});
```

If kubeconfig stubbing is awkward, factor the auth path into an injectable helper or use the same pattern the existing `gateway-handlers.test.ts` uses. Read that file first:

```bash
grep -n "currentContext\|loadConfig\|resolveToken\|fetch =" packages/remote/test/gateway-handlers.test.ts | head -10
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/gateway-handler-sirius-composite.test.ts`
Expected: FAIL — composite branch not implemented; current handler ignores `opts.composite`.

- [ ] **Step 3: Modify `sirius.ts` apply()**

In `packages/remote/src/workload/gateway-handlers/sirius.ts`, add the imports near the top:

```ts
import {
  deriveSiriusEntries,
  applyCompositeEntries,
  readGatewayCatalog,
  writeGatewayCatalog,
} from '../gateway-catalog/index.js';
```

Replace the apply method body to gate on `opts.composite`. New flow:

```ts
async apply(opts: GatewayApplyOptions): Promise<ApplyResult> {
  const now = new Date().toISOString();

  // Composite-aware prelude — only when composite context is set.
  let catalogChanged = false;
  if (opts.composite) {
    const derived = deriveSiriusEntries(opts.composite);
    const current = readGatewayCatalog('sirius');
    const result = applyCompositeEntries({
      kind: 'sirius',
      compositeName: opts.composite.compositeName,
      derived,
      current,
    });
    if (result.conflicts.length > 0) {
      const c = result.conflicts[0]!;
      const reason =
        c.kind === 'name' ? 'SiriusUpstreamNameCollision' : 'SiriusUpstreamShapeMismatch';
      const message =
        c.kind === 'name'
          ? `entry '${c.name}' already exists as an operator-authored provider; remove it or change composite spec`
          : `entry '${c.name}': ${c.detail}`;
      return pending(opts, reason, message, now);
    }
    if (result.changed) {
      try {
        writeGatewayCatalog('sirius', result.next);
        catalogChanged = true;
      } catch (err) {
        return failure(
          opts,
          'SiriusCatalogWriteFailed',
          `could not write sirius-providers.yaml: ${(err as Error).message}`,
          now,
        );
      }
    }
  }

  // Existing flow continues — host-side validation, reload, success path.
  // (Keep the existing target parsing, validation, fetch, success-result code.
  //  Wrap the fetch reload call in `if (!opts.composite || catalogChanged) { ... }`
  //  so an idempotent re-apply skips the reload.)
  // ... rest unchanged ...
}
```

The full reload-skip gate: when `opts.composite` is set AND the catalog wasn't changed by this apply, skip the reload and return a synthesized success ApplyResult derived from the existing entry. When `opts.composite` is unset, reload always (preserves bit-identical behavior for non-composite consumers per success-criterion 6).

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/gateway-handler-sirius-composite.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Run full handler suite — no regressions**

Run: `bun test --cwd packages/remote test/gateway-handlers.test.ts test/gateway-integration.test.ts test/gateway-reload.test.ts 2>&1 | tail -10`
Expected: All previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/remote/src/workload/gateway-handlers/sirius.ts \
        packages/remote/test/gateway-handler-sirius-composite.test.ts
git commit -m "feat(remote/gateway-handlers/sirius): composite-aware catalog auto-populate"
```

---

## Task 9: Embersynth handler — composite-aware prelude

**Files:**
- Modify: `packages/remote/src/workload/gateway-handlers/embersynth.ts`
- Test: `packages/remote/test/gateway-handler-embersynth-composite.test.ts`

Symmetric to Task 8. The reload URL is `/config/reload` (already in the handler); the catalog kind is `embersynth`; the conflict reasons are `EmbersynthUpstreamNameCollision` / `EmbersynthUpstreamShapeMismatch`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/gateway-handler-embersynth-composite.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embersynthHandler } from '../src/workload/gateway-handlers/embersynth';
import { readGatewayCatalog } from '../src/workload/gateway-catalog/io';

const node = {
  name: 'em-1',
  kind: 'gateway',
  cloud: { provider: 'embersynth', baseUrl: 'http://em.test' },
} as any;

const manifest = {
  apiVersion: 'llamactl/v1',
  kind: 'ModelRun',
  metadata: { name: 'm', labels: {} },
  spec: {
    node: 'em-1',
    target: { kind: 'rel' as const, value: 'fusion-vision' },
    extraArgs: [],
    timeoutSeconds: 60,
    workers: [],
    gateway: true,
  },
} as any;

const composite = {
  compositeName: 'mc',
  upstreams: [{ name: 'llama', endpoint: 'http://h:1/v1', nodeName: 'mac' }],
  providerConfig: { tags: ['vision'], priority: 3 },
};

describe('embersynthHandler with composite context', () => {
  let tmp: string;
  let prev: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'eh-'));
    prev = process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    process.env.LLAMACTL_EMBERSYNTH_CONFIG = join(tmp, 'em.yaml');
    origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as any;
    // stub kubeconfig identically to the sirius test (see Task 8 step 1).
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    else process.env.LLAMACTL_EMBERSYNTH_CONFIG = prev;
    globalThis.fetch = origFetch;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('writes a node entry before reload', async () => {
    await embersynthHandler.apply({
      manifest,
      node,
      getClient: (() => null) as any,
      composite,
    });
    const nodes = readGatewayCatalog('embersynth');
    const found = nodes.find((n) => n.id === 'mc-llama');
    expect(found).toBeDefined();
    expect(found!.tags).toEqual(['vision']);
    expect(found!.priority).toBe(3);
  });

  test('returns Pending NameCollision when operator entry exists with same id', async () => {
    const fs = require('node:fs');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(
      join(tmp, 'em.yaml'),
      `nodes:
  - id: mc-llama
    label: hand-edited
    endpoint: http://other:1/v1
    transport: http
    enabled: true
    capabilities: []
    tags: []
    providerType: openai-compatible
    modelId: default
    priority: 5
profiles: []
syntheticModels: {}
server:
  host: 127.0.0.1
  port: 7777
`,
      'utf8',
    );
    const r = await embersynthHandler.apply({
      manifest,
      node,
      getClient: (() => null) as any,
      composite,
    });
    expect(r.action).toBe('pending');
    expect(r.statusSection.conditions[0]!.reason).toBe('EmbersynthUpstreamNameCollision');
  });

  test('idempotent re-apply skips reload', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response('ok', { status: 200 });
    }) as any;
    await embersynthHandler.apply({ manifest, node, getClient: (() => null) as any, composite });
    const before = calls.length;
    await embersynthHandler.apply({ manifest, node, getClient: (() => null) as any, composite });
    expect(calls.length).toBe(before);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/gateway-handler-embersynth-composite.test.ts`
Expected: FAIL — composite branch not implemented.

- [ ] **Step 3: Modify `embersynth.ts` apply() symmetrically**

Imports:

```ts
import {
  deriveEmbersynthEntries,
  applyCompositeEntries,
  readGatewayCatalog,
  writeGatewayCatalog,
} from '../gateway-catalog/index.js';
```

Add the prelude (mirror Task 8) at the top of `apply()`:

```ts
let catalogChanged = false;
if (opts.composite) {
  const derived = deriveEmbersynthEntries(opts.composite);
  const current = readGatewayCatalog('embersynth');
  const result = applyCompositeEntries({
    kind: 'embersynth',
    compositeName: opts.composite.compositeName,
    derived,
    current,
  });
  if (result.conflicts.length > 0) {
    const c = result.conflicts[0]!;
    const reason =
      c.kind === 'name' ? 'EmbersynthUpstreamNameCollision' : 'EmbersynthUpstreamShapeMismatch';
    const message =
      c.kind === 'name'
        ? `node '${c.name}' already exists as an operator-authored embersynth node; remove it or change composite spec`
        : `node '${c.name}': ${c.detail}`;
    return pending(opts, reason, message, now);
  }
  if (result.changed) {
    try {
      writeGatewayCatalog('embersynth', result.next);
      catalogChanged = true;
    } catch (err) {
      return failure(
        opts,
        'EmbersynthCatalogWriteFailed',
        `could not write embersynth.yaml: ${(err as Error).message}`,
        now,
      );
    }
  }
}
```

Wrap the existing `fetch(reloadUrl, ...)` call so that for composite-driven applies it only runs when `catalogChanged === true`; non-composite applies reload as before.

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/gateway-handler-embersynth-composite.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Run full handler suite — no regressions**

Run: `bun test --cwd packages/remote test/gateway-handlers.test.ts test/gateway-integration.test.ts test/gateway-reload.test.ts 2>&1 | tail -10`
Expected: All previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/remote/src/workload/gateway-handlers/embersynth.ts \
        packages/remote/test/gateway-handler-embersynth-composite.test.ts
git commit -m "feat(remote/gateway-handlers/embersynth): composite-aware catalog auto-populate"
```

---

## Task 10: Composite destroy — catalog cleanup

**Files:**
- Modify: `packages/remote/src/composite/apply.ts` (specifically `destroyComposite` around line 533)
- Test: `packages/remote/test/composite-destroy-catalog-cleanup.test.ts`

After workload + service teardown, walk both gateway YAMLs via `removeCompositeEntries` and trigger reload if changed. The reload posts to the same endpoints used during apply; resolve target nodes from the kubeconfig the same way.

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/composite-destroy-catalog-cleanup.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeGatewayCatalog, readGatewayCatalog } from '../src/workload/gateway-catalog/io';
import { destroyComposite } from '../src/composite/apply';

describe('destroyComposite catalog cleanup', () => {
  let tmp: string;
  let prevSp: string | undefined;
  let prevEm: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cd-'));
    prevSp = process.env.LLAMACTL_SIRIUS_PROVIDERS;
    prevEm = process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    process.env.LLAMACTL_SIRIUS_PROVIDERS = join(tmp, 'sp.yaml');
    process.env.LLAMACTL_EMBERSYNTH_CONFIG = join(tmp, 'em.yaml');
    origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as any;
  });

  afterEach(() => {
    if (prevSp === undefined) delete process.env.LLAMACTL_SIRIUS_PROVIDERS;
    else process.env.LLAMACTL_SIRIUS_PROVIDERS = prevSp;
    if (prevEm === undefined) delete process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    else process.env.LLAMACTL_EMBERSYNTH_CONFIG = prevEm;
    globalThis.fetch = origFetch;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('removes solely-owned entries from sirius catalog', async () => {
    writeGatewayCatalog('sirius', [
      {
        name: 'mc-llama',
        kind: 'openai-compatible',
        baseUrl: 'http://h/v1',
        ownership: { source: 'composite', compositeNames: ['mc'], specHash: 'h' },
      } as any,
    ]);
    // Use a minimal manifest the destroy entry-point accepts.
    // (Adapt manifest shape to the actual destroyComposite signature found
    //  in packages/remote/src/composite/apply.ts:533.)
    await destroyComposite({
      manifest: { apiVersion: 'llamactl/v1', kind: 'Composite', metadata: { name: 'mc', labels: {} }, spec: { components: [] } } as any,
      backend: { destroyCompositeBoundary: async () => {} } as any,
    } as any);
    const after = readGatewayCatalog('sirius');
    expect(after.find((e) => e.name === 'mc-llama')).toBeUndefined();
  });

  test('keeps co-owned entries with shorter compositeNames', async () => {
    writeGatewayCatalog('sirius', [
      {
        name: 'mc-llama',
        kind: 'openai-compatible',
        baseUrl: 'http://h/v1',
        ownership: { source: 'composite', compositeNames: ['mc', 'other'], specHash: 'h' },
      } as any,
    ]);
    await destroyComposite({
      manifest: { apiVersion: 'llamactl/v1', kind: 'Composite', metadata: { name: 'mc', labels: {} }, spec: { components: [] } } as any,
      backend: { destroyCompositeBoundary: async () => {} } as any,
    } as any);
    const after = readGatewayCatalog('sirius');
    expect(after[0]!.name).toBe('mc-llama');
    expect((after[0] as any).ownership.compositeNames).toEqual(['other']);
  });

  test('triggers reload only when changed', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response('ok', { status: 200 });
    }) as any;
    // No composite-owned entries → no changes → no reload.
    await destroyComposite({
      manifest: { apiVersion: 'llamactl/v1', kind: 'Composite', metadata: { name: 'mc', labels: {} }, spec: { components: [] } } as any,
      backend: { destroyCompositeBoundary: async () => {} } as any,
    } as any);
    expect(calls.filter((c) => c.includes('/providers/reload')).length).toBe(0);
    expect(calls.filter((c) => c.includes('/config/reload')).length).toBe(0);
  });
});
```

The exact `destroyComposite` argument shape needs to match the implementation. Read it first:

```bash
sed -n '520,580p' packages/remote/src/composite/apply.ts
```

Adapt the test fixture to that signature.

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/composite-destroy-catalog-cleanup.test.ts`
Expected: FAIL — entries remain after destroy.

- [ ] **Step 3: Modify `destroyComposite` in `composite/apply.ts`**

Add catalog cleanup near the end of `destroyComposite`, after the existing teardown completes successfully. Pseudocode:

```ts
import { removeCompositeEntries, readGatewayCatalog, writeGatewayCatalog } from '../workload/gateway-catalog/index.js';

// At the end of destroyComposite, after existing cleanup logic:
for (const kind of ['sirius', 'embersynth'] as const) {
  const current = readGatewayCatalog(kind);
  const result = removeCompositeEntries({
    kind,
    compositeName: opts.manifest.metadata.name,
    current,
  });
  if (result.changed) {
    writeGatewayCatalog(kind, result.next as any);
    // Trigger reload on every node of this kind. The existing
    // composite-applier code already enumerates gateways per composite
    // entry via `dispatchGatewayApply`. For destroy, we issue a
    // bare reload by enumerating every node in kubeconfig with
    // `cloud.provider === <kind>` and POSTing the reload endpoint.
    // (See gateway-handlers/{sirius,embersynth}.ts for the reload
    //  URL shape and bearer auth handling — extract a shared
    //  helper if it isn't already.)
    await reloadAllGatewayNodesOfKind(kind);
  }
}
```

The `reloadAllGatewayNodesOfKind` helper does NOT need to live in this file — it's a small new helper in `packages/remote/src/workload/gateway-catalog/reload.ts` that:
1. Reads kubeconfig.
2. For every node where `resolveNodeKind(node) === 'gateway' && node.cloud?.provider === kind` and `cloud.baseUrl` is set:
3. Resolves bearer auth the same way both handlers do today.
4. POSTs `${baseUrl}/providers/reload` (sirius) or `${baseUrl}/config/reload` (embersynth).
5. Logs failures but doesn't throw — destroy is best-effort cleanup.

Implement this helper before adding the call in destroy. Check the kubeconfig path first:

```bash
grep -n "loadConfig\|currentContext" packages/remote/src/workload/gateway-handlers/sirius.ts | head -5
```

Use the same imports.

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/composite-destroy-catalog-cleanup.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Run full composite suite — no regressions**

Run: `bun test --cwd packages/remote test/composite-apply.test.ts test/composite-router.test.ts 2>&1 | tail -10`
Expected: All previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/remote/src/composite/apply.ts \
        packages/remote/src/workload/gateway-catalog/reload.ts \
        packages/remote/test/composite-destroy-catalog-cleanup.test.ts
git commit -m "feat(remote/composite): catalog cleanup on destroy with reload trigger"
```

---

## Task 11: Cross-repo precondition check (D8) and sweep

This task has no code change in llamactl. Its outcome is either (a) confirming sirius and embersynth schemas tolerate the new `ownership` field with no change, or (b) landing one-line `passthrough()` PRs in those repos.

- [ ] **Step 1: Inspect sirius's providers schema**

```bash
cd /Volumes/WorkSSD/repos/personal/sirius-gateway
grep -rn "z.object\|z.record\|providers:\|SiriusProvider\|ProviderSchema" libs/ apps/ --include="*.ts" 2>/dev/null | grep -i "provider" | head -20
```

Open the file. If the schema uses `.strict()` (rejects unknown keys), `ownership` will fail to parse on llamactl-authored entries. Mitigation: change `.strict()` to `.passthrough()`, or add the optional field explicitly. One-line PR.

If the schema is permissive (default Zod object) or uses `.passthrough()`, no change is needed.

- [ ] **Step 2: Inspect embersynth's nodes schema**

```bash
cd /Volumes/WorkSSD/repos/personal/embersynth
grep -rn "EmbersynthNode\|nodes:.*z.object\|NodeSchema" src/ --include="*.ts" 2>/dev/null | head -20
```

Same exercise. If `.strict()`, ship a `.passthrough()` PR. Otherwise no-op.

- [ ] **Step 3: If a sibling-repo change is needed, ship those PRs first**

Open the PRs separately per repo. Land them before merging the llamactl PR. Each is roughly:

```diff
- export const ProviderSchema = z.object({...}).strict();
+ export const ProviderSchema = z.object({...}).passthrough();
```

- [ ] **Step 4: Cross-repo regression sweep**

```bash
cd /Volumes/WorkSSD/repos/personal/llamactl       && bun test 2>&1 | tail -5
cd /Volumes/WorkSSD/repos/personal/sirius-gateway && bun test 2>&1 | tail -5
cd /Volumes/WorkSSD/repos/personal/embersynth     && bun test 2>&1 | tail -5
cd /Volumes/WorkSSD/repos/personal/nova           && bun test 2>&1 | tail -5
```

Expected: llamactl rises (new tests added in tasks 1–10); sirius / embersynth / nova unchanged from their existing tallies (1343 cross-repo total per `radiant-converging-knuth.md`, plus llamactl deltas).

- [ ] **Step 5: No commit needed in llamactl for this task** (the sibling PRs are separate)

If sibling changes were needed, note the PR URLs for the llamactl PR description.

---

## Task 12: Docs + tag + final validation

**Files:**
- Modify: `docs/composites.md`

- [ ] **Step 1: Update `docs/composites.md`**

Find the existing follow-up notes (around lines 287, 309–311 per the spec). Read them:

```bash
sed -n '280,320p' docs/composites.md
```

Replace the "documented follow-up" notes with a concise description of the auto-populate behavior:

```markdown
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
```

- [ ] **Step 2: Final regression sweep — full remote suite**

Run: `bun test --cwd packages/remote 2>&1 | tail -5`
Expected: All tests pass.

- [ ] **Step 3: Real typecheck — count unchanged from Task 1 baseline**

Run: `bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | wc -l`
Expected: equal to the count recorded in Task 1 step 10.

- [ ] **Step 4: Tag**

```bash
git add docs/composites.md
git commit -m "docs(composites): describe gateway catalog auto-populate"
git tag composite-gateway-auto-populate
```

- [ ] **Step 5: Hand off**

Open a PR titled `feat(remote): gateway catalog auto-populate from CompositeGatewayContext` against `main`. Body lists the spec link, summary of changes, the two new conflict reasons per gateway, and (if any) sibling-repo `passthrough()` PR links. Reviewer steps: full remote suite, then a manual end-to-end with one composite + sirius (or embersynth) gateway against a docker-compose'd backend to exercise apply → destroy → re-apply.

---

## Self-review checklist

**Spec coverage:**
- D1 (both gateways) → Tasks 8 (sirius), 9 (embersynth)
- D2 (ownership marker, ref-counted) → Task 1 (schema), Task 5 (apply union), Task 6 (remove ref-count)
- D3 (typed providerConfig) → Task 1 (schema + thread through types)
- D4 (pure llamactl-side) → Task 11 acknowledges precondition; no sibling code changes required
- D5 (gateway-catalog module) → Tasks 2–7
- D6 (conflict policy) → Task 5 (apply detects), Tasks 8, 9 (handlers translate to Pending)
- D7 (idempotency via specHash) → Task 4 (hash), Task 5 (no-op when same shape + same composite), Tasks 8, 9 (reload skip when !catalogChanged)
- D8 (sibling schema precondition) → Task 11
- Embersynth nodes-only scope per spec correction → Task 3 produces only EmbersynthNode entries; no syntheticModels mutation
- Conflict reasons named per spec → Tasks 8, 9 use `Sirius{Name|Shape}Collision`/`Mismatch` and `Embersynth{Name|Shape}Collision`/`Mismatch`
- Cleanup on destroy → Task 10
- Docs update → Task 12

**Placeholder scan:** Tasks 8, 9 reference an existing test pattern (kubeconfig stubbing) the engineer must replicate from `gateway-handlers.test.ts` — concrete grep command included. Task 10 instructs reading `composite/apply.ts:520-580` to match the actual `destroyComposite` signature — concrete command included. Task 11's outcome depends on what the engineer finds in the sibling repos — both branches (no change / one-line `.passthrough()` PR) are explicit. No open-ended "TODO" or "implement later" anywhere.

**Type consistency:** `CompositeOwnership`, `ProviderConfigCommon`, `ApplyConflict`, `DerivedSiriusEntry`, `DerivedEmbersynthEntry`, `ApplyResult`, `RemoveResult`, `GatewayKind` defined in Tasks 1, 2, 3, 5, 6, 7 — referenced unchanged in Tasks 8, 9, 10. Conflict reasons (`SiriusUpstreamNameCollision`, `SiriusUpstreamShapeMismatch`, `EmbersynthUpstreamNameCollision`, `EmbersynthUpstreamShapeMismatch`, `SiriusCatalogWriteFailed`, `EmbersynthCatalogWriteFailed`) are spelled identically across handler tasks and the docs update. The `kind: 'sirius' | 'embersynth'` discriminator is consistent throughout `apply.ts`, `remove.ts`, `io.ts`, the handlers, and the destroy cleanup.
