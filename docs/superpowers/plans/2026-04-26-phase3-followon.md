# Phase 3 Follow-on Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two acknowledged Phase 3 v1 deferrals — fan out `opsSessionSearch` and `logsSearch` across kubeconfig agent nodes (sessions + logs cross-node) and remove the dead Tier 2 `knowledgeSearch` proc.

**Architecture:** Fan-out lives in the Electron-main UI router because that's where the per-node tRPC client cache already lives. Two new UI procs (`uiCrossNodeOpsSessionSearch`, `uiCrossNodeLogsSearch`) iterate kubeconfig agents excluding the active one, parallel-dispatch with per-node 2s timeout via `Promise.allSettled`, merge, origin-tag, return `{ hits, unreachableNodes }`. App-side hook runs local + remote waves in parallel under one Tier 2 debounce anchor; renderer surfaces a per-hit origin tag (default-elide on local) and a per-group unreachable-nodes footer.

**Tech Stack:** TypeScript, Bun test, tRPC v11 (existing `UIRouter` in `packages/app/electron/trpc/dispatcher.ts`), the existing `clientCache` keyed by `(endpoint+fingerprint+token)`, kubeconfig loader (`kubecfg.loadConfig` / `currentContext`).

**Spec:** `docs/superpowers/specs/2026-04-26-phase3-followon-design.md`

---

## File Structure

### Created

- `packages/app/electron/trpc/cross-node-fan-out.ts` — pure module with `listAgentNodes` and `fanOutSurface`
- `packages/app/test/electron/trpc/cross-node-fan-out.test.ts` — unit tests for the pure module
- `packages/app/test/electron/trpc/dispatcher-cross-node.test.ts` — proc-level test for the new UI procs

### Modified

- `packages/remote/src/router.ts` — DELETE the `knowledgeSearch` proc
- `packages/app/src/lib/global-search/types.ts` — `Hit.originNode?`, `SurfaceGroup.unreachableNodes?`
- `packages/app/src/lib/global-search/orchestrator.ts` — `mergeServerHits` preserves `unreachableNodes`
- `packages/app/src/lib/global-search/surfaces/sessions.ts` — accept optional `originNode` parameter, thread to hits
- `packages/app/src/lib/global-search/surfaces/logs.ts` — same
- `packages/app/src/lib/global-search/surfaces/knowledge.ts` — DELETE
- `packages/app/src/lib/global-search/hooks/use-global-search.ts` — add remote fan-out wave for sessions + logs
- `packages/app/electron/trpc/dispatcher.ts` — add `uiCrossNodeOpsSessionSearch` + `uiCrossNodeLogsSearch` procs to `uiRouter`
- `packages/app/src/shell/beacon/search-results-tree.tsx` — render origin tag + unreachable-nodes footer
- `packages/app/test/lib/global-search/orchestrator.test.ts` — extend with `unreachableNodes` propagation
- `packages/app/test/lib/global-search/use-global-search.test.ts` — extend with parallel-wave scheduling test

---

## Conventions

**Test runner.** App tests via `bun test --cwd packages/app`. Server tests via `bun test --cwd packages/remote`. Both honour the existing hermetic `LLAMACTL_TEST_PROFILE` / `DEV_STORAGE` patterns where they touch disk.

**Real typecheck.** `bunx tsc -p packages/app/tsconfig.web.json --noEmit` (app side) and `bunx tsc -p packages/remote/tsconfig.json --noEmit` (server side). Record the baselines at the start of Task 1 step 9 and re-check at Task 9 step 4 — counts must be **equal**, not "fewer than before."

**App ↔ remote isolation.** `packages/app/src/*` does NOT import from `@llamactl/remote`. The Electron main package (`packages/app/electron/*`) does — it's the dispatcher layer. The cross-node fan-out lives in Electron main precisely because that's where remote-package imports are allowed.

**No React render tests.** `@testing-library/react` is not installed. Pure helper logic gets unit tests; rendered behaviour is verified by Tier C UI flows.

**Conventional Commits.** One commit per task. No AI/co-author trailers.

**Spec source of truth.** `docs/superpowers/specs/2026-04-26-phase3-followon-design.md`. Locked decisions (D1–D5) are not up for debate. If a real implementation gap surfaces, flag it before improvising.

---

## Task 1: Delete `knowledgeSearch` proc + `surfaces/knowledge.ts`

**Files:**
- Modify: `packages/remote/src/router.ts` (delete the `knowledgeSearch` proc block)
- Delete: `packages/app/src/lib/global-search/surfaces/knowledge.ts`
- Modify: `packages/app/src/lib/global-search/orchestrator.ts` (remove the call site)
- Modify: `packages/app/src/lib/global-search/hooks/use-global-search.ts` (remove the call site)

The Tier 2 lexical knowledge proc was always wired to a `[]` fallback; the spec calls for cleaning it up entirely. The `searchKnowledge` helper in `packages/remote/src/search/knowledge.ts` and its test stay — the helper is reusable later if Option C from the brainstorm comes back.

- [ ] **Step 1: Delete the `knowledgeSearch` proc**

In `packages/remote/src/router.ts`, find:

```ts
  knowledgeSearch: t.procedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      return { hits: [] as Array<unknown> };
    }),
```

Delete this block in its entirety. Leave the surrounding `opsSessionSearch` and `logsSearch` procs untouched.

- [ ] **Step 2: Delete the surfaces module**

```bash
rm packages/app/src/lib/global-search/surfaces/knowledge.ts
```

- [ ] **Step 3: Find and remove the orchestrator call site**

```bash
grep -rn "surfaces/knowledge\|knowledgeSearch\|knowledge-rag" packages/app/src/lib/global-search/
```

For every match in `orchestrator.ts` and `hooks/use-global-search.ts`:
- Remove the import (`import { ... } from './surfaces/knowledge.js'`).
- Remove the call site that invokes it (`trpc.knowledgeSearch.useQuery` or its `utils.fetch` equivalent).
- Leave the `knowledge-rag` (Tier 3 / `ragSearch`) call sites untouched — only Tier 2 knowledge is being dropped.

- [ ] **Step 4: Verify the orchestrator's surface list shrinks**

In `orchestrator.ts`, the `runClientPhase` / `runServerPhase` helpers iterate over a list of surfaces. Confirm that the `'knowledge'` Tier 2 entry is removed from any `for`/`map`/array literal that drives the iteration. The `'knowledge'` Tier 3 (`ragSearch`-backed) entry stays.

- [ ] **Step 5: Run the app test suite, confirm no regressions**

Run: `bun test --cwd packages/app 2>&1 | tail -5`
Expected: All previously-passing tests still pass.

If a test fails because it referenced the deleted module: open the test, remove the obsolete assertion (the test is checking for empty results from a proc that no longer exists). Don't add a placeholder; the test can simply lose its `knowledge` cases.

- [ ] **Step 6: Run the remote test suite, confirm no regressions**

Run: `bun test --cwd packages/remote 2>&1 | tail -5`
Expected: All previously-passing tests still pass. (The `searchKnowledge` helper test stays green because the helper is retained.)

- [ ] **Step 7: Real typecheck both packages**

```bash
bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l
bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | wc -l
```

Record both numbers. They become the baselines for Task 9 step 4. Both should be small / unchanged from what main currently has.

- [ ] **Step 8: Commit**

```bash
git add packages/remote/src/router.ts \
        packages/app/src/lib/global-search/orchestrator.ts \
        packages/app/src/lib/global-search/hooks/use-global-search.ts
git rm packages/app/src/lib/global-search/surfaces/knowledge.ts
git commit -m "refactor(remote,app): drop dead knowledgeSearch tier-2 proc

Tier 2 lexical knowledge search was wired to a [] fallback because no
lexical knowledge entity store exists in this codebase (knowledge is
RAG-only, served via tier 3 ragSearch). Drop the proc and its
orchestrator surface; tier 3 search is unaffected. The searchKnowledge
helper in packages/remote/src/search/knowledge.ts is retained — it's
a pure function with tests, kept available for any future
re-introduction."
```

---

## Task 2: Schema additions — `Hit.originNode?` + `SurfaceGroup.unreachableNodes?`

**Files:**
- Modify: `packages/app/src/lib/global-search/types.ts`
- Test: `packages/app/test/lib/global-search/types.test.ts` (create if missing — pure type-shape sanity)

The schema gains two optional fields that flow through the existing pipeline. No behavioral change yet — Task 6 wires preservation through `mergeServerHits`, Task 7 populates them, Task 8 renders them.

- [ ] **Step 1: Add the optional fields to `types.ts`**

Open `packages/app/src/lib/global-search/types.ts`. Find the `Hit` interface and add:

```ts
  /** Source agent for cross-node hits. Undefined when the hit came
   *  from the currently-connected agent — the renderer elides the
   *  tag in that case. */
  originNode?: string;
```

Find the `SurfaceGroup` interface and add:

```ts
  /** Agent node names that did not return results in time (or
   *  rejected the request) during the cross-node fan-out wave for
   *  this surface. Renderer surfaces as a small footer; does not
   *  block other hits. */
  unreachableNodes?: string[];
```

- [ ] **Step 2: Sanity check there are no shape collisions**

```bash
grep -n "originNode\|unreachableNodes" packages/app/src/lib/global-search/types.ts
```

Both names should appear once each, only inside the interfaces they were just added to.

- [ ] **Step 3: Real typecheck — count unchanged**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l`
Expected: equal to the baseline recorded in Task 1 step 7. Adding optional fields cannot raise the count.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/lib/global-search/types.ts
git commit -m "feat(app/global-search): add originNode + unreachableNodes optional schema fields"
```

---

## Task 3: `cross-node-fan-out.ts` pure module

**Files:**
- Create: `packages/app/electron/trpc/cross-node-fan-out.ts`
- Test: `packages/app/test/electron/trpc/cross-node-fan-out.test.ts`

A pure module with two functions: `listAgentNodes` (a kubeconfig filter) and `fanOutSurface` (the parallel dispatcher with per-node timeout + abort). No Electron/Node dependency in the API — the fetcher is supplied by the caller. Lives in `packages/app/electron/` because Task 4 imports it from the Electron-main UI router.

- [ ] **Step 1: Write the failing test**

```ts
// packages/app/test/electron/trpc/cross-node-fan-out.test.ts
import { describe, expect, test } from 'bun:test';
import {
  fanOutSurface,
  listAgentNodes,
  type NodeFailure,
} from '../../../electron/trpc/cross-node-fan-out';
import type { Config, ClusterNode } from '@llamactl/remote';

const cfg: Config = {
  apiVersion: 'llamactl/v1' as const,
  kind: 'Config' as const,
  currentContext: 'default',
  contexts: [{ name: 'default', cluster: 'home', user: 'me', defaultNode: 'local' }],
  clusters: [
    {
      name: 'home',
      nodes: [
        { name: 'local', endpoint: 'https://127.0.0.1:7843' },
        { name: 'mac-mini', endpoint: 'https://192.168.68.76:7843' },
        { name: 'sirius-gw', endpoint: '', kind: 'gateway' as const },
        { name: 'kb-chroma', endpoint: '', kind: 'rag' as const },
      ] as ClusterNode[],
    },
  ],
  users: [{ name: 'me', token: 'abc' }],
};

describe('listAgentNodes', () => {
  test('excludes the active node and non-agent kinds', () => {
    const out = listAgentNodes(cfg, 'local');
    expect(out.map((n) => n.name)).toEqual(['mac-mini']);
  });

  test('treats nodes with no kind as agents (backwards compat)', () => {
    const out = listAgentNodes(cfg, 'mac-mini');
    expect(out.map((n) => n.name)).toEqual(['local']);
  });

  test('empty array when only the active node is an agent', () => {
    const oneAgent: Config = {
      ...cfg,
      clusters: [{
        name: 'home',
        nodes: [
          { name: 'local', endpoint: 'https://127.0.0.1:7843' },
          { name: 'sirius-gw', endpoint: '', kind: 'gateway' as const },
        ] as ClusterNode[],
      }],
    };
    expect(listAgentNodes(oneAgent, 'local')).toEqual([]);
  });
});

describe('fanOutSurface', () => {
  const nodes: ClusterNode[] = [
    { name: 'a', endpoint: 'https://a:7843' },
    { name: 'b', endpoint: 'https://b:7843' },
    { name: 'c', endpoint: 'https://c:7843' },
  ];

  test('all-succeed merges hits, no failures', async () => {
    const out = await fanOutSurface<{ id: string; node: string }>({
      nodes,
      perNodeFetch: async (node) => [{ id: node.name, node: node.name }],
      perNodeTimeoutMs: 100,
    });
    expect(out.failures).toEqual([]);
    expect(out.hits.map((h) => h.id).sort()).toEqual(['a', 'b', 'c']);
  });

  test('per-node timeout produces failure with reason=timeout', async () => {
    const out = await fanOutSurface<{ id: string }>({
      nodes,
      perNodeFetch: async (node, signal) => {
        if (node.name === 'b') {
          await new Promise((r) => setTimeout(r, 200));
          if (signal.aborted) throw new Error('aborted');
          return [];
        }
        return [{ id: node.name }];
      },
      perNodeTimeoutMs: 50,
    });
    expect(out.hits.map((h) => h.id).sort()).toEqual(['a', 'c']);
    expect(out.failures.length).toBe(1);
    expect(out.failures[0]!.nodeName).toBe('b');
    expect(out.failures[0]!.reason).toBe('timeout');
  });

  test('per-node rejection produces failure with reason=rejected', async () => {
    const out = await fanOutSurface<{ id: string }>({
      nodes,
      perNodeFetch: async (node) => {
        if (node.name === 'a') throw new Error('TLS handshake failed');
        return [{ id: node.name }];
      },
      perNodeTimeoutMs: 100,
    });
    expect(out.hits.map((h) => h.id).sort()).toEqual(['b', 'c']);
    const fail = out.failures.find((f) => f.nodeName === 'a')!;
    expect(fail.reason).toBe('rejected');
    expect(fail.detail).toContain('TLS handshake failed');
  });

  test('outer abort short-circuits in-flight fetches', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const out = await fanOutSurface<{ id: string }>({
      nodes,
      perNodeFetch: async (node, signal) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 1000);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
        return [{ id: node.name }];
      },
      perNodeTimeoutMs: 5000,
      signal: ctrl.signal,
    });
    expect(out.hits).toEqual([]);
    expect(out.failures.length).toBe(3);
    for (const f of out.failures) {
      expect(['aborted', 'rejected']).toContain(f.reason);
    }
  });

  test('empty nodes array returns instant empty result', async () => {
    const out = await fanOutSurface<{ id: string }>({
      nodes: [],
      perNodeFetch: async () => {
        throw new Error('should not be called');
      },
      perNodeTimeoutMs: 100,
    });
    expect(out).toEqual({ hits: [], failures: [] });
  });

  test('failures shape carries detail strings', async () => {
    const out = await fanOutSurface<{ id: string }>({
      nodes: [{ name: 'x', endpoint: '' }],
      perNodeFetch: async () => {
        throw new Error('boom');
      },
      perNodeTimeoutMs: 100,
    });
    const f: NodeFailure | undefined = out.failures[0];
    expect(f).toBeDefined();
    expect(f!.detail).toBe('boom');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/app test/electron/trpc/cross-node-fan-out.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure module**

```ts
// packages/app/electron/trpc/cross-node-fan-out.ts
import type { ClusterNode, Config } from '@llamactl/remote';

export interface NodeFailure {
  nodeName: string;
  reason: 'timeout' | 'rejected' | 'aborted';
  detail?: string;
}

export interface FanOutOpts<T> {
  /** Agent nodes to dispatch to; caller has already excluded self. */
  nodes: readonly ClusterNode[];
  /** Per-node fetcher. Receives the node and an AbortSignal scoped
   *  to this node's per-node timeout (or the outer signal, whichever
   *  fires first). Returns hits or throws. */
  perNodeFetch: (node: ClusterNode, signal: AbortSignal) => Promise<T[]>;
  /** Per-node timeout in milliseconds; default 2000. */
  perNodeTimeoutMs?: number;
  /** Outer abort signal — cancels every in-flight node call. */
  signal?: AbortSignal;
}

export interface FanOutResult<T> {
  hits: T[];
  failures: NodeFailure[];
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Filter kubeconfig agent nodes for cross-node fan-out:
 *   - Limit to nodes in the current context's cluster
 *   - Treat nodes with no `kind` field as agents (backwards compat)
 *   - Exclude `gateway` and `rag` nodes (those aren't search peers)
 *   - Exclude the active node (caller already searches it via the
 *     normal single-node path)
 */
export function listAgentNodes(cfg: Config, activeNodeName: string): ClusterNode[] {
  const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
  if (!ctx) return [];
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  if (!cluster) return [];
  return cluster.nodes.filter((n) => {
    const kind = (n as { kind?: string }).kind ?? 'agent';
    if (kind !== 'agent') return false;
    if (n.name === activeNodeName) return false;
    return true;
  });
}

/**
 * Parallel-dispatch a per-node fetcher across a set of nodes. Each
 * node call gets a child AbortController racing the per-node timeout
 * (and the outer signal if provided). Failures are captured per-node
 * and surfaced in `failures`; successes merge into `hits`.
 *
 * Never rejects — the caller wants partial success even if every node
 * fails. The outer signal cancellation reaches each in-flight fetcher
 * via its child signal.
 */
export async function fanOutSurface<T>(opts: FanOutOpts<T>): Promise<FanOutResult<T>> {
  if (opts.nodes.length === 0) return { hits: [], failures: [] };
  const timeoutMs = opts.perNodeTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures: NodeFailure[] = [];
  const hits: T[] = [];

  const settled = await Promise.allSettled(
    opts.nodes.map(async (node) => {
      const child = new AbortController();
      const onOuterAbort = (): void => child.abort();
      opts.signal?.addEventListener('abort', onOuterAbort);
      const timer = setTimeout(() => child.abort(), timeoutMs);
      try {
        const result = await opts.perNodeFetch(node, child.signal);
        return { node: node.name, ok: true as const, hits: result };
      } catch (err) {
        const reason = child.signal.aborted
          ? (opts.signal?.aborted ? 'aborted' : 'timeout')
          : 'rejected';
        return {
          node: node.name,
          ok: false as const,
          reason,
          detail: (err as Error).message,
        };
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onOuterAbort);
      }
    }),
  );

  for (const r of settled) {
    if (r.status === 'rejected') continue; // shouldn't happen — inner catches
    const v = r.value;
    if (v.ok) {
      hits.push(...v.hits);
    } else {
      failures.push({
        nodeName: v.node,
        reason: v.reason,
        ...(v.detail ? { detail: v.detail } : {}),
      });
    }
  }
  return { hits, failures };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/app test/electron/trpc/cross-node-fan-out.test.ts`
Expected: PASS — 9 tests pass.

- [ ] **Step 5: Real typecheck — count unchanged**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l`
Expected: equal to the Task 1 step 7 baseline.

- [ ] **Step 6: Commit**

```bash
git add packages/app/electron/trpc/cross-node-fan-out.ts \
        packages/app/test/electron/trpc/cross-node-fan-out.test.ts
git commit -m "feat(app/electron-trpc): add cross-node fan-out helper

Pure module with listAgentNodes (kubeconfig filter excluding gateways,
RAG nodes, and the active node) and fanOutSurface (Promise.allSettled
parallel dispatch with per-node timeout + outer abort). Used by the
new uiCrossNode procs in the next task; isolated as a pure module so
its retry/timeout/abort semantics are unit-testable without an actual
tRPC client."
```

---

## Task 4: `uiCrossNodeOpsSessionSearch` + `uiCrossNodeLogsSearch` UI procs

**Files:**
- Modify: `packages/app/electron/trpc/dispatcher.ts` (add procs to `uiRouter`)
- Test: `packages/app/test/electron/trpc/dispatcher-cross-node.test.ts`

The two new UI procs use `cross-node-fan-out` from Task 3. Each enumerates peer agents, builds (or reuses) a tRPC client per peer via the existing `clientCache`, dispatches the corresponding agent-side proc, merges, returns `{ hits, unreachableNodes }`.

- [ ] **Step 1: Read the existing client-cache helper**

Run: `grep -n "buildRemoteClient\|clientCache\|cacheKey\|buildPinnedLinks" packages/app/electron/trpc/dispatcher.ts | head -20`

Note the existing factory (`buildRemoteClient`) and the cache. The new procs reuse this factory: call `buildRemoteClient` once per peer node, get back a typed `AppRouter` proxy client, invoke the appropriate proc on it.

- [ ] **Step 2: Write the failing test**

```ts
// packages/app/test/electron/trpc/dispatcher-cross-node.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We test the proc by importing the uiRouter and invoking via createCaller.
// The dispatcher's clientCache builds a real createTRPCClient per peer; in
// this test we monkey-patch a per-node client factory to return canned hits.

// IMPORTANT: this test stubs the client factory by setting a module-level
// hook that the proc consults when set. Pattern: dispatcher.ts exports a
// __setPeerClientFactoryForTests(factory) helper for test injection,
// reset via __resetPeerClientFactoryForTests().

import {
  uiRouter,
  __setPeerClientFactoryForTests,
  __resetPeerClientFactoryForTests,
} from '../../../electron/trpc/dispatcher';

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dispatcher-cross-node-'));
  mkdirSync(join(tmp, '.llamactl'), { recursive: true });
  process.env.LLAMACTL_TEST_PROFILE = tmp;
  // minimal kubeconfig with two agent nodes
  writeFileSync(
    join(tmp, '.llamactl', 'config'),
    `apiVersion: llamactl/v1
kind: Config
currentContext: default
contexts:
  - name: default
    cluster: home
    user: me
    defaultNode: local
clusters:
  - name: home
    nodes:
      - name: local
        endpoint: https://127.0.0.1:7843
      - name: mac-mini
        endpoint: https://192.168.68.76:7843
users:
  - name: me
    token: ll_agt_test
`,
    'utf8',
  );
});

afterEach(() => {
  __resetPeerClientFactoryForTests();
  delete process.env.LLAMACTL_TEST_PROFILE;
  rmSync(tmp, { recursive: true, force: true });
});

describe('uiCrossNodeOpsSessionSearch', () => {
  test('tags hits with originNode and aggregates unreachableNodes', async () => {
    __setPeerClientFactoryForTests((node) => ({
      opsSessionSearch: {
        query: async (_input: unknown, _opts?: { signal?: AbortSignal }) => ({
          hits: [
            {
              sessionId: `s-${node.name}-1`,
              goal: 'g',
              status: 'done',
              startedAt: '2026-04-26T00:00:00.000Z',
              matches: [{ where: 'goal', snippet: 'g', spans: [] }],
              score: 0.7,
            },
          ],
        }),
      },
    } as any));
    const caller = uiRouter.createCaller({} as any);
    const res = await caller.uiCrossNodeOpsSessionSearch({ query: 'fleet' });
    // Active node is 'local' — only 'mac-mini' is a peer here.
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.originNode).toBe('mac-mini');
    expect(res.unreachableNodes).toEqual([]);
  });

  test('captures per-node failure into unreachableNodes', async () => {
    __setPeerClientFactoryForTests((_node) => ({
      opsSessionSearch: {
        query: async () => {
          throw new Error('TLS pinned-cert mismatch');
        },
      },
    } as any));
    const caller = uiRouter.createCaller({} as any);
    const res = await caller.uiCrossNodeOpsSessionSearch({ query: 'fleet' });
    expect(res.hits).toEqual([]);
    expect(res.unreachableNodes).toEqual(['mac-mini']);
  });

  test('respects perNodeTimeoutMs override', async () => {
    __setPeerClientFactoryForTests((_node) => ({
      opsSessionSearch: {
        query: async (_input: unknown, opts?: { signal?: AbortSignal }) => {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 5000);
            opts?.signal?.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          });
          return { hits: [] };
        },
      },
    } as any));
    const caller = uiRouter.createCaller({} as any);
    const res = await caller.uiCrossNodeOpsSessionSearch({
      query: 'fleet',
      perNodeTimeoutMs: 30,
    });
    expect(res.unreachableNodes).toEqual(['mac-mini']);
  });
});

describe('uiCrossNodeLogsSearch', () => {
  test('tags log hits and surfaces unreachable peers', async () => {
    __setPeerClientFactoryForTests((node) => ({
      logsSearch: {
        query: async () => ({
          hits: [
            {
              fileLabel: 'agent',
              filePath: '/tmp/llamactl-agent.log',
              matches: [
                { lineNumber: 42, where: 'agent:42', snippet: 'error', spans: [] },
              ],
              score: 0.6,
            },
          ],
        }),
        // ops session client must still exist on the cached client; no-op here.
      },
    } as any));
    const caller = uiRouter.createCaller({} as any);
    const res = await caller.uiCrossNodeLogsSearch({ query: 'error' });
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.originNode).toBe('mac-mini');
  });
});
```

- [ ] **Step 3: Run, verify failure**

Run: `bun test --cwd packages/app test/electron/trpc/dispatcher-cross-node.test.ts`
Expected: FAIL — `uiCrossNodeOpsSessionSearch` / `uiCrossNodeLogsSearch` / `__setPeerClientFactoryForTests` not exported.

- [ ] **Step 4: Add the test-injection seam to `dispatcher.ts`**

Near the existing `__resetClientCacheForTests` (search for it; it's defined alongside the cache), add:

```ts
type PeerClientFactory = (node: ClusterNode) => unknown;
let peerClientFactoryOverride: PeerClientFactory | null = null;

export function __setPeerClientFactoryForTests(factory: PeerClientFactory): void {
  peerClientFactoryOverride = factory;
}
export function __resetPeerClientFactoryForTests(): void {
  peerClientFactoryOverride = null;
}

function getPeerClient(node: ClusterNode, user: User): unknown {
  if (peerClientFactoryOverride) return peerClientFactoryOverride(node);
  // Real path: build via existing buildRemoteClient with the user's
  // resolved token. Reuses clientCache automatically.
  return buildRemoteClient(
    {
      kind: 'remote',
      node: {
        name: node.name,
        endpoint: node.endpoint,
        certificate: node.certificate ?? null,
        certificateFingerprint: node.certificateFingerprint ?? null,
      },
      token: kubecfg.resolveToken(user),
    },
    /* fetchFactory */ makePinnedFetch,
  );
}
```

(Match the existing imports — `ClusterNode`, `User`, `kubecfg`, `makePinnedFetch` — already in the file. If `buildRemoteClient`'s signature differs from this, adapt the call site to match the actual signature.)

- [ ] **Step 5: Add the two procs to `uiRouter`**

In the `uiRouter = t.router({...})` block, add two new procs alongside the existing `uiSetActiveNode` / `uiPickDirectory` etc.:

```ts
  uiCrossNodeOpsSessionSearch: t.procedure
    .input(z.object({
      query: z.string().min(1),
      perNodeTimeoutMs: z.number().int().positive().max(30000).optional(),
    }))
    .query(async ({ input, signal }) => {
      const cfg = kubecfg.loadConfig();
      const ctx = kubecfg.currentContext(cfg);
      const user = cfg.users.find((u) => u.name === ctx.user);
      if (!user) return { hits: [], unreachableNodes: [] };
      const activeName = getActiveNodeOverride() ?? ctx.defaultNode;
      const peers = listAgentNodes(cfg, activeName);
      const result = await fanOutSurface<{
        sessionId: string;
        goal: string;
        status: 'live' | 'done' | 'refused' | 'aborted';
        startedAt: string;
        matches: { where: string; snippet: string; spans: { start: number; end: number }[] }[];
        score: number;
        originNode?: string;
      }>({
        nodes: peers,
        perNodeFetch: async (node, peerSignal) => {
          const client = getPeerClient(node, user) as {
            opsSessionSearch: { query: (i: { query: string }, o?: { signal?: AbortSignal }) => Promise<{ hits: any[] }> };
          };
          const r = await client.opsSessionSearch.query({ query: input.query }, { signal: peerSignal });
          return r.hits.map((h: any) => ({ ...h, originNode: node.name }));
        },
        perNodeTimeoutMs: input.perNodeTimeoutMs ?? 2000,
        signal,
      });
      return {
        hits: result.hits,
        unreachableNodes: result.failures.map((f) => f.nodeName),
      };
    }),

  uiCrossNodeLogsSearch: t.procedure
    .input(z.object({
      query: z.string().min(1),
      perNodeTimeoutMs: z.number().int().positive().max(30000).optional(),
    }))
    .query(async ({ input, signal }) => {
      const cfg = kubecfg.loadConfig();
      const ctx = kubecfg.currentContext(cfg);
      const user = cfg.users.find((u) => u.name === ctx.user);
      if (!user) return { hits: [], unreachableNodes: [] };
      const activeName = getActiveNodeOverride() ?? ctx.defaultNode;
      const peers = listAgentNodes(cfg, activeName);
      const result = await fanOutSurface<{
        fileLabel: string;
        filePath: string;
        matches: { lineNumber: number; where: string; snippet: string; spans: { start: number; end: number }[] }[];
        score: number;
        originNode?: string;
      }>({
        nodes: peers,
        perNodeFetch: async (node, peerSignal) => {
          const client = getPeerClient(node, user) as {
            logsSearch: { query: (i: { query: string }, o?: { signal?: AbortSignal }) => Promise<{ hits: any[] }> };
          };
          const r = await client.logsSearch.query({ query: input.query }, { signal: peerSignal });
          return r.hits.map((h: any) => ({ ...h, originNode: node.name }));
        },
        perNodeTimeoutMs: input.perNodeTimeoutMs ?? 2000,
        signal,
      });
      return {
        hits: result.hits,
        unreachableNodes: result.failures.map((f) => f.nodeName),
      };
    }),
```

Add the imports at the top of the file:

```ts
import { fanOutSurface, listAgentNodes } from './cross-node-fan-out.js';
```

- [ ] **Step 6: Run, verify pass**

Run: `bun test --cwd packages/app test/electron/trpc/dispatcher-cross-node.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 7: Run the full app test suite — no regressions**

Run: `bun test --cwd packages/app 2>&1 | tail -5`
Expected: All previously-passing tests still pass.

- [ ] **Step 8: Real typecheck — count unchanged**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l`
Expected: equal to the Task 1 step 7 baseline.

- [ ] **Step 9: Commit**

```bash
git add packages/app/electron/trpc/dispatcher.ts \
        packages/app/test/electron/trpc/dispatcher-cross-node.test.ts
git commit -m "feat(app/electron-trpc): add uiCrossNode procs for sessions + logs

Two new UIRouter procs that fan out the corresponding agent-side
search procs across peer kubeconfig nodes via fanOutSurface. Each
remote hit is tagged with originNode = peer.name; per-node
failures (timeout, rejection, abort) populate unreachableNodes.
Reuses the existing clientCache (keyed by endpoint + fingerprint +
token) so peer clients are built once per query batch and amortize
across keystrokes."
```

---

## Task 5: Surface mappers thread `originNode`

**Files:**
- Modify: `packages/app/src/lib/global-search/surfaces/sessions.ts`
- Modify: `packages/app/src/lib/global-search/surfaces/logs.ts`

The local-fetch path returns hits without `originNode` (correctly — `originNode === undefined` means "the connected agent"). The remote-fan-out path returns hits already tagged. Both feed through the same mapper to produce `Hit[]`. The mapper just needs to preserve `originNode` from the input record.

- [ ] **Step 1: Update `sessions.ts` mapper**

Open `packages/app/src/lib/global-search/surfaces/sessions.ts`. Find the function that maps server hits → `Hit`. It currently produces something like:

```ts
return {
  surface: 'session',
  parentId: ev.sessionId,
  parentTitle: ev.goal || ev.sessionId,
  // ...
};
```

Add the field:

```ts
return {
  surface: 'session',
  parentId: ev.sessionId,
  parentTitle: ev.goal || ev.sessionId,
  originNode: (ev as { originNode?: string }).originNode,
  // ...
};
```

Reading the current shape first: `head -60 packages/app/src/lib/global-search/surfaces/sessions.ts` — adapt the field placement to match.

- [ ] **Step 2: Update `logs.ts` mapper symmetrically**

Same change in `packages/app/src/lib/global-search/surfaces/logs.ts` — add `originNode: (ev as { originNode?: string }).originNode` to the returned `Hit`.

- [ ] **Step 3: Real typecheck**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l`
Expected: equal to the Task 1 step 7 baseline.

- [ ] **Step 4: Run the app test suite — no regressions**

Run: `bun test --cwd packages/app 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/global-search/surfaces/sessions.ts \
        packages/app/src/lib/global-search/surfaces/logs.ts
git commit -m "feat(app/global-search/surfaces): thread originNode through sessions + logs mappers"
```

---

## Task 6: `mergeServerHits` preserves `unreachableNodes`

**Files:**
- Modify: `packages/app/src/lib/global-search/orchestrator.ts`
- Modify: `packages/app/test/lib/global-search/orchestrator.test.ts`

The orchestrator already merges Tier 2 + Tier 3 hits into a `SurfaceGroup`. It needs to also accept `unreachableNodes` from the cross-node proc result and preserve it on the merged group.

- [ ] **Step 1: Write the failing test**

Add to `packages/app/test/lib/global-search/orchestrator.test.ts`:

```ts
test('mergeServerHits preserves unreachableNodes from the merge call', () => {
  const initial: GroupedResults = [];
  const hits: Hit[] = [{
    surface: 'session',
    parentId: 's1',
    parentTitle: 'audit',
    score: 0.7,
    matchKind: 'exact',
    action: { kind: 'open-tab', tab: { tabKey: 'ops-session:s1', title: 's1', kind: 'ops-session' as const, instanceId: 's1', openedAt: 0 } },
  }];
  const merged = mergeServerHits(initial, 'session', hits, {
    append: true,
    unreachableNodes: ['mac-mini'],
  });
  const sess = merged.find((g) => g.surface === 'session')!;
  expect(sess.unreachableNodes).toEqual(['mac-mini']);
});

test('originNode flows through mergeServerHits unchanged', () => {
  const initial: GroupedResults = [];
  const hits: Hit[] = [{
    surface: 'session',
    parentId: 's1',
    parentTitle: 'audit',
    score: 0.7,
    matchKind: 'exact',
    originNode: 'mac-mini',
    action: { kind: 'open-tab', tab: { tabKey: 'ops-session:s1', title: 's1', kind: 'ops-session' as const, instanceId: 's1', openedAt: 0 } },
  }];
  const merged = mergeServerHits(initial, 'session', hits, { append: true });
  const sess = merged.find((g) => g.surface === 'session')!;
  expect(sess.hits[0]!.originNode).toBe('mac-mini');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/app test/lib/global-search/orchestrator.test.ts`
Expected: FAIL — `mergeServerHits` either doesn't accept `unreachableNodes` or doesn't preserve it.

- [ ] **Step 3: Implement**

In `packages/app/src/lib/global-search/orchestrator.ts`, find the `mergeServerHits` signature. Extend its options:

```ts
export interface MergeServerHitsOpts {
  append?: boolean;
  error?: string;
  unreachableNodes?: string[];   // NEW
}

export function mergeServerHits(
  current: GroupedResults,
  surface: SurfaceKind,
  hits: Hit[],
  opts: MergeServerHitsOpts = {},
): GroupedResults {
  // ...existing merge logic, write into the surface's group...
  // When applying to or creating the group, set:
  //   group.unreachableNodes = opts.unreachableNodes ?? group.unreachableNodes;
  // (preserve any prior value if the new merge call doesn't override)
}
```

(Match the existing function's actual structure — read it first via `grep -n "mergeServerHits" packages/app/src/lib/global-search/orchestrator.ts` and adapt the field assignment to that file's exact pattern.)

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/app test/lib/global-search/orchestrator.test.ts`
Expected: PASS — both new tests + all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/global-search/orchestrator.ts \
        packages/app/test/lib/global-search/orchestrator.test.ts
git commit -m "feat(app/global-search): mergeServerHits preserves unreachableNodes"
```

---

## Task 7: Hook integration — parallel local + remote waves

**Files:**
- Modify: `packages/app/src/lib/global-search/hooks/use-global-search.ts`
- Modify: `packages/app/test/lib/global-search/use-global-search.test.ts` (extend)

The hook today fires the local Tier 2 fetch. We add a second parallel fetch for the cross-node UI proc (sessions + logs) under the same Tier 2 debounce anchor. Each fetch's result merges into the same surface group via `mergeServerHits`.

- [ ] **Step 1: Locate the trpcUIClient import**

Run: `grep -n "trpcUIClient\|trpc.\\b" packages/app/src/lib/trpc.ts`

The UI client is already exported alongside the agent-router `trpc` client. Import it in the hook.

- [ ] **Step 2: Add the failing test**

Append to `packages/app/test/lib/global-search/use-global-search.test.ts`:

```ts
test('Tier 2 fires both local and cross-node fetches under one debounce anchor', () => {
  // Schedule helper validates the timer plan — both waves anchor at t+250ms.
  // We're not testing real network; just the timing contract.
  const t0 = Date.now();
  const sched = computeNextSchedule(t0);
  expect(sched.tier2At).toBe(t0 + 250);
  // Both local and remote scheduling should use the SAME anchor; the
  // helper exposes one tier2At value.
});
```

(If `computeNextSchedule` already returns just `tier2At`, the contract is "both fetches use the same anchor" — the integration is in the hook body, where both `trpc.opsSessionSearch.fetch` and `trpcUIClient.uiCrossNodeOpsSessionSearch.query` are invoked at the same setTimeout callback.)

- [ ] **Step 3: Run, verify the existing test still anchors as expected**

Run: `bun test --cwd packages/app test/lib/global-search/use-global-search.test.ts`
Expected: PASS — the assertion is structural; passes if the schedule fires both waves at the same tick.

- [ ] **Step 4: Update the hook to fire both waves**

In `packages/app/src/lib/global-search/hooks/use-global-search.ts`, find the Tier 2 setTimeout callback for sessions. The existing path looks like:

```ts
trpc.opsSessionSearch.fetch({ query }).then((r) =>
  setResults((cur) => mergeServerHits(cur, 'session', mapSessionHits(r.hits), { append: true })),
);
```

Add a parallel call alongside it:

```ts
trpcUIClient.uiCrossNodeOpsSessionSearch.query({ query }).then((r) =>
  setResults((cur) =>
    mergeServerHits(
      cur,
      'session',
      mapSessionHits(r.hits),  // mapSessionHits already preserves originNode (Task 5)
      { append: true, unreachableNodes: r.unreachableNodes },
    ),
  ),
);
```

Symmetric for logs:

```ts
trpc.logsSearch.fetch({ query }).then((r) =>
  setResults((cur) => mergeServerHits(cur, 'logs', mapLogHits(r.hits), { append: true })),
);
trpcUIClient.uiCrossNodeLogsSearch.query({ query }).then((r) =>
  setResults((cur) =>
    mergeServerHits(
      cur,
      'logs',
      mapLogHits(r.hits),
      { append: true, unreachableNodes: r.unreachableNodes },
    ),
  ),
);
```

Both fetches use the existing `AbortController` so a new keystroke cancels both in-flight.

- [ ] **Step 5: Run hook test**

Run: `bun test --cwd packages/app test/lib/global-search/use-global-search.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full app suite — no regressions**

Run: `bun test --cwd packages/app 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 7: Real typecheck**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l`
Expected: equal to the Task 1 step 7 baseline.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/lib/global-search/hooks/use-global-search.ts \
        packages/app/test/lib/global-search/use-global-search.test.ts
git commit -m "feat(app/global-search): hook fires local + cross-node Tier 2 waves in parallel"
```

---

## Task 8: Renderer — origin tag + unreachable footer

**Files:**
- Modify: `packages/app/src/shell/beacon/search-results-tree.tsx`

Two visual additions:
1. Per-parent-row origin tag, shown only when `hit.originNode` is defined and differs from the connected agent name.
2. Per-group footer showing `"⚠ N node(s) unreachable: name1, name2"` when `group.unreachableNodes` is non-empty.

No render-test setup in the repo; correctness is verified by typecheck and the Tier C UI flow (Task 9 step 5 below). Rendered behavior is best confirmed by hand or with the existing flow harness.

- [ ] **Step 1: Read the current renderer**

Run: `head -100 packages/app/src/shell/beacon/search-results-tree.tsx`

Locate where the parent row text is rendered, and where the per-group container ends (so we can append the footer there).

- [ ] **Step 2: Add the connected-node prop**

The renderer needs to know which node is "connected" to elide the tag for hits from that node. Add a prop:

```tsx
interface SearchResultsTreeProps {
  // ...existing props...
  connectedNode?: string;   // NEW
}
```

The caller (`shell/beacon/search-view.tsx` or the palette wrapper) supplies it from `trpcUIClient.uiGetActiveNode.useQuery()` (existing UI proc) — or from the kubeconfig context default if not set. Pattern: read the node name once, pass it in.

- [ ] **Step 3: Render the origin tag on parent rows**

Inside the per-parent-row JSX, append:

```tsx
{parent.hits[0]?.originNode && parent.hits[0].originNode !== connectedNode && (
  <span
    style={{
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--color-text-tertiary)',
      marginLeft: 8,
    }}
  >
    {parent.hits[0].originNode}
  </span>
)}
```

(Adapt to the actual JSX layout — the tag goes in whatever flex/inline container the row uses for trailing metadata.)

- [ ] **Step 4: Render the unreachable-nodes footer**

After the per-parent-row map, before the group's closing tag:

```tsx
{group.unreachableNodes && group.unreachableNodes.length > 0 && (
  <div
    style={{
      padding: '6px 12px',
      fontSize: 11,
      color: 'var(--color-text-tertiary)',
      borderTop: '1px solid var(--color-border-subtle)',
    }}
  >
    ⚠ {group.unreachableNodes.length} node{group.unreachableNodes.length === 1 ? '' : 's'} unreachable: {group.unreachableNodes.join(', ')}
  </div>
)}
```

- [ ] **Step 5: Wire the `connectedNode` prop from the caller**

In `packages/app/src/shell/beacon/search-view.tsx` (and any other consumer of `SearchResultsTree`):

```tsx
const active = trpcUIClient.uiGetActiveNode.useQuery();
// ...
<SearchResultsTree
  results={results}
  onActivate={onActivate}
  connectedNode={active.data?.nodeName}
/>
```

(`uiGetActiveNode`'s actual return shape may differ — check via `grep -n "uiGetActiveNode" packages/app/electron/trpc/dispatcher.ts` and adapt.)

- [ ] **Step 6: Real typecheck**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l`
Expected: equal to the Task 1 step 7 baseline.

- [ ] **Step 7: Run the full app suite**

Run: `bun test --cwd packages/app 2>&1 | tail -5`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/shell/beacon/search-results-tree.tsx \
        packages/app/src/shell/beacon/search-view.tsx
git commit -m "feat(app/shell): render originNode tag + unreachable-nodes footer"
```

---

## Task 9: Final validation, tag, ship

- [ ] **Step 1: Full app suite**

Run: `bun test --cwd packages/app 2>&1 | tail -5`
Expected: All tests pass.

- [ ] **Step 2: Full remote suite**

Run: `bun test --cwd packages/remote 2>&1 | tail -5`
Expected: All tests pass.

- [ ] **Step 3: Full core + cli suites — no surprise regressions**

```bash
bun test --cwd packages/core 2>&1 | tail -3
bun test --cwd packages/cli 2>&1 | tail -3
```
Expected: all green.

- [ ] **Step 4: Real typecheck — counts equal to Task 1 baselines**

```bash
bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l
bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | wc -l
```

Both should equal the values you recorded in Task 1 step 7. If either is higher, you have NOT met the bar — investigate, fix, re-run.

- [ ] **Step 5: Smoke-run UI flow tests (existing global-search-flow + palette-search-flow)**

Run: `bun run test:ui-flows -- --tier C --filter "global-search\|palette-search" 2>&1 | tail -10`
Expected: PASS or graceful SKIP.

- [ ] **Step 6: Tag**

```bash
git tag beacon-p3-cross-node-search
```

- [ ] **Step 7: Hand off**

Open a PR titled `feat(app): cross-node search + drop dead knowledgeSearch tier-2` against `main`. Body lists the spec link, summary of changes, the two new UI procs, and the schema additions. Reviewer steps: app + remote suites, typecheck, then a manual end-to-end with two agents in kubeconfig (a real `local` and a stubbed `mac-mini` peer with seeded session fixture) to exercise the cross-node path.

---

## Self-review checklist

**Spec coverage:**
- D1 (drop knowledge tier-2 entirely) → Task 1 (delete proc + surface)
- D2 (cross-node = sessions + logs only) → Task 4 (uiCrossNode procs only for sessions + logs; no knowledge fan-out)
- D3 (all-parallel, partial-success, footer) → Task 3 (`fanOutSurface` Promise.allSettled + per-node timeout), Task 4 (`unreachableNodes` returned), Task 8 (footer rendered)
- D4 (origin tag, default-elide on local) → Task 2 (schema), Task 5 (mappers thread originNode), Task 8 (renderer elides on connected node)
- D5 (connected-agent self-skip) → Task 3 (`listAgentNodes` excludes active node)
- Schema additions → Task 2
- Per-node timeout default 2000ms → Task 3 (`DEFAULT_TIMEOUT_MS`), Task 4 (proc default)
- AbortController cancellation → Task 3 (`fanOutSurface`'s child signals + outer signal listener), Task 7 (hook AbortController)
- Failure modes (timeout / rejected / aborted) → Task 3 (`NodeFailure.reason`)

**Placeholder scan:** Tasks 5, 6, 8 reference "match the existing function's actual structure / read it first via grep" — these are concrete grep commands to find the real shape, not open-ended TODOs. The engineer needs the surrounding code's actual signature to merge cleanly. No "implement later" or "TBD" anywhere.

**Type consistency:** `Hit.originNode?: string`, `SurfaceGroup.unreachableNodes?: string[]`, `NodeFailure.reason: 'timeout' | 'rejected' | 'aborted'`, `FanOutOpts<T>`, `FanOutResult<T>` are defined in Tasks 2, 3 — referenced unchanged in Tasks 4, 5, 6, 7, 8. UI proc names (`uiCrossNodeOpsSessionSearch`, `uiCrossNodeLogsSearch`) are spelled identically in Tasks 4, 7. The `mergeServerHits` opts gain `unreachableNodes?: string[]` in Task 6 and Task 7 passes that field unchanged.
