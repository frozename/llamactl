# Multi-Workload Local Nodes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow multiple `llama-server` processes per local node, each owned by its own `ModelRun` manifest, so applying one workload doesn't evict another.

**Architecture:** Move runtime state from a per-node singleton (`runtime/llama-server.{pid,state,log}`) to per-workload directories (`runtime/workloads/<name>/...`). Re-key `packages/core/src/server.ts` APIs by a required `WorkloadKey`. Rewrite `applyOne()` so it only ever touches the manifest's own server; add a disabled short-circuit, opt-in `--evict`, and a soft RAM admission check. CLI gains `enable`/`disable` verbs.

**Tech Stack:** Bun 1.3+, TypeScript, tRPC v11, Zod 4.3+, bun:test, llama.cpp.

**Spec:** `docs/superpowers/specs/2026-05-13-multi-local-workloads-design.md`

**Success criteria:**
- Applying a Granite manifest while Gemma is running on a different port leaves Gemma untouched.
- `bun test` green across `packages/core`, `packages/remote`, `packages/cli`.
- `bun run --cwd packages/remote tsc --noEmit` green; same for `core`, `cli`, `app`.
- `zsh test/run-all.zsh` passes including the new multi-workload shell smoke.
- Migration: an agent daemon upgraded in place finds its old `llama-server.pid` and either re-homes it under the matching workload or under a synthetic `imperative-*` manifest, with no loss of a running process.

**Phasing.** Tasks 1–9 deliver the bug fix (Phases 1–2 in the spec). Tasks 10–14 are operator UX (Phase 3). Tasks 15–17 are integration + cross-repo verification. Each phase ends with `bun test`, tsc, and a checkpoint commit.

---

## Phase 1 — Schema + per-workload runtime state

### Task 1: Manifest schema additions

**Files:**
- Modify: `packages/remote/src/workload/schema.ts`
- Modify: `packages/remote/src/workload/noderun-schema.ts`
- Test: `packages/remote/src/workload/schema.test.ts`

- [ ] **Step 1: Write failing test for new fields**

Append to `packages/remote/src/workload/schema.test.ts` (or create if absent):

```typescript
import { expect, test } from 'bun:test';
import { ModelRunSchema } from './schema.js';
import { NodeRunSchema } from './noderun-schema.js';

test('ModelRun parses spec.enabled defaulting to true', () => {
  const m = ModelRunSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: 'a' },
    spec: { node: 'local', target: { kind: 'rel', value: 'm.gguf' } },
  });
  expect(m.spec.enabled).toBe(true);
});

test('ModelRun accepts spec.enabled=false', () => {
  const m = ModelRunSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: 'a' },
    spec: {
      node: 'local',
      target: { kind: 'rel', value: 'm.gguf' },
      enabled: false,
    },
  });
  expect(m.spec.enabled).toBe(false);
});

test('ModelRun parses spec.resources.expectedMemoryGiB', () => {
  const m = ModelRunSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: 'a' },
    spec: {
      node: 'local',
      target: { kind: 'rel', value: 'm.gguf' },
      resources: { expectedMemoryGiB: 8.5 },
    },
  });
  expect(m.spec.resources?.expectedMemoryGiB).toBe(8.5);
});

test('ModelRun parses metadata.annotations defaulting to {}', () => {
  const m = ModelRunSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'ModelRun',
    metadata: { name: 'a', annotations: { 'llamactl.io/evict': 'old' } },
    spec: { node: 'local', target: { kind: 'rel', value: 'm.gguf' } },
  });
  expect(m.metadata.annotations).toEqual({ 'llamactl.io/evict': 'old' });
});

test('NodeRun parses spec.budget.memoryGiB', () => {
  const n = NodeRunSchema.parse({
    apiVersion: 'llamactl/v1',
    kind: 'NodeRun',
    metadata: { name: 'local' },
    spec: { kind: 'agent', endpoint: 'http://127.0.0.1:7878', budget: { memoryGiB: 36 } },
  });
  expect(n.spec.budget?.memoryGiB).toBe(36);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test packages/remote/src/workload/schema.test.ts`
Expected: FAIL — fields missing on schemas.

- [ ] **Step 3: Add fields to ModelRunSpec + metadata**

In `packages/remote/src/workload/schema.ts`, extend `ModelRunMetadataSchema`:

```typescript
export const ModelRunMetadataSchema = z.object({
  name: z.string().regex(/^[a-z0-9][-a-z0-9]{0,62}$/,
    'name must be lowercase alphanumeric with dashes, max 63 chars'),
  labels: z.record(z.string(), z.string()).default({}),
  annotations: z.record(z.string(), z.string()).default({}),
});
```

Add to `ModelRunSpecSchema`:

```typescript
enabled: z.boolean().default(true),
resources: z.object({
  expectedMemoryGiB: z.number().positive().optional(),
}).optional(),
```

Place `enabled` right after `node`; `resources` after `restartPolicy`. Keep existing fields in place.

- [ ] **Step 4: Add budget to NodeRunSpec**

Inspect `packages/remote/src/workload/noderun-schema.ts` and extend its spec schema:

```typescript
budget: z.object({
  memoryGiB: z.number().positive(),
}).optional(),
```

- [ ] **Step 5: Re-run tests**

Run: `bun test packages/remote/src/workload/schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Run package tsc and full bun test**

```bash
bun run --cwd packages/remote tsc --noEmit
bun test
```
Expected: green. If a downstream consumer of `ModelRun`/`NodeRun` types fails to typecheck, that's the next task — note it and proceed; the new fields are additive and optional/defaulted so this should compile.

- [ ] **Step 7: Commit**

```bash
git add packages/remote/src/workload/schema.ts packages/remote/src/workload/noderun-schema.ts packages/remote/src/workload/schema.test.ts
git commit -m "feat(workload): add spec.enabled, spec.resources, metadata.annotations, NodeRun.budget"
```

---

### Task 2: Workload runtime directory helpers

**Files:**
- Create: `packages/core/src/workloadRuntime.ts`
- Test: `packages/core/test/workloadRuntime.test.ts`

This is the "key by workload name" abstraction the rest of the refactor stands on.

- [ ] **Step 1: Write failing test**

Create `packages/core/test/workloadRuntime.test.ts`:

```typescript
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  workloadRuntimeDir,
  listLocalWorkloads,
  ensureWorkloadRuntimeDir,
} from '../src/workloadRuntime.js';

const tempEnv = () => {
  const dir = mkdtempSync(join(tmpdir(), 'workloadrt-'));
  return {
    runtimeDir: dir,
    resolved: { LOCAL_AI_RUNTIME_DIR: dir } as any,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

test('workloadRuntimeDir composes the expected path', () => {
  const t = tempEnv();
  try {
    expect(workloadRuntimeDir(t.resolved, { name: 'gemma' })).toBe(
      join(t.runtimeDir, 'workloads', 'gemma'),
    );
  } finally {
    t.cleanup();
  }
});

test('ensureWorkloadRuntimeDir creates the directory', () => {
  const t = tempEnv();
  try {
    const d = ensureWorkloadRuntimeDir(t.resolved, { name: 'gemma' });
    expect(existsSync(d)).toBe(true);
  } finally {
    t.cleanup();
  }
});

test('listLocalWorkloads returns names of workload subdirs with pidfiles', () => {
  const t = tempEnv();
  try {
    const a = join(t.runtimeDir, 'workloads', 'a');
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, 'llama-server.pid'), '99999\n');
    mkdirSync(join(t.runtimeDir, 'workloads', 'b'), { recursive: true });
    const entries = listLocalWorkloads(t.resolved);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['a']); // b has no pidfile → excluded
    expect(entries[0].pid).toBe(99999);
    expect(entries[0].alive).toBe(false); // pid 99999 won't exist
  } finally {
    t.cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test packages/core/test/workloadRuntime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement workloadRuntime.ts**

Create `packages/core/src/workloadRuntime.ts`:

```typescript
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedEnv } from './types.js';
import { resolveEnv } from './env.js';

export interface WorkloadKey {
  name: string;
}

export interface WorkloadRuntimeEntry {
  name: string;
  pid: number | null;
  alive: boolean;
}

export function workloadRuntimeRoot(
  resolved: ResolvedEnv = resolveEnv(),
): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, 'workloads');
}

export function workloadRuntimeDir(
  resolved: ResolvedEnv,
  key: WorkloadKey,
): string {
  return join(workloadRuntimeRoot(resolved), key.name);
}

export function ensureWorkloadRuntimeDir(
  resolved: ResolvedEnv,
  key: WorkloadKey,
): string {
  const dir = workloadRuntimeDir(resolved, key);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listLocalWorkloads(
  resolved: ResolvedEnv = resolveEnv(),
): WorkloadRuntimeEntry[] {
  const root = workloadRuntimeRoot(resolved);
  if (!existsSync(root)) return [];
  const entries: WorkloadRuntimeEntry[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const pidPath = join(root, dirent.name, 'llama-server.pid');
    if (!existsSync(pidPath)) continue;
    let pid: number | null = null;
    try {
      const raw = readFileSync(pidPath, 'utf8').trim();
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) pid = n;
    } catch {
      pid = null;
    }
    entries.push({
      name: dirent.name,
      pid,
      alive: pid !== null && isProcessAlive(pid),
    });
  }
  return entries;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun test packages/core/test/workloadRuntime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workloadRuntime.ts packages/core/test/workloadRuntime.test.ts
git commit -m "feat(core): add workload runtime dir helpers + listLocalWorkloads"
```

---

### Task 3: Re-key `packages/core/src/server.ts` by WorkloadKey

This is the structural refactor. All public APIs that today take `resolved?: ResolvedEnv` gain a required first parameter `key: WorkloadKey`. PID/state/log paths derive from `workloadRuntimeDir(resolved, key)`.

**Files:**
- Modify: `packages/core/src/server.ts`
- Modify: `packages/core/test/server.test.ts`

- [ ] **Step 1: Update server.ts internal helpers to accept WorkloadKey**

Replace the path helpers at the top of `packages/core/src/server.ts`:

```typescript
import type { WorkloadKey } from './workloadRuntime.js';
import { workloadRuntimeDir, ensureWorkloadRuntimeDir } from './workloadRuntime.js';

function pidFile(resolved: ResolvedEnv, key: WorkloadKey): string {
  return join(workloadRuntimeDir(resolved, key), 'llama-server.pid');
}

function serverLog(resolved: ResolvedEnv, key: WorkloadKey): string {
  return join(workloadRuntimeDir(resolved, key), 'llama-server.log');
}

function serverStateFile(resolved: ResolvedEnv, key: WorkloadKey): string {
  return join(workloadRuntimeDir(resolved, key), 'llama-server.state');
}
```

Delete the old single-arg versions of each.

- [ ] **Step 2: Update exported APIs to require WorkloadKey**

Change every exported function signature in `server.ts` to take `key: WorkloadKey` as the **first** required argument (push `resolved` to second-with-default). Affected exports:

- `readServerPid(key, resolved?)`
- `readServerState(key, resolved?)`
- `serverStatus(key, resolved?)`
- `startServer(key, opts)` — also propagate `key` into `StartServerOptions` usage internally
- `stopServer(key, opts?)` — similarly
- `endpoint(...)` and `advertisedEndpoint(...)` keep their signatures (don't depend on the pid path).

Inside each, replace `pidFile(resolved)` with `pidFile(resolved, key)`, same for `serverLog` and `serverStateFile`. Add an `ensureWorkloadRuntimeDir(resolved, key)` call inside `writeServerPid` and `writeServerState` (replacing the old `mkdirSync(resolved.LOCAL_AI_RUNTIME_DIR, ...)`).

Internal helpers that need the key:

```typescript
function writeServerPid(resolved: ResolvedEnv, key: WorkloadKey, pid: number): void {
  ensureWorkloadRuntimeDir(resolved, key);
  writeFileSync(pidFile(resolved, key), `${pid}\n`);
}

function removeServerPid(resolved: ResolvedEnv, key: WorkloadKey): void {
  try { unlinkSync(pidFile(resolved, key)); } catch { /* no-op */ }
}

function writeServerState(resolved: ResolvedEnv, key: WorkloadKey, state: ServerState): void {
  ensureWorkloadRuntimeDir(resolved, key);
  writeFileSync(serverStateFile(resolved, key), JSON.stringify(state, null, 2));
}

function removeServerState(resolved: ResolvedEnv, key: WorkloadKey): void {
  try { unlinkSync(serverStateFile(resolved, key)); } catch { /* no-op */ }
}
```

- [ ] **Step 3: Update `StartServerOptions` to include the key**

```typescript
export interface StartServerOptions {
  key: WorkloadKey;       // required
  resolved?: ResolvedEnv; // optional
  // ...existing fields
}
```

Internally `startServer(opts)` reads `opts.key`. Adjust the recursive retry path (around line 600 in current file) to pass the same key.

`stopServer` similarly:

```typescript
export interface StopServerOptions {
  key: WorkloadKey;
  resolved?: ResolvedEnv;
  graceSeconds?: number;
}
```

- [ ] **Step 4: Rewrite the existing server tests against the new API**

`packages/core/test/server.test.ts` writes to `temp.runtimeDir/llama-server.pid` directly. Move those writes to per-workload subdirs. Example:

```typescript
import { workloadRuntimeDir } from '../src/workloadRuntime.js';
import { mkdirSync } from 'node:fs';

const KEY = { name: 'test-wl' };
const wlDir = workloadRuntimeDir(temp.resolved, KEY);
mkdirSync(wlDir, { recursive: true });
writeFileSync(join(wlDir, 'llama-server.pid'), '42\n');

expect(readServerPid(KEY, temp.resolved)).toBe(42);
```

Apply the same pattern to every call site in `server.test.ts`. Helper `temp` already lives in `packages/core/test/helpers.ts`.

- [ ] **Step 5: Add new test — isolation between workloads**

Append to `packages/core/test/server.test.ts`:

```typescript
test('writeServerState for workload A does not affect workload B', () => {
  const temp = createTempEnv();
  const A = { name: 'a' };
  const B = { name: 'b' };
  // Write A only
  const state: ServerState = {
    rel: 'a.gguf', extraArgs: [], host: '127.0.0.1', port: '8181',
    binary: '/bin/llama-server', pid: 1, startedAt: 'now', tunedProfile: null,
  };
  // Use the test seam (or a small writeServerStateForTest helper if private)
  // Quickest path: just call startServer with a mock spawn — see existing tests.
  // For unit-level: write directly via fs to the workload dir.
  const aDir = ensureWorkloadRuntimeDir(temp.resolved, A);
  writeFileSync(join(aDir, 'llama-server.state'), JSON.stringify(state));
  writeFileSync(join(aDir, 'llama-server.pid'), '1\n');

  expect(readServerState(A, temp.resolved)).toBeTruthy();
  expect(readServerState(B, temp.resolved)).toBe(null);
});
```

- [ ] **Step 5: Run server tests**

Run: `bun test packages/core/test/server.test.ts`
Expected: PASS. If any callers in `packages/core/src/` use the old API surface (e.g. `keepAlive.ts` calling `serverStatus()` without args), they will fail to typecheck — that becomes the next task.

- [ ] **Step 6: Run core tsc + bun test**

```bash
bun run --cwd packages/core tsc --noEmit
bun test packages/core
```

If `keepAlive.ts` or other in-package callers break, fix them in this commit by threading a workload key down. For `keepAlive.ts`, the proxy is per-workload now — add a `key: WorkloadKey` field to its state and persist it. Apply the smallest mechanical change consistent with the new shape.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/server.ts packages/core/src/keepAlive.ts packages/core/test/server.test.ts
git commit -m "refactor(core): re-key server lifecycle APIs by WorkloadKey"
```

---

### Task 4: Migration helper for legacy singleton runtime state

**Files:**
- Modify: `packages/core/src/workloadRuntime.ts`
- Test: `packages/core/test/workloadRuntime.test.ts`

- [ ] **Step 1: Write failing migration test**

Append to `packages/core/test/workloadRuntime.test.ts`:

```typescript
import { migrateLegacySingletonRuntime } from '../src/workloadRuntime.js';

test('migrateLegacySingletonRuntime moves files under a matching workload dir', () => {
  const t = tempEnv();
  try {
    // Legacy paths
    writeFileSync(join(t.runtimeDir, 'llama-server.pid'), '999999\n');
    writeFileSync(join(t.runtimeDir, 'llama-server.state'), JSON.stringify({
      rel: 'granite/granite-4.1-8b-Q4_K_M.gguf', extraArgs: ['--ctx-size','4096'],
      host: '127.0.0.1', port: '8181', binary: '/x/llama-server',
      pid: 999999, startedAt: 't', tunedProfile: null,
    }));
    writeFileSync(join(t.runtimeDir, 'llama-server.log'), 'old log');

    const out = migrateLegacySingletonRuntime(t.resolved, [
      { name: 'granite-8b', spec: { node: 'local', target: { kind: 'rel', value: 'granite/granite-4.1-8b-Q4_K_M.gguf' }, endpoint: { port: 8181 } } } as any,
    ]);

    expect(out.kind).toBe('migrated');
    if (out.kind === 'migrated') expect(out.workload).toBe('granite-8b');

    const dest = join(t.runtimeDir, 'workloads', 'granite-8b');
    expect(existsSync(join(dest, 'llama-server.pid'))).toBe(true);
    expect(existsSync(join(dest, 'llama-server.state'))).toBe(true);
    expect(existsSync(join(dest, 'llama-server.log'))).toBe(true);
    expect(existsSync(join(t.runtimeDir, 'llama-server.pid'))).toBe(false);
    expect(existsSync(join(t.runtimeDir, '.migrated-v2'))).toBe(true);
  } finally {
    t.cleanup();
  }
});

test('migrateLegacySingletonRuntime synthesizes an imperative workload when no manifest matches', () => {
  const t = tempEnv();
  try {
    writeFileSync(join(t.runtimeDir, 'llama-server.pid'), '999999\n');
    writeFileSync(join(t.runtimeDir, 'llama-server.state'), JSON.stringify({
      rel: 'orphan/orphan.gguf', extraArgs: [], host: '127.0.0.1', port: '9999',
      binary: '/x/llama-server', pid: 999999, startedAt: 't', tunedProfile: null,
    }));
    const out = migrateLegacySingletonRuntime(t.resolved, []);
    expect(out.kind).toBe('synthesized');
    if (out.kind === 'synthesized') expect(out.workload).toMatch(/^imperative-\d+$/);
  } finally {
    t.cleanup();
  }
});

test('migrateLegacySingletonRuntime is a no-op on second invocation (.migrated-v2)', () => {
  const t = tempEnv();
  try {
    writeFileSync(join(t.runtimeDir, '.migrated-v2'), '');
    writeFileSync(join(t.runtimeDir, 'llama-server.pid'), '1\n'); // pretend leftover
    const out = migrateLegacySingletonRuntime(t.resolved, []);
    expect(out.kind).toBe('skipped');
  } finally {
    t.cleanup();
  }
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `bun test packages/core/test/workloadRuntime.test.ts`
Expected: FAIL — `migrateLegacySingletonRuntime` not exported.

- [ ] **Step 3: Implement migration**

Append to `packages/core/src/workloadRuntime.ts`:

```typescript
import { renameSync, unlinkSync } from 'node:fs';

export type MigrationResult =
  | { kind: 'skipped' }                              // .migrated-v2 already exists
  | { kind: 'no-legacy' }                            // no legacy pid present
  | { kind: 'migrated'; workload: string }
  | { kind: 'synthesized'; workload: string };

interface MinimalManifestForMigration {
  metadata: { name: string };
  spec: {
    node: string;
    target: { kind: 'rel' | 'alias'; value: string };
    endpoint?: { host?: string; port?: number };
  };
}

export function migrateLegacySingletonRuntime(
  resolved: ResolvedEnv,
  manifests: MinimalManifestForMigration[],
): MigrationResult {
  const root = resolved.LOCAL_AI_RUNTIME_DIR;
  const flag = join(root, '.migrated-v2');
  if (existsSync(flag)) return { kind: 'skipped' };

  const legacyPid = join(root, 'llama-server.pid');
  const legacyState = join(root, 'llama-server.state');
  const legacyLog = join(root, 'llama-server.log');
  if (!existsSync(legacyPid) && !existsSync(legacyState)) {
    writeFileSync(flag, '');
    return { kind: 'no-legacy' };
  }

  let stateRel: string | null = null;
  let statePort: number | null = null;
  try {
    const raw = readFileSync(legacyState, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.rel === 'string') stateRel = parsed.rel;
    if (typeof parsed.port === 'string') statePort = Number.parseInt(parsed.port, 10);
  } catch { /* leave nulls */ }

  // Match: same target.value, and (port matches OR no port declared on manifest)
  const match = manifests.find((m) =>
    m.spec.target.value === stateRel &&
    (m.spec.endpoint?.port === undefined || m.spec.endpoint.port === statePort),
  );

  const workloadName = match?.metadata.name ?? `imperative-${Date.now()}`;
  const destDir = ensureWorkloadRuntimeDir(resolved, { name: workloadName });

  const moveIfExists = (src: string, dstName: string) => {
    if (existsSync(src)) {
      try { renameSync(src, join(destDir, dstName)); }
      catch { /* leave it; operator can clean up */ }
    }
  };
  moveIfExists(legacyPid, 'llama-server.pid');
  moveIfExists(legacyState, 'llama-server.state');
  moveIfExists(legacyLog, 'llama-server.log');

  writeFileSync(flag, '');
  return match
    ? { kind: 'migrated', workload: workloadName }
    : { kind: 'synthesized', workload: workloadName };
}
```

Add `readFileSync`, `writeFileSync` to the `node:fs` imports at the top of the file if not already present.

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/test/workloadRuntime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workloadRuntime.ts packages/core/test/workloadRuntime.test.ts
git commit -m "feat(core): legacy singleton → per-workload runtime migration helper"
```

---

### Task 5: Update tRPC procedures to take a workload argument

**Files:**
- Modify: `packages/remote/src/router.ts`
- Test: `packages/remote/src/router.test.ts` (or whichever file exercises router procedures — check first)

- [ ] **Step 1: Update procedure signatures**

In `packages/remote/src/router.ts`:

```typescript
// existing (no input):
serverStatus: t.procedure.query(async () => serverMod.serverStatus()),

// new:
const WorkloadInput = z.object({ workload: z.string().min(1) });

serverStatus: t.procedure
  .input(WorkloadInput)
  .query(async ({ input }) => serverMod.serverStatus({ name: input.workload })),

serverStop: t.procedure
  .input(WorkloadInput.extend({ graceSeconds: z.number().int().positive().optional() }))
  .mutation(async ({ input }) =>
    serverMod.stopServer({ key: { name: input.workload }, graceSeconds: input.graceSeconds }),
  ),

serverStart: t.procedure
  .input(WorkloadInput.extend({
    target: z.string(),
    extraArgs: z.array(z.string()).optional(),
    endpoint: z.object({ host: z.string().optional(), port: z.number().int().optional() }).optional(),
    binary: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  }))
  .mutation(async ({ input }) => {
    const result = await serverMod.startServer({
      key: { name: input.workload },
      // ...thread the rest of input into the existing options shape
    });
    // ...rest unchanged
  }),
```

Find the existing `serverStart`/`serverStop`/`serverStatus` procedures in `router.ts` and replace them with the shapes above, preserving any current behavior (e.g., event subscription bridges).

- [ ] **Step 2: Update in-router call sites of `serverStatus`/`serverStop`**

`router.ts` has chat/keep-alive proxy paths that currently call `client.serverStatus.query()` (lines ~1041, 1081, 1152, 1154). Each one needs a workload identity. For now, plumb the workload through from the chat/keep-alive request envelope; for paths that don't yet carry one, derive it from the manifest store (call `listWorkloads()` and pick the single live workload on that node, error if ambiguous).

Implementation sketch — wrap the calls in a helper:

```typescript
async function pickWorkloadForChat(
  client: WorkloadClient,
  nodeName: string,
): Promise<string> {
  const manifests = listWorkloads().filter((m) => m.spec.node === nodeName && m.spec.enabled !== false);
  if (manifests.length === 1) return manifests[0].metadata.name;
  // Multiple live → caller must specify; throw a typed error the chat code surfaces.
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: `node ${nodeName} has ${manifests.length} workloads; specify which to chat with`,
  });
}

// Then at each call site:
const wl = await pickWorkloadForChat(client, nodeName);
const status = await client.serverStatus.query({ workload: wl });
```

Replace every `client.serverStatus.query()` and `client.serverStop.mutate(...)` in `router.ts` with workload-aware variants. Keep the line-of-sight: each chat session should carry the workload it was opened against.

- [ ] **Step 3: Update `WorkloadClient` shape in `apply.ts`**

In `packages/remote/src/workload/apply.ts:17-31`, change `WorkloadClient`:

```typescript
export interface WorkloadClient {
  serverStatus: {
    query(input: { workload: string }): Promise<{
      state: 'up' | 'down';
      pid: number | null;
      rel: string | null;
      extraArgs: string[];
      host: string | null;
      port: number | null;
      binary: string | null;
      endpoint: string;
    }>;
  };
  serverStop: {
    mutate(input: { workload: string; graceSeconds?: number }): Promise<{ stopped: boolean }>;
  };
  serverStart: {
    mutate(input: {
      workload: string;
      target: string;
      extraArgs?: string[];
      endpoint?: { host?: string; port?: number };
      binary?: string;
      timeoutSeconds?: number;
    }): Promise<{ /* existing shape */ }>;
  };
  // ...existing rpcServerStart, rpcServerStop, rpcServerStatus, rpcServerDoctor unchanged
}
```

`applyOne()` still passes `manifest.metadata.name` as the workload argument — done in Task 9. For now, ensure typecheck.

- [ ] **Step 4: Verify**

```bash
bun run --cwd packages/remote tsc --noEmit
bun test packages/remote
```

Expected: green. Errors that surface in chat/keep-alive call sites (router.ts) are fixed in this same commit per Step 2.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/router.ts packages/remote/src/workload/apply.ts
git commit -m "feat(remote): workload param on serverStatus/Start/Stop tRPC procedures"
```

---

### Task 6: Update CLI imperative server callers

**Files:**
- Modify: `packages/cli/src/commands/server.ts` (or wherever imperative `server start/stop/status` lives — `grep -rn "serverMod\." packages/cli/src/`)
- Modify: `packages/cli/src/commands/expose.ts`
- Modify: `packages/cli/src/commands/workload.ts` (calls `serverStatus.query()` at lines 274, 382, 444)

- [ ] **Step 1: Locate imperative server commands**

```bash
grep -rn "serverMod\.\|llamactl server" packages/cli/src/
```

For each call to `serverStatus.query()` / `serverStop.mutate(...)` / `serverStart.mutate(...)`, the workload identity comes from one of:
- A manifest in scope (`packages/cli/src/commands/workload.ts` already has `manifest.metadata.name`).
- A `--name <workload>` flag for imperative server commands.

- [ ] **Step 2: Add `--name` to imperative server commands**

In the imperative `server start/stop/status` command files, parse a new flag:

```typescript
const NAME_HELP = `--name=<workload>  workload identity (required when more than one is live)`;
```

Resolve the workload:

```typescript
import { listLocalWorkloads } from '@llamactl/core';

function resolveWorkloadName(explicit: string | undefined, resolved: ResolvedEnv): string {
  if (explicit) return explicit;
  const live = listLocalWorkloads(resolved);
  if (live.length === 1) return live[0].name;
  if (live.length === 0) {
    // imperative start with no name: synthesize
    return `imperative-${Date.now()}`;
  }
  throw new Error(
    `multiple workloads live (${live.map(w => w.name).join(', ')}); pass --name <workload>`,
  );
}
```

For `server start` without a manifest: synthesize an `imperative-<unix-ms>` workload, persist a transient manifest via `store.writeWorkload(...)` so subsequent `apply`/`get`/`delete` work.

- [ ] **Step 3: Update workload.ts call sites**

Each `client.serverStatus.query()` becomes `client.serverStatus.query({ workload: manifest.metadata.name })`. There are three sites: ~274, ~382, ~444.

`expose.ts:172` — same change.

- [ ] **Step 4: Run cli tsc + tests**

```bash
bun run --cwd packages/cli tsc --noEmit
bun test packages/cli
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/
git commit -m "feat(cli): thread workload identity through imperative + workload commands"
```

---

### Task 7: Update Electron app + MCP callers

**Files:**
- Modify: `packages/app/src/` (search for `serverStatus`)
- Modify: `packages/mcp/` (search for `serverStatus|serverStart|serverStop`)
- Modify: `packages/remote/src/ops-chat/dispatch.ts:178`

- [ ] **Step 1: Find all callers**

```bash
grep -rn "serverStatus\.\|serverStop\.\|serverStart\." packages/app/src/ packages/mcp/src/ packages/agents/src/ packages/remote/src/ops-chat/
```

- [ ] **Step 2: Thread workload identity**

For each call site, derive the workload name from the nearest context:
- Chat panel: the workload the user picked in the dropdown (Task 13 adds the UI; for this task just take it from a prop/arg, default to the single live workload if exactly one).
- MCP `llamactl.server.status` tool: add a required `workload` argument. (Zod schema in the tool registration.)
- Ops-chat dispatch (`dispatch.ts:178`): take from the surrounding chat state.

The default-when-single-live behavior keeps existing usage working in the common case.

- [ ] **Step 3: Verify all packages typecheck**

```bash
bun run --cwd packages/app tsc --noEmit
bun run --cwd packages/mcp tsc --noEmit
bun run --cwd packages/remote tsc --noEmit
bun test
```

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/ packages/mcp/src/ packages/remote/src/ops-chat/
git commit -m "feat: thread workload identity through app/mcp/ops-chat callers"
```

---

### Task 8: Wire migration into agent daemon boot

**Files:**
- Modify: `packages/remote/src/server/serve.ts` (or whichever bootstraps the agent HTTPS server — `grep -n "agent\|listen\|serve" packages/remote/src/server/*.ts | head`)

- [ ] **Step 1: Add migration call to boot path**

In the agent daemon's startup function (right before it begins reconciling workloads):

```typescript
import { migrateLegacySingletonRuntime } from '@llamactl/core';
import { listWorkloads } from '../workload/store.js';
import { resolveEnv } from '@llamactl/core';

// ...inside boot
const resolved = resolveEnv();
const manifests = listWorkloads();
const result = migrateLegacySingletonRuntime(resolved, manifests);
if (result.kind === 'migrated') {
  console.log(`[migration] re-homed legacy runtime under workload '${result.workload}'`);
} else if (result.kind === 'synthesized') {
  console.log(`[migration] no manifest matched legacy state; synthesized '${result.workload}'`);
}
```

For the `synthesized` case, also write a transient manifest via `store.writeWorkload(...)` so the workload becomes first-class.

- [ ] **Step 2: Add a boot-time test**

Create or extend `packages/remote/src/server/serve.test.ts`:

```typescript
test('agent boot migrates legacy singleton runtime when present', async () => {
  // Set up a temp env, write legacy pid+state, boot the daemon, assert files moved.
  // ...follow existing patterns in serve.test.ts for env mocking + temp dirs.
});
```

- [ ] **Step 3: Run**

```bash
bun test packages/remote
```

- [ ] **Step 4: Commit**

```bash
git add packages/remote/src/server/serve.ts packages/remote/src/server/serve.test.ts
git commit -m "feat(remote): run legacy runtime migration on agent boot"
```

---

### Phase 1 checkpoint

```bash
bun run typecheck
bun run --cwd packages/remote tsc --noEmit
bun run --cwd packages/app tsc --noEmit
bun test
```

All green. Stop and let the user verify a real Granite manifest can still apply against the new state layout before moving on.

---

## Phase 2 — Apply semantics rewrite

### Task 9: Admission helper + memory estimator

**Files:**
- Create: `packages/remote/src/workload/admission.ts`
- Test: `packages/remote/src/workload/admission.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { expect, test } from 'bun:test';
import { computeNodeBudget, sumReservedForNode, type AdmissionInput } from './admission.js';

const mkManifest = (name: string, opts: Partial<{ enabled: boolean; expectedMemoryGiB: number; node: string }> = {}) => ({
  apiVersion: 'llamactl/v1' as const,
  kind: 'ModelRun' as const,
  metadata: { name, labels: {}, annotations: {} },
  spec: {
    node: opts.node ?? 'local',
    target: { kind: 'rel' as const, value: 'x.gguf' },
    extraArgs: [],
    workers: [],
    restartPolicy: 'Always' as const,
    gateway: false,
    enabled: opts.enabled ?? true,
    timeoutSeconds: 60,
    resources: opts.expectedMemoryGiB !== undefined
      ? { expectedMemoryGiB: opts.expectedMemoryGiB }
      : undefined,
  },
});

test('sumReservedForNode sums expectedMemoryGiB for enabled manifests on the node', () => {
  const all = [
    mkManifest('a', { expectedMemoryGiB: 8 }),
    mkManifest('b', { expectedMemoryGiB: 16 }),
    mkManifest('c', { expectedMemoryGiB: 4, enabled: false }), // excluded
    mkManifest('d', { expectedMemoryGiB: 2, node: 'mac-mini' }), // excluded
  ];
  expect(sumReservedForNode(all, 'local')).toBe(24);
});

test('admission returns ok when within budget', () => {
  const input: AdmissionInput = {
    nodeName: 'local',
    nodeBudgetGiB: 36,
    livingManifests: [mkManifest('a', { expectedMemoryGiB: 8 })],
    incoming: mkManifest('b', { expectedMemoryGiB: 16 }),
    forceAdmit: false,
  };
  expect(computeNodeBudget(input)).toEqual({ ok: true, reservedAfter: 24, budget: 36 });
});

test('admission returns over-budget when sum exceeds budget without force', () => {
  const input: AdmissionInput = {
    nodeName: 'local',
    nodeBudgetGiB: 20,
    livingManifests: [mkManifest('a', { expectedMemoryGiB: 16 })],
    incoming: mkManifest('b', { expectedMemoryGiB: 8 }),
    forceAdmit: false,
  };
  const r = computeNodeBudget(input);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reservedAfter).toBe(24);
});

test('admission ok when force-admit set even if over budget', () => {
  const input: AdmissionInput = {
    nodeName: 'local',
    nodeBudgetGiB: 10,
    livingManifests: [],
    incoming: mkManifest('a', { expectedMemoryGiB: 30 }),
    forceAdmit: true,
  };
  expect(computeNodeBudget(input).ok).toBe(true);
});
```

- [ ] **Step 2: Confirm failure**

Run: `bun test packages/remote/src/workload/admission.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement admission.ts**

```typescript
import type { ModelRun } from './schema.js';

export interface AdmissionInput {
  nodeName: string;
  nodeBudgetGiB: number;
  /** Currently-living manifests on the node, EXCLUDING any just evicted and EXCLUDING the incoming. */
  livingManifests: ModelRun[];
  incoming: ModelRun;
  forceAdmit: boolean;
}

export type AdmissionResult =
  | { ok: true; reservedAfter: number; budget: number }
  | { ok: false; reservedAfter: number; budget: number; reason: string };

export function sumReservedForNode(manifests: ModelRun[], nodeName: string): number {
  let sum = 0;
  for (const m of manifests) {
    if (m.spec.node !== nodeName) continue;
    if (m.spec.enabled === false) continue;
    sum += m.spec.resources?.expectedMemoryGiB ?? 0;
  }
  return sum;
}

export function computeNodeBudget(input: AdmissionInput): AdmissionResult {
  const reservedAfter =
    sumReservedForNode(input.livingManifests, input.nodeName) +
    (input.incoming.spec.resources?.expectedMemoryGiB ?? 0);
  if (input.forceAdmit) return { ok: true, reservedAfter, budget: input.nodeBudgetGiB };
  if (reservedAfter > input.nodeBudgetGiB) {
    return {
      ok: false,
      reservedAfter,
      budget: input.nodeBudgetGiB,
      reason: `node '${input.nodeName}' would reserve ${reservedAfter.toFixed(1)} GiB (> ${input.nodeBudgetGiB.toFixed(1)} GiB budget)`,
    };
  }
  return { ok: true, reservedAfter, budget: input.nodeBudgetGiB };
}
```

- [ ] **Step 4: Add memory estimator**

Append to `admission.ts`:

```typescript
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedEnv } from '@llamactl/core';

export function estimateWorkloadMemoryGiB(
  manifest: ModelRun,
  resolved: ResolvedEnv,
): number | null {
  if (manifest.spec.gateway) return null;
  if (manifest.spec.target.kind !== 'rel') return null;
  const ggufPath = join(resolved.LLAMA_CPP_MODELS, manifest.spec.target.value);
  try {
    const sz = statSync(ggufPath).size;
    return (sz * 1.1) / (1024 ** 3); // GGUF size + 10% headroom
  } catch {
    return null;
  }
}
```

A more sophisticated KV-cache estimate is out of scope (see spec).

- [ ] **Step 5: Tests for estimator** — keep it light, but cover at minimum:

```typescript
test('estimateWorkloadMemoryGiB returns null for gateway workloads', () => {
  const m = mkManifest('a');
  m.spec.gateway = true;
  expect(estimateWorkloadMemoryGiB(m, { LLAMA_CPP_MODELS: '/nonexistent' } as any)).toBe(null);
});

test('estimateWorkloadMemoryGiB returns null when file is missing', () => {
  expect(
    estimateWorkloadMemoryGiB(mkManifest('a'), { LLAMA_CPP_MODELS: '/nonexistent' } as any),
  ).toBe(null);
});
```

(File-present case is covered by integration tests in Task 17.)

- [ ] **Step 6: Pass**

Run: `bun test packages/remote/src/workload/admission.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/remote/src/workload/admission.ts packages/remote/src/workload/admission.test.ts
git commit -m "feat(workload): admission helper + GGUF-size memory estimator"
```

---

### Task 10: Rewrite `applyOne()` with new semantics

**Files:**
- Modify: `packages/remote/src/workload/apply.ts`
- Test: `packages/remote/src/workload/apply.test.ts` (or new file `apply.multi.test.ts`)

This is the heart of the change. Read `applyOne()` in full first (currently `packages/remote/src/workload/apply.ts:261-524`) before editing.

- [ ] **Step 1: Write failing tests for the four new behaviors**

Create `packages/remote/src/workload/apply.multi.test.ts`:

```typescript
import { expect, test, mock } from 'bun:test';
import { applyOne } from './apply.js';
import type { ModelRun } from './schema.js';

// Helper: build a fake WorkloadClient backed by a per-workload in-memory state map.
function makeClient(state: Map<string, { up: boolean; rel: string; args: string[] }>): any {
  return {
    serverStatus: { query: async ({ workload }: { workload: string }) => {
      const s = state.get(workload);
      return s
        ? { state: 'up', pid: 1, rel: s.rel, extraArgs: s.args, host: '127.0.0.1', port: 8181, binary: null, endpoint: 'http://127.0.0.1:8181' }
        : { state: 'down', pid: null, rel: null, extraArgs: [], host: null, port: null, binary: null, endpoint: 'http://127.0.0.1:8181' };
    }},
    serverStop: { mutate: async ({ workload }: any) => { state.delete(workload); return { stopped: true }; }},
    serverStart: { mutate: async ({ workload, target, extraArgs }: any) => {
      state.set(workload, { up: true, rel: target, args: extraArgs ?? [] });
      return { pid: 100, endpoint: 'http://127.0.0.1:8181' };
    }},
  };
}

const mkManifest = (name: string, overrides: Partial<ModelRun['spec'] & { annotations?: Record<string,string>; enabled?: boolean }> = {}): ModelRun => ({
  apiVersion: 'llamactl/v1',
  kind: 'ModelRun',
  metadata: { name, labels: {}, annotations: overrides.annotations ?? {} },
  spec: {
    node: 'local',
    target: { kind: 'rel', value: overrides.target ? (overrides.target as any).value : `${name}.gguf` },
    extraArgs: [], workers: [], restartPolicy: 'Always', gateway: false,
    enabled: overrides.enabled ?? true, timeoutSeconds: 60,
    endpoint: { host: '127.0.0.1', port: 8181 },
    resources: { expectedMemoryGiB: 8 },
    ...(overrides as any),
  } as any,
});

test('disabled manifest stops the server if running and reports Disabled', async () => {
  const state = new Map([['a', { up: true, rel: 'a.gguf', args: [] }]]);
  const result = await applyOne(
    mkManifest('a', { enabled: false, endpoint: { port: 8181 } }),
    () => makeClient(state),
  );
  expect(result.statusSection.phase).toBe('Stopped');
  expect(result.statusSection.conditions[0].reason).toBe('Disabled');
  expect(state.has('a')).toBe(false);
});

test('parallel apply does not stop other workloads on the node', async () => {
  const state = new Map([['a', { up: true, rel: 'a.gguf', args: [] }]]);
  const result = await applyOne(
    mkManifest('b', { endpoint: { port: 8090 } }), // different port
    () => makeClient(state),
  );
  expect(state.has('a')).toBe(true);  // not touched
  expect(state.has('b')).toBe(true);  // started
  expect(result.action).toBe('started');
});

test('evict annotation stops named workload before starting incoming', async () => {
  const state = new Map([['a', { up: true, rel: 'a.gguf', args: [] }]]);
  const result = await applyOne(
    mkManifest('b', { annotations: { 'llamactl.io/evict': 'a' }, endpoint: { port: 8181 } }),
    () => makeClient(state),
  );
  expect(state.has('a')).toBe(false);
  expect(state.has('b')).toBe(true);
  expect(result.action).toBe('started');
});

test('budget overflow returns pending with BudgetExceeded unless force-admit', async () => {
  const state = new Map([['a', { up: true, rel: 'a.gguf', args: [] }]]);
  // Build incoming whose RAM would push over a small budget.
  const incoming = mkManifest('b', { endpoint: { port: 8090 } });
  // Inject node budget via the new opts.getNodeBudget hook (introduced in this task).
  const result = await applyOne(
    incoming,
    () => makeClient(state),
    undefined,
    undefined,
    { getNodeBudgetGiB: () => 10, listManifests: () => [mkManifest('a')] },
  );
  expect(result.action).toBe('pending');
  expect(result.statusSection.conditions[0].reason).toBe('BudgetExceeded');
});

test('force-admit annotation bypasses the budget check', async () => {
  const state = new Map();
  const incoming = mkManifest('b', {
    annotations: { 'llamactl.io/force-admit': 'true' },
    endpoint: { port: 8090 },
  });
  const result = await applyOne(
    incoming,
    () => makeClient(state),
    undefined,
    undefined,
    { getNodeBudgetGiB: () => 1, listManifests: () => [] },
  );
  expect(result.action).toBe('started');
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `bun test packages/remote/src/workload/apply.multi.test.ts`
Expected: FAIL — new semantics not implemented.

- [ ] **Step 3: Implement the new applyOne**

Restructure `applyOne()` in `packages/remote/src/workload/apply.ts`. Append the new opts to the signature:

```typescript
opts?: {
  workloadsDir?: string;
  resolveNodeIdentity?: (nodeName: string) => string | null;
  listManifests?: () => ModelRun[];                // for admission; defaults to listWorkloads()
  getNodeBudgetGiB?: (nodeName: string) => number; // defaults to physical RAM × 0.75
},
```

Step-by-step in the function body, in order:

1. **Disabled short-circuit** (insert right after gateway handling):

```typescript
if (!manifest.spec.enabled) {
  const wlName = manifest.metadata.name;
  const client = getClient(manifest.spec.node);
  const status = await client.serverStatus.query({ workload: wlName });
  if (status.state === 'up') {
    onEvent?.({ type: 'stop', message: `${wlName}: disabling — stopping server` });
    await client.serverStop.mutate({ workload: wlName, graceSeconds: 5 });
  }
  const now = new Date().toISOString();
  return {
    action: 'unchanged',
    statusSection: {
      phase: 'Stopped',
      serverPid: null,
      endpoint: null,
      lastTransitionTime: now,
      conditions: [{ type: 'Applied', status: 'True', reason: 'Disabled', lastTransitionTime: now }],
    },
  };
}
```

2. **Port-collision preflight** — already cross-manifest, but filter out `enabled === false`. Modify the `others` filter:

```typescript
const others = listWorkloads(workloadsDir)
  .filter((m) => m.metadata.name !== manifest.metadata.name)
  .filter((m) => m.spec.enabled !== false)            // NEW
  .filter((m) => sameNode(m.spec.node));
```

3. **Evict step** (new):

```typescript
const evictRaw = manifest.metadata.annotations['llamactl.io/evict'] ?? '';
const evictTargets = evictRaw.split(',').map((s) => s.trim()).filter(Boolean);
for (const target of evictTargets) {
  const client = getClient(manifest.spec.node);
  const status = await client.serverStatus.query({ workload: target });
  if (status.state === 'up') {
    onEvent?.({ type: 'stop', message: `${manifest.metadata.name}: evicting '${target}'` });
    await client.serverStop.mutate({ workload: target, graceSeconds: 5 });
  } else {
    onEvent?.({ type: 'stop', message: `${manifest.metadata.name}: evict target '${target}' was already down` });
  }
}
```

4. **Admission check** (new):

```typescript
const listMs = opts?.listManifests ?? (() => listWorkloads(opts?.workloadsDir));
const getBudget = opts?.getNodeBudgetGiB ?? (() => Number.POSITIVE_INFINITY);
const forceAdmit = manifest.metadata.annotations['llamactl.io/force-admit'] === 'true';
const living = listMs()
  .filter((m) => m.metadata.name !== manifest.metadata.name)
  .filter((m) => m.spec.node === manifest.spec.node)
  .filter((m) => !evictTargets.includes(m.metadata.name));
const adm = computeNodeBudget({
  nodeName: manifest.spec.node,
  nodeBudgetGiB: getBudget(manifest.spec.node),
  livingManifests: living,
  incoming: manifest,
  forceAdmit,
});
if (!adm.ok) {
  const now = new Date().toISOString();
  return {
    action: 'pending',
    error: adm.reason,
    statusSection: {
      phase: 'Failed',
      serverPid: null,
      endpoint: null,
      lastTransitionTime: now,
      conditions: [{
        type: 'Applied', status: 'False', reason: 'BudgetExceeded',
        message: adm.reason, lastTransitionTime: now,
      }],
    },
  };
}
```

5. **Diff for this workload only** — replace `await client.serverStatus.query()` with `await client.serverStatus.query({ workload: manifest.metadata.name })`. The "stop the mismatched server" branch (current line 421-422) becomes:

```typescript
await client.serverStop.mutate({ workload: manifest.metadata.name, graceSeconds: 5 });
```

This now stops only the workload's own process — the bug fix.

6. **Start** — `serverStart` call needs `workload: manifest.metadata.name` in its input.

7. **Status section** in the success path adds the reserved-after value as an informational condition:

```typescript
conditions: [
  { type: 'Applied', status: 'True', reason: action, lastTransitionTime: now },
  { type: 'BudgetReserved', status: 'True',
    message: `node reserves ${adm.reservedAfter.toFixed(1)} / ${adm.budget === Infinity ? 'unbounded' : adm.budget.toFixed(1)} GiB`,
    lastTransitionTime: now },
],
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/remote/src/workload/apply.multi.test.ts packages/remote/src/workload/apply.test.ts`
Expected: PASS for the new file. Existing `apply.test.ts` may need its mocks updated to pass `workload` in `serverStatus.query()` calls; fix as needed.

- [ ] **Step 5: Run full remote test suite**

```bash
bun run --cwd packages/remote tsc --noEmit
bun test packages/remote
```

- [ ] **Step 6: Commit**

```bash
git add packages/remote/src/workload/apply.ts packages/remote/src/workload/apply.multi.test.ts packages/remote/src/workload/apply.test.ts
git commit -m "feat(workload): apply supports parallel + evict + admission + disabled"
```

---

### Task 11: Wire the node budget default + reconciler iteration

**Files:**
- Modify: `packages/remote/src/workload/reconcileLoop.ts`
- Modify: `packages/remote/src/workload/reconciler.ts`

- [ ] **Step 1: Implement `defaultNodeBudgetGiB`**

In `packages/remote/src/workload/admission.ts`:

```typescript
import { totalmem } from 'node:os';

/** Default to NodeRun.spec.budget.memoryGiB when present, else physical RAM × 0.75. */
export function defaultNodeBudgetGiB(nodeBudgetFromManifest?: number): number {
  if (typeof nodeBudgetFromManifest === 'number') return nodeBudgetFromManifest;
  return (totalmem() / 1024 ** 3) * 0.75;
}
```

- [ ] **Step 2: Pass admission opts from reconciler**

In `reconcileLoop.ts` (or wherever `applyOne` is invoked at the reconciler tick), thread the manifest list + budget through:

```typescript
import { defaultNodeBudgetGiB } from './admission.js';
import { listNodeRuns } from './noderun-store.js';

const nodeManifests = listNodeRuns();
const nodeBudgetByName = new Map<string, number>(
  nodeManifests.map((n) => [n.metadata.name, defaultNodeBudgetGiB(n.spec.budget?.memoryGiB)]),
);

await applyOne(manifest, getClient, onEvent, gatewayDispatch, {
  workloadsDir,
  resolveNodeIdentity,
  listManifests: () => allManifests,
  getNodeBudgetGiB: (nodeName) => nodeBudgetByName.get(nodeName) ?? defaultNodeBudgetGiB(),
});
```

- [ ] **Step 3: Verify**

```bash
bun run --cwd packages/remote tsc --noEmit
bun test packages/remote
```

- [ ] **Step 4: Commit**

```bash
git add packages/remote/src/workload/admission.ts packages/remote/src/workload/reconcileLoop.ts packages/remote/src/workload/reconciler.ts
git commit -m "feat(workload): reconciler computes per-node budget from NodeRun + RAM"
```

---

### Phase 2 checkpoint

```bash
bun run typecheck
bun test
```

Manual smoke: apply two workloads on `node: local` with different ports — both should serve concurrently.

---

## Phase 3 — CLI / operator surfaces

### Task 12: `--evict` and `--force` flags on `apply`

**Files:**
- Modify: `packages/cli/src/commands/apply.ts` (or wherever apply lives — `grep -rn "ApplyCommand\|apply'" packages/cli/src/`)
- Test: existing apply test file or new `apply.cli.test.ts`

- [ ] **Step 1: Add flag parsing**

Add to the option parser:

```typescript
{ name: 'evict', type: 'string', multiple: true, help: 'Stop this workload before applying (repeatable)' },
{ name: 'force', type: 'boolean', help: 'Skip the RAM budget check' },
```

- [ ] **Step 2: Stamp annotations on the manifest before persisting**

Before `store.writeWorkload(manifest)`:

```typescript
if (parsed.evict && parsed.evict.length > 0) {
  manifest.metadata.annotations['llamactl.io/evict'] = parsed.evict.join(',');
}
if (parsed.force) {
  manifest.metadata.annotations['llamactl.io/force-admit'] = 'true';
}
```

- [ ] **Step 3: Test**

```typescript
test('apply --evict stamps the annotation onto the persisted manifest', async () => {
  // Existing test patterns in packages/cli/test/apply.test.ts apply.
});
```

- [ ] **Step 4: Verify**

```bash
bun test packages/cli
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/apply.ts packages/cli/test/
git commit -m "feat(cli): apply --evict and --force flags stamp annotations"
```

---

### Task 13: `llamactl enable` and `llamactl disable`

**Files:**
- Create: `packages/cli/src/commands/enable.ts`
- Create: `packages/cli/src/commands/disable.ts`
- Modify: `packages/cli/src/bin.ts` (register the verbs)
- Test: `packages/cli/test/enable-disable.test.ts`

- [ ] **Step 1: Implement disable**

```typescript
// packages/cli/src/commands/disable.ts
import { readWorkload, writeWorkload } from '@llamactl/remote/workload/store';
import { applyOne } from '@llamactl/remote/workload/apply';

export async function disableCommand(args: { workload: string }): Promise<void> {
  const m = readWorkload(args.workload);
  if (!m) throw new Error(`workload not found: ${args.workload}`);
  m.spec.enabled = false;
  writeWorkload(m);
  // Trigger reconciliation immediately
  await applyOne(m, /* the existing getClient factory */);
}
```

Mirror for `enable.ts` with `m.spec.enabled = true`.

- [ ] **Step 2: Register verbs**

In `packages/cli/src/bin.ts`, route `enable`/`disable` to these handlers.

- [ ] **Step 3: Test**

```typescript
test('disable flips spec.enabled and stops the running server', async () => {
  // Set up a workload, apply, disable, assert spec.enabled === false on disk
  // AND the mock client received serverStop({ workload }).
});

test('enable flips spec.enabled back and re-applies', async () => {
  // ...
});
```

- [ ] **Step 4: Verify**

```bash
bun test packages/cli
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/enable.ts packages/cli/src/commands/disable.ts packages/cli/src/bin.ts packages/cli/test/
git commit -m "feat(cli): llamactl enable / disable verbs"
```

---

### Task 14: `describe node` budget output + MCP `llamactl.node.budget`

**Files:**
- Modify: `packages/cli/src/commands/describe.ts` (or wherever `describe node` formats output)
- Modify: `packages/remote/src/router.ts` (add `nodeBudget` procedure)
- Modify: `packages/mcp/src/` (register `llamactl.node.budget`)

- [ ] **Step 1: Add router procedure**

```typescript
nodeBudget: t.procedure
  .input(z.object({ node: z.string() }))
  .query(async ({ input }) => {
    const nodes = listNodeRuns();
    const node = nodes.find((n) => n.metadata.name === input.node);
    const budget = defaultNodeBudgetGiB(node?.spec.budget?.memoryGiB);
    const manifests = listWorkloads().filter((m) => m.spec.node === input.node);
    const live = manifests.filter((m) => m.spec.enabled !== false);
    const reserved = live.reduce((s, m) => s + (m.spec.resources?.expectedMemoryGiB ?? 0), 0);
    return {
      budget,
      reserved,
      workloads: manifests.map((m) => ({
        name: m.metadata.name,
        enabled: m.spec.enabled !== false,
        expectedMemoryGiB: m.spec.resources?.expectedMemoryGiB ?? null,
        endpoint: m.spec.endpoint ? `${m.spec.endpoint.host ?? '127.0.0.1'}:${m.spec.endpoint.port ?? '?'}` : null,
        phase: m.status?.phase ?? 'Pending',
      })),
    };
  }),
```

- [ ] **Step 2: Render in `describe node`**

```
Budget:   24.0 / 36.0 GiB
Workloads:
  granite41-8b-long-lived   :8181   running   8.2 GiB
  gemma4-26b-a4b-mtp        :8090   running  15.8 GiB
```

Append warning line when `reserved > budget`:

```
WARNING: budget exceeded (24.0 > 20.0 GiB) — applies will require --force
```

- [ ] **Step 3: Register MCP tool**

`packages/mcp/src/tools/` (follow existing pattern). Tool name: `llamactl.node.budget`. Input schema: `{ node: string }`. Output: the same JSON shape as the router procedure.

- [ ] **Step 4: Tests**

```typescript
test('node.budget returns reserved sum + per-workload entries', async () => { /* ... */ });
test('describe node renders warning when reserved > budget', async () => { /* ... */ });
```

- [ ] **Step 5: Verify + commit**

```bash
bun test
git add packages/cli/src/commands/describe.ts packages/remote/src/router.ts packages/mcp/src/
git commit -m "feat: describe node budget rollup + llamactl.node.budget MCP tool"
```

---

### Phase 3 checkpoint

```bash
bun run typecheck
bun test
zsh test/run-all.zsh
```

---

## Phase 4 — Integration verification

### Task 15: Shell integration smoke

**Files:**
- Create: `test/multi-workload.zsh`
- Modify: `test/run-all.zsh` (call the new script)

- [ ] **Step 1: Write the smoke script**

```zsh
#!/usr/bin/env zsh
set -euo pipefail

# Assumes a clean local env, with two small known GGUFs available.
SMALL_A=${LLAMACTL_TEST_GGUF_A:-"granite-4.1-3b-Q4_K_M.gguf"}
SMALL_B=${LLAMACTL_TEST_GGUF_B:-"granite-4.1-3b-Q4_K_M.gguf"}

cleanup() {
  llamactl delete -f <(echo "apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: test-a }
spec: { node: local, target: { kind: rel, value: $SMALL_A } }") 2>/dev/null || true
  llamactl delete -f <(echo "apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: test-b }
spec: { node: local, target: { kind: rel, value: $SMALL_B } }") 2>/dev/null || true
}
trap cleanup EXIT

# Apply A on :8181
cat <<EOF | llamactl apply -f -
apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: test-a }
spec: { node: local, target: { kind: rel, value: $SMALL_A }, endpoint: { port: 8181 }, resources: { expectedMemoryGiB: 2 } }
EOF

# Apply B on :8090 — must NOT stop A
cat <<EOF | llamactl apply -f -
apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: test-b }
spec: { node: local, target: { kind: rel, value: $SMALL_B }, endpoint: { port: 8090 }, resources: { expectedMemoryGiB: 2 } }
EOF

# Probe both endpoints
curl -fsS http://127.0.0.1:8181/health >/dev/null
curl -fsS http://127.0.0.1:8090/health >/dev/null
echo "OK: both workloads alive concurrently"

# Disable A, verify it stops, B unaffected
llamactl disable test-a
sleep 1
if curl -fsS http://127.0.0.1:8181/health >/dev/null 2>&1; then
  echo "FAIL: A still alive after disable"
  exit 1
fi
curl -fsS http://127.0.0.1:8090/health >/dev/null
echo "OK: disable stopped A, B still alive"

# Apply A again with --evict test-b → B stops, A starts
cat <<EOF | llamactl apply --evict test-b -f -
apiVersion: llamactl/v1
kind: ModelRun
metadata: { name: test-a }
spec: { node: local, target: { kind: rel, value: $SMALL_A }, endpoint: { port: 8181 }, resources: { expectedMemoryGiB: 2 } }
EOF
sleep 1
if curl -fsS http://127.0.0.1:8090/health >/dev/null 2>&1; then
  echo "FAIL: B still alive after evict"
  exit 1
fi
curl -fsS http://127.0.0.1:8181/health >/dev/null
echo "OK: --evict stopped B, A started"
```

- [ ] **Step 2: Add to run-all.zsh**

```zsh
zsh test/multi-workload.zsh
```

(Skip in CI environments where llama-server can't run — gate on `LLAMACTL_SKIP_LIVE=1`.)

- [ ] **Step 3: Run locally**

```bash
zsh test/multi-workload.zsh
```

- [ ] **Step 4: Commit**

```bash
git add test/multi-workload.zsh test/run-all.zsh
git commit -m "test: multi-workload shell smoke (parallel + disable + evict)"
```

---

### Task 16: Cross-repo smoke (manual)

**Files:** none (manual)

- [ ] **Step 1: Apply real workloads**

```bash
llamactl apply -f templates/workloads/granite41-8b-long-lived-local.yaml
llamactl apply -f templates/workloads/gemma4-26b-a4b-mtp-local.yaml
```

- [ ] **Step 2: Verify both endpoints reachable**

```bash
curl -fsS http://127.0.0.1:8181/health   # Granite
curl -fsS http://127.0.0.1:8090/health   # Gemma (or whichever port)
```

- [ ] **Step 3: Verify home-mgmt SDK does not reconnect-loop**

Run the home-mgmt SDK as the user normally does. Watch logs for ConnectionRefused; there should be none.

- [ ] **Step 4: Verify sirius-gateway + embersynth integration**

Run their integration tests (see memory: `feedback_cross_repo_validation.md`). Their dependencies on llamactl endpoints should not regress.

- [ ] **Step 5: Document the result**

Append a note to `docs/notes/` summarizing what was verified, dated.

- [ ] **Step 6: Optional commit (just the note)**

```bash
git add docs/notes/
git commit -m "docs(notes): multi-workload cross-repo smoke verified"
```

---

### Task 17: Final cleanup

**Files:**
- Modify: `AGENTS.md` if any of the new flags / commands deserve a callout
- Modify: `README.md` if there's a "feature" section that mentions single-workload constraints

- [ ] **Step 1: Search docs for outdated claims**

```bash
grep -rn "single.*workload\|one.*llama-server\|single-node\|Phase D scope uses a single-node" *.md docs/ AGENTS.md packages/remote/src/workload/schema.ts
```

Update each hit to reflect the new reality (or leave Phase-D historical comments alone if they're documenting history).

- [ ] **Step 2: Update workload schema doc comment**

In `packages/remote/src/workload/schema.ts:10-13`, refresh the comment block to mention that multiple workloads per node are supported and reference `spec.enabled` / `spec.resources` / annotations.

- [ ] **Step 3: Final verify + commit**

```bash
bun run typecheck
bun test
zsh test/run-all.zsh
git add -A
git commit -m "docs: refresh workload schema comment + AGENTS multi-workload note"
```

---

## Out of scope (deferred)

- Auto-priority eviction across workloads.
- Sub-node GPU/CPU isolation.
- KV-cache-aware memory estimator (the GGUF-size heuristic is the v1).
- Electron chat workload picker UI (the data path is wired through Task 7 — the dropdown UI is a follow-up).
