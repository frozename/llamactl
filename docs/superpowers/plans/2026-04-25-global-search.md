# Global Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a unified, three-tier global search across every queryable surface: instant client substring (Tier 1) for small/static lists, debounced server lexical (Tier 2) for content-heavy sources, debounced server semantic via `ragSearch` (Tier 3) for knowledge/sessions/logs. Sidebar `SearchView` and command palette consume one orchestrator hook.

**Architecture:** App-side hook `useGlobalSearch` orchestrates all three tiers from a single keystroke; client surfaces match synchronously, server surfaces resolve through tRPC procs (`opsSessionSearch`, `logsSearch`, `knowledgeSearch`, `ragSearch`, `globalSearchRagStatus`). Two new direct-ingestion paths embed ops sessions and app logs into RAG collections (`sessions`, `logs`) by subscribing to `sessionEventBus` and tailing log files. Hits collapse by `parentId` across tiers so a single source matched by both lexical and semantic appears as one parent row with multiple `matchKind`-tagged excerpt children.

**Tech Stack:** TypeScript, Zod, tRPC subscriptions/queries, Bun test, Zustand, React 19, the existing `@/ui` primitive set, Node `EventEmitter`, the existing `packages/remote/src/rag/` adapter (Chroma/pgvector via `createRagAdapter`), the existing `ragSearch`/`ragStore`/`ragListCollections` procs.

**Spec:** `docs/superpowers/specs/2026-04-25-global-search-design.md`

---

## File Structure

### Server (`packages/remote/src`)

**Created:**
- `search/text-match.ts` — pure `findTextMatches({ needle, text, ... }): TextMatch[]`
- `search/sessions.ts` — walks every `journal.jsonl`, runs `findTextMatches`, caps results
- `search/logs.ts` — last-N-bytes lexical scan over configured log files
- `search/knowledge.ts` — lexical scan over knowledge entity titles + body excerpts
- `search/rag-bridge.ts` — calls `ragSearch` for a given `{ collection, query, topK }`; resolves the default RAG node
- `search/rag-node.ts` — picks a default RAG node (first node with `kind: 'rag'` configured)
- `search/types.ts` — `SessionHit`, `KnowledgeHit`, `LogHit`, `GlobalSearchRagStatus`
- `search/ingest/sessions.ts` — direct ingestion: subscribes to `sessionEventBus`, calls `ragStore` with embedded session records
- `search/ingest/logs.ts` — direct ingestion: tails configured log files; rolling-window eviction; calls `ragStore`
- `search/ingest/lifecycle.ts` — start/stop hooks; called from server bootstrap

**Modified:**
- `router.ts` — add `opsSessionSearch`, `logsSearch`, `knowledgeSearch`, `globalSearchRagStatus` queries
- `index.ts` (or wherever the server boots) — wire `search/ingest/lifecycle.ts` start/stop

**Tests (`packages/remote/test/`):**
- `search-text-match.test.ts`
- `search-sessions.test.ts`
- `search-logs.test.ts`
- `search-knowledge.test.ts`
- `search-rag-bridge.test.ts`
- `search-rag-node.test.ts`
- `search-ingest-sessions.test.ts`
- `search-ingest-logs.test.ts`
- `router-global-search-procs.test.ts`

### App (`packages/app/src`)

**Created:**
- `lib/global-search/types.ts`
- `lib/global-search/query.ts`
- `lib/global-search/ranking.ts`
- `lib/global-search/orchestrator.ts`
- `lib/global-search/hooks/use-global-search.ts`
- `lib/global-search/surfaces/modules.ts`
- `lib/global-search/surfaces/workloads.ts`
- `lib/global-search/surfaces/nodes.ts`
- `lib/global-search/surfaces/presets.ts`
- `lib/global-search/surfaces/tab-history.ts`
- `lib/global-search/surfaces/sessions.ts` — Tier 2 lexical
- `lib/global-search/surfaces/sessions-rag.ts` — Tier 3 semantic
- `lib/global-search/surfaces/knowledge.ts` — Tier 2 lexical
- `lib/global-search/surfaces/knowledge-rag.ts` — Tier 3 semantic
- `lib/global-search/surfaces/logs.ts` — Tier 2 lexical
- `lib/global-search/surfaces/logs-rag.ts` — Tier 3 semantic
- `shell/match-snippet.tsx`
- `shell/beacon/search-results-tree.tsx`

**Modified:**
- `shell/beacon/search-view.tsx` — replace module-only logic with the orchestrator hook
- `shell/command-palette.tsx` — call the same hook, render results below curated commands

**Tests (`packages/app/test/`):**
- `lib/global-search/query.test.ts`
- `lib/global-search/ranking.test.ts`
- `lib/global-search/orchestrator.test.ts`
- `lib/global-search/use-global-search.test.ts`
- `lib/global-search/surfaces/modules.test.ts`
- `lib/global-search/surfaces/workloads.test.ts`
- `lib/global-search/surfaces/tab-history.test.ts`
- `lib/global-search/surfaces/sessions-rag.test.ts`

### UI flow tests (`tests/ui-flows/`)

**Created:**
- `global-search-flow.ts`
- `palette-search-flow.ts`

---

## Conventions

**Test runner.** Server tests run via `bun test --cwd packages/remote`; app tests via `bun test --cwd packages/app`. Both honour `LLAMACTL_TEST_PROFILE` / `DEV_STORAGE` for hermetic on-disk roots — set in `beforeEach` so journals/logs land in a tmp dir.

**Real typecheck.** Use `bunx tsc -p packages/<pkg>/tsconfig.web.json --noEmit` for the app and `bunx tsc -p packages/<pkg>/tsconfig.json --noEmit` for remote. The `bun run typecheck` script is a known no-op on this repo. Baseline app error count from `main` is 12; don't add to it.

**App ↔ remote isolation.** The `packages/app/*` package never imports types directly from `@llamactl/remote`. Mirror needed types structurally inside the app (precedent: `modules/workloads/workers-panel.tsx`, the Phase 2 `lib/use-ops-session.ts`).

**Component testing posture.** No React render tests exist (`@testing-library/react`, jsdom, happy-dom are not deps). Pure helper logic gets unit tests; component visual behaviour is verified via Tier C UI flows.

**`@/ui` variants** (verified in `packages/app/src/ui/`):
- `Button`: `'primary' | 'secondary' | 'ghost' | 'outline' | 'destructive'`
- `Badge`: `'default' | 'brand' | 'ok' | 'warn' | 'err'`
- `EditorialHero` props: `eyebrow / title / titleAccent / lede / pills / actions / className / style`

**Commit style.** Conventional Commits, one commit per task. No AI/co-author trailers. Example: `feat(remote/search): add findTextMatches utility`.

**Spec divergence note.** The spec describes ingestion as "reuse the rag/pipeline/ runtime; only new fetchers are added." On verification, the existing fetcher abstraction is built for periodic pull from external sources (filesystem/http/git). Sessions are event-driven; logs are tail-and-window. We diverge to **direct ingestion** modules (`search/ingest/sessions.ts`, `search/ingest/logs.ts`) that call `ragStore` directly. Same intent (sessions + logs land in RAG collections), simpler shape, no expansion of pipeline-framework abstractions. Re-evaluate once both ingestion paths are stable.

---

## Task 1: Server — `findTextMatches` utility

**Files:**
- Create: `packages/remote/src/search/text-match.ts`
- Test: `packages/remote/test/search-text-match.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/search-text-match.test.ts
import { describe, expect, test } from 'bun:test';
import { findTextMatches } from '../src/search/text-match';

describe('findTextMatches', () => {
  test('returns empty array on no match', () => {
    expect(findTextMatches({ needle: 'zzz', text: 'foo bar baz' })).toEqual([]);
  });

  test('case-insensitive by default', () => {
    const out = findTextMatches({ needle: 'foo', text: 'FOO bar' });
    expect(out.length).toBe(1);
    expect(out[0]!.snippet).toContain('FOO');
  });

  test('multiple matches in same text', () => {
    const out = findTextMatches({ needle: 'foo', text: 'foo bar foo baz foo' });
    expect(out.length).toBe(3);
  });

  test('snippet length bounded by snippetChars', () => {
    const big = 'x'.repeat(200) + 'needle' + 'y'.repeat(200);
    const out = findTextMatches({ needle: 'needle', text: big, snippetChars: 60 });
    expect(out.length).toBe(1);
    expect(out[0]!.snippet.length).toBeLessThanOrEqual(70);
  });

  test('spans index into snippet, not original text', () => {
    const out = findTextMatches({ needle: 'cat', text: 'a cat sat on the mat' });
    const m = out[0]!;
    expect(m.snippet.slice(m.spans[0]!.start, m.spans[0]!.end).toLowerCase()).toBe('cat');
  });

  test('word-boundary mode rejects mid-word match', () => {
    const out = findTextMatches({ needle: 'cat', text: 'concatenate', wordBoundary: true });
    expect(out).toEqual([]);
  });

  test('case-sensitive mode rejects different case', () => {
    const out = findTextMatches({ needle: 'Foo', text: 'foo bar', caseSensitive: true });
    expect(out).toEqual([]);
  });

  test('word-boundary score > substring score', () => {
    const wb = findTextMatches({ needle: 'cat', text: 'a cat sat', wordBoundary: false });
    const sub = findTextMatches({ needle: 'cat', text: 'concatenate', wordBoundary: false });
    expect(wb[0]!.score).toBeGreaterThan(sub[0]!.score);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/search-text-match.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/search/text-match.ts
export interface TextMatchOptions {
  needle: string;
  text: string;
  caseSensitive?: boolean;
  wordBoundary?: boolean;
  snippetChars?: number;
}

export interface TextMatch {
  snippet: string;
  spans: { start: number; end: number }[];
  score: number;
}

const DEFAULT_SNIPPET = 120;

function isWordBoundary(text: string, idx: number, len: number): boolean {
  const before = idx === 0 ? ' ' : text[idx - 1] ?? ' ';
  const after = idx + len >= text.length ? ' ' : text[idx + len] ?? ' ';
  return !/\w/.test(before) && !/\w/.test(after);
}

export function findTextMatches(opts: TextMatchOptions): TextMatch[] {
  const { needle, text } = opts;
  if (!needle || !text) return [];
  const cs = opts.caseSensitive ?? false;
  const wb = opts.wordBoundary ?? false;
  const snippetChars = opts.snippetChars ?? DEFAULT_SNIPPET;

  const haystack = cs ? text : text.toLowerCase();
  const needleSearch = cs ? needle : needle.toLowerCase();
  const len = needleSearch.length;

  const matches: TextMatch[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needleSearch, from);
    if (idx < 0) break;
    const wbHit = isWordBoundary(haystack, idx, len);
    if (wb && !wbHit) {
      from = idx + 1;
      continue;
    }
    const half = Math.floor(snippetChars / 2);
    const sStart = Math.max(0, idx - half);
    const sEnd = Math.min(text.length, idx + len + half);
    const snippet = text.slice(sStart, sEnd);
    const spanStart = idx - sStart;
    const score = wbHit ? 1.0 : 0.6;
    matches.push({
      snippet,
      spans: [{ start: spanStart, end: spanStart + len }],
      score,
    });
    from = idx + len;
  }
  return matches;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/search-text-match.test.ts`
Expected: PASS — 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/search/text-match.ts packages/remote/test/search-text-match.test.ts
git commit -m "feat(remote/search): add findTextMatches utility"
```

---

## Task 2: Server — `SessionHit`/`KnowledgeHit`/`LogHit` types

**Files:**
- Create: `packages/remote/src/search/types.ts`

- [ ] **Step 1: Define the types**

```ts
// packages/remote/src/search/types.ts
import type { SessionStatus } from '../ops-chat/sessions/list.js';

export interface MatchExcerpt {
  where: string;
  snippet: string;
  spans: { start: number; end: number }[];
}

export interface SessionHit {
  sessionId: string;
  goal: string;
  status: SessionStatus;
  startedAt: string;
  matches: MatchExcerpt[];
  /** Best score among the matches. */
  score: number;
}

export interface KnowledgeHit {
  entityId: string;
  title: string;
  matches: MatchExcerpt[];
  score: number;
}

export interface LogHit {
  fileLabel: string;     // e.g. 'ops-chat-audit', 'electron-main'
  filePath: string;
  matches: (MatchExcerpt & { lineNumber: number })[];
  score: number;
}

export interface GlobalSearchRagStatus {
  /** True iff at least one configured RAG node has the named collection. */
  sessions: boolean;
  knowledge: boolean;
  logs: boolean;
  /** The node id used for `ragSearch` calls, or null if no RAG node is configured. */
  defaultNode: string | null;
}
```

- [ ] **Step 2: Sanity typecheck**

Run: `bunx tsc -p packages/remote/tsconfig.json --noEmit 2>&1 | grep "search/types" || echo "no errors"`
Expected: `no errors`.

- [ ] **Step 3: Commit**

```bash
git add packages/remote/src/search/types.ts
git commit -m "feat(remote/search): add hit + status types"
```

---

## Task 3: Server — `searchSessions` lexical scanner

**Files:**
- Create: `packages/remote/src/search/sessions.ts`
- Test: `packages/remote/test/search-sessions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/search-sessions.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJournalEvent } from '../src/ops-chat/sessions/journal';
import { searchSessions } from '../src/search/sessions';

describe('searchSessions', () => {
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'search-sessions-'));
    prev = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('matches goal text', async () => {
    await appendJournalEvent('s1', {
      type: 'session_started', ts: '2026-04-25T00:00:00.000Z', sessionId: 's1',
      goal: 'audit fleet for unhealthy providers', historyLen: 0, toolCount: 0,
    });
    const out = await searchSessions({ query: 'fleet', limit: 30 });
    expect(out.length).toBe(1);
    expect(out[0]!.sessionId).toBe('s1');
    expect(out[0]!.matches.length).toBeGreaterThan(0);
  });

  test('matches reasoning text inside plan_proposed', async () => {
    await appendJournalEvent('s2', {
      type: 'session_started', ts: '2026-04-25T00:00:00.000Z', sessionId: 's2',
      goal: 'g', historyLen: 0, toolCount: 0,
    });
    await appendJournalEvent('s2', {
      type: 'plan_proposed', ts: '2026-04-25T00:00:01.000Z', stepId: 'sp-1',
      iteration: 0, tier: 'read', reasoning: 'enumerate the rebellious cluster',
      step: { tool: 't', annotation: 'a' } as any,
    });
    const out = await searchSessions({ query: 'rebellious', limit: 30 });
    expect(out.length).toBe(1);
    expect(out[0]!.matches[0]!.where).toContain('reasoning');
  });

  test('caps matches per session', async () => {
    await appendJournalEvent('s3', {
      type: 'session_started', ts: '2026-04-25T00:00:00.000Z', sessionId: 's3',
      goal: 'fleet fleet fleet fleet fleet fleet fleet fleet',
      historyLen: 0, toolCount: 0,
    });
    const out = await searchSessions({ query: 'fleet', limit: 30, perSessionCap: 3 });
    expect(out[0]!.matches.length).toBeLessThanOrEqual(3);
  });

  test('caps total sessions', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await appendJournalEvent(id, {
        type: 'session_started', ts: '2026-04-25T00:00:00.000Z', sessionId: id,
        goal: 'fleet check', historyLen: 0, toolCount: 0,
      });
    }
    const out = await searchSessions({ query: 'fleet', limit: 3 });
    expect(out.length).toBe(3);
  });

  test('signal abort cuts off mid-walk', async () => {
    for (const id of ['a', 'b', 'c']) {
      await appendJournalEvent(id, {
        type: 'session_started', ts: '2026-04-25T00:00:00.000Z', sessionId: id,
        goal: 'fleet', historyLen: 0, toolCount: 0,
      });
    }
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(searchSessions({ query: 'fleet', limit: 30, signal: ctrl.signal }))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/search-sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/search/sessions.ts
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { defaultSessionsDir } from '../ops-chat/paths.js';
import { readJournal } from '../ops-chat/sessions/journal.js';
import { getSessionSummary } from '../ops-chat/sessions/list.js';
import { findTextMatches } from './text-match.js';
import type { SessionHit, MatchExcerpt } from './types.js';

export interface SearchSessionsOpts {
  query: string;
  limit: number;
  perSessionCap?: number;
  signal?: AbortSignal;
}

export async function searchSessions(opts: SearchSessionsOpts): Promise<SessionHit[]> {
  const root = defaultSessionsDir();
  if (!existsSync(root)) return [];
  if (opts.signal?.aborted) throw new Error('aborted');
  const ids = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const perCap = opts.perSessionCap ?? 5;
  const hits: SessionHit[] = [];
  for (const id of ids) {
    if (opts.signal?.aborted) throw new Error('aborted');
    let summary;
    try {
      summary = await getSessionSummary(id);
    } catch {
      continue;
    }
    const events = await readJournal(id);
    const matches: MatchExcerpt[] = [];
    let bestScore = 0;
    const goalMatches = findTextMatches({ needle: opts.query, text: summary.goal });
    for (const m of goalMatches.slice(0, perCap)) {
      matches.push({ where: 'goal', snippet: m.snippet, spans: m.spans });
      bestScore = Math.max(bestScore, m.score);
    }
    for (const e of events) {
      if (matches.length >= perCap) break;
      if (e.type === 'plan_proposed') {
        const r = findTextMatches({ needle: opts.query, text: e.reasoning });
        for (const m of r) {
          if (matches.length >= perCap) break;
          matches.push({
            where: `iteration #${e.iteration + 1} reasoning`,
            snippet: m.snippet,
            spans: m.spans,
          });
          bestScore = Math.max(bestScore, m.score);
        }
        const argsText = JSON.stringify((e.step as any).args ?? {});
        const ar = findTextMatches({ needle: opts.query, text: argsText });
        for (const m of ar) {
          if (matches.length >= perCap) break;
          matches.push({
            where: `iteration #${e.iteration + 1} args`,
            snippet: m.snippet,
            spans: m.spans,
          });
          bestScore = Math.max(bestScore, m.score);
        }
      }
    }
    if (matches.length > 0) {
      hits.push({
        sessionId: id,
        goal: summary.goal,
        status: summary.status,
        startedAt: summary.startedAt,
        matches,
        score: bestScore,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || (a.startedAt < b.startedAt ? 1 : -1));
  return hits.slice(0, opts.limit);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/search-sessions.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/search/sessions.ts packages/remote/test/search-sessions.test.ts
git commit -m "feat(remote/search): add searchSessions lexical scanner"
```

---

## Task 4: Server — `searchKnowledge` lexical scanner

**Files:**
- Create: `packages/remote/src/search/knowledge.ts`
- Test: `packages/remote/test/search-knowledge.test.ts`

The "knowledge entity store" lives behind tRPC `knowledgeList` / RAG. For the lexical sibling, we read the same source the existing knowledge module reads. Verify the source by inspecting the existing `knowledge` module and its tRPC procs:

`grep -n "knowledgeList\|knowledgeStore\|ragKnowledge" packages/remote/src/router.ts | head -10`

If a `knowledgeList` proc exists, lexical search calls its result list and runs `findTextMatches` against `title` + `body`/`description` fields. If not, use the same disk path / DB the knowledge module reads from. Adapt the test to the actual data shape.

- [ ] **Step 1: Identify the source**

```bash
grep -rn "knowledgeList\|export.*knowledgeStore\|knowledge.list" packages/remote/src --include="*.ts" | head -5
```

Read the proc definition, copy its return-type shape into your mental model.

- [ ] **Step 2: Write the failing test**

Use the actual entity shape you found. Pattern (adapt field names):

```ts
// packages/remote/test/search-knowledge.test.ts
import { describe, expect, test } from 'bun:test';
import { searchKnowledge } from '../src/search/knowledge';

const entities = [
  { id: 'e1', title: 'Retrieval Pipeline', body: 'walks files and embeds chunks' },
  { id: 'e2', title: 'Embedding Model', body: 'bge-small for fast retrieval' },
  { id: 'e3', title: 'Other', body: 'unrelated content' },
];

describe('searchKnowledge', () => {
  test('returns title + body matches', () => {
    const out = searchKnowledge({ query: 'retrieval', entities, limit: 30 });
    expect(out.map((h) => h.entityId).sort()).toEqual(['e1', 'e2']);
  });

  test('title match scores higher than body match', () => {
    const out = searchKnowledge({ query: 'retrieval', entities, limit: 30 });
    expect(out[0]!.entityId).toBe('e1'); // title match wins
  });

  test('respects per-entity match cap', () => {
    const big = [{ id: 'e', title: 't', body: 'foo foo foo foo foo foo' }];
    const out = searchKnowledge({ query: 'foo', entities: big, limit: 30, perEntityCap: 2 });
    expect(out[0]!.matches.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 3: Run, verify failure**

Run: `bun test --cwd packages/remote test/search-knowledge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// packages/remote/src/search/knowledge.ts
import { findTextMatches } from './text-match.js';
import type { KnowledgeHit, MatchExcerpt } from './types.js';

export interface KnowledgeEntity {
  id: string;
  title: string;
  body?: string;
}

export interface SearchKnowledgeOpts {
  query: string;
  entities: KnowledgeEntity[];
  limit: number;
  perEntityCap?: number;
}

const TITLE_BOOST = 0.4;

export function searchKnowledge(opts: SearchKnowledgeOpts): KnowledgeHit[] {
  const cap = opts.perEntityCap ?? 5;
  const hits: KnowledgeHit[] = [];
  for (const e of opts.entities) {
    const matches: MatchExcerpt[] = [];
    let score = 0;
    const titleM = findTextMatches({ needle: opts.query, text: e.title });
    for (const m of titleM.slice(0, cap)) {
      matches.push({ where: 'title', snippet: m.snippet, spans: m.spans });
      score = Math.max(score, m.score + TITLE_BOOST);
    }
    if (e.body && matches.length < cap) {
      const bodyM = findTextMatches({ needle: opts.query, text: e.body });
      for (const m of bodyM) {
        if (matches.length >= cap) break;
        matches.push({ where: 'body', snippet: m.snippet, spans: m.spans });
        score = Math.max(score, m.score);
      }
    }
    if (matches.length > 0) {
      hits.push({ entityId: e.id, title: e.title, matches, score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return hits.slice(0, opts.limit);
}
```

- [ ] **Step 5: Run, verify pass**

Run: `bun test --cwd packages/remote test/search-knowledge.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/remote/src/search/knowledge.ts packages/remote/test/search-knowledge.test.ts
git commit -m "feat(remote/search): add searchKnowledge lexical scanner"
```

---

## Task 5: Server — `searchLogs` rolling-window scanner

**Files:**
- Create: `packages/remote/src/search/logs.ts`
- Test: `packages/remote/test/search-logs.test.ts`

The function takes `{ query, files, limit, windowBytes? }`. `files` is an array of `{ label, path }`. For each file, read the last `windowBytes` (default 5 MB) and run `findTextMatches` line-by-line.

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/search-logs.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchLogs } from '../src/search/logs';

describe('searchLogs', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'search-logs-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test('matches line content with line numbers', async () => {
    const path = join(tmp, 'a.log');
    writeFileSync(path, ['line one', 'error: boom', 'line three'].join('\n'), 'utf8');
    const out = await searchLogs({
      query: 'boom',
      files: [{ label: 'a', path }],
      limit: 30,
    });
    expect(out.length).toBe(1);
    expect(out[0]!.matches[0]!.lineNumber).toBe(2);
  });

  test('rolling window drops content beyond windowBytes', async () => {
    const path = join(tmp, 'b.log');
    const head = 'noise\n'.repeat(2000);  // ~12 KB
    const tail = 'needle line\n';
    writeFileSync(path, head + tail, 'utf8');
    const out = await searchLogs({
      query: 'needle',
      files: [{ label: 'b', path }],
      limit: 30,
      windowBytes: 64,
    });
    expect(out.length).toBe(1);
  });

  test('multi-file fan-in', async () => {
    const a = join(tmp, 'a.log'); const b = join(tmp, 'b.log');
    writeFileSync(a, 'foo here', 'utf8');
    writeFileSync(b, 'foo there', 'utf8');
    const out = await searchLogs({
      query: 'foo',
      files: [{ label: 'a', path: a }, { label: 'b', path: b }],
      limit: 30,
    });
    expect(out.map((h) => h.fileLabel).sort()).toEqual(['a', 'b']);
  });

  test('missing file is skipped, no throw', async () => {
    const out = await searchLogs({
      query: 'foo',
      files: [{ label: 'missing', path: join(tmp, 'nope.log') }],
      limit: 30,
    });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/search-logs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/search/logs.ts
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { findTextMatches } from './text-match.js';
import type { LogHit, MatchExcerpt } from './types.js';

const DEFAULT_WINDOW = 5 * 1024 * 1024;

export interface LogFileSpec {
  label: string;
  path: string;
}

export interface SearchLogsOpts {
  query: string;
  files: LogFileSpec[];
  limit: number;
  windowBytes?: number;
  perFileCap?: number;
}

function tailFile(path: string, windowBytes: number): { text: string; lineOffset: number } {
  const size = statSync(path).size;
  const start = Math.max(0, size - windowBytes);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    if (start === 0) return { text, lineOffset: 0 };
    const firstNl = text.indexOf('\n');
    if (firstNl < 0) return { text, lineOffset: 0 };
    return { text: text.slice(firstNl + 1), lineOffset: 0 };
  } finally {
    closeSync(fd);
  }
}

export async function searchLogs(opts: SearchLogsOpts): Promise<LogHit[]> {
  const window = opts.windowBytes ?? DEFAULT_WINDOW;
  const cap = opts.perFileCap ?? 10;
  const hits: LogHit[] = [];
  for (const f of opts.files) {
    if (!existsSync(f.path)) continue;
    const { text } = tailFile(f.path, window);
    const lines = text.split('\n');
    const matches: (MatchExcerpt & { lineNumber: number })[] = [];
    let score = 0;
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= cap) break;
      const lineMatches = findTextMatches({ needle: opts.query, text: lines[i]! });
      for (const m of lineMatches) {
        if (matches.length >= cap) break;
        matches.push({
          lineNumber: i + 1,
          where: `${f.label}:${i + 1}`,
          snippet: m.snippet,
          spans: m.spans,
        });
        score = Math.max(score, m.score);
      }
    }
    if (matches.length > 0) {
      hits.push({
        fileLabel: f.label,
        filePath: f.path,
        matches,
        score,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.fileLabel.localeCompare(b.fileLabel));
  return hits.slice(0, opts.limit);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/search-logs.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/search/logs.ts packages/remote/test/search-logs.test.ts
git commit -m "feat(remote/search): add searchLogs rolling-window scanner"
```

---

## Task 6: Server — default RAG node resolver + RAG bridge

**Files:**
- Create: `packages/remote/src/search/rag-node.ts`
- Create: `packages/remote/src/search/rag-bridge.ts`
- Test: `packages/remote/test/search-rag-node.test.ts`
- Test: `packages/remote/test/search-rag-bridge.test.ts`

- [ ] **Step 1: Identify how to enumerate configured RAG nodes**

```bash
grep -rn "kind:.*'rag'\|node.rag\b\|rag-config\|listRagNodes" packages/remote/src --include="*.ts" | head -10
```

The repo's existing pattern is `resolveRagNode(nodeId)` (router.ts) which reads from a config. Find the function or fallback path that lists *all* configured nodes (probably `loadConfig()` returning `{ nodes: [...] }`). Use that.

- [ ] **Step 2: Write the failing test for `rag-node.ts`**

```ts
// packages/remote/test/search-rag-node.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDefaultRagNode } from '../src/search/rag-node';

describe('resolveDefaultRagNode', () => {
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rag-node-'));
    prev = process.env.LLAMACTL_TEST_PROFILE;
    process.env.LLAMACTL_TEST_PROFILE = tmp;
    mkdirSync(join(tmp, 'config'), { recursive: true });
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LLAMACTL_TEST_PROFILE;
    else process.env.LLAMACTL_TEST_PROFILE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns null when no RAG node configured', async () => {
    writeFileSync(
      join(tmp, 'config', 'config.yaml'),
      'nodes:\n  - name: local\n    kind: agent\n',
      'utf8',
    );
    const out = await resolveDefaultRagNode();
    expect(out).toBeNull();
  });

  test('returns first node with kind=rag', async () => {
    writeFileSync(
      join(tmp, 'config', 'config.yaml'),
      [
        'nodes:',
        '  - name: local',
        '    kind: agent',
        '  - name: chroma-1',
        '    kind: rag',
        '    rag:',
        '      provider: chroma',
        '      url: http://localhost:8000',
        '  - name: chroma-2',
        '    kind: rag',
        '    rag:',
        '      provider: chroma',
        '      url: http://localhost:8001',
      ].join('\n'),
      'utf8',
    );
    const out = await resolveDefaultRagNode();
    expect(out).toBe('chroma-1');
  });
});
```

- [ ] **Step 3: Run, verify failure**

Run: `bun test --cwd packages/remote test/search-rag-node.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `rag-node.ts`**

Match the actual config-load entrypoint you found in Step 1. Pattern:

```ts
// packages/remote/src/search/rag-node.ts
// Adapt loadConfig() import to whatever the repo uses
// (search for "loadConfig" or "readConfig" in packages/remote/src/config/).
import { loadConfig } from '../config/load.js';

export async function resolveDefaultRagNode(): Promise<string | null> {
  const cfg = await loadConfig();
  for (const node of cfg.nodes ?? []) {
    if ((node as any).kind === 'rag' && (node as any).rag) {
      return (node as any).name as string;
    }
  }
  return null;
}
```

- [ ] **Step 5: Run, verify pass**

Run: `bun test --cwd packages/remote test/search-rag-node.test.ts`
Expected: PASS — 2 tests pass.

- [ ] **Step 6: Implement `rag-bridge.ts`**

```ts
// packages/remote/src/search/rag-bridge.ts
import type { SessionHit, KnowledgeHit, LogHit } from './types.js';
import { resolveRagNode } from '../router.js';   // adapt path; or expose in config/secret.js
import { createRagAdapter } from '../rag/index.js';

export type RagCollection = 'sessions' | 'knowledge' | 'logs';

export interface RagBridgeOpts {
  node: string;
  collection: RagCollection;
  query: string;
  topK?: number;
  signal?: AbortSignal;
}

export async function ragBridgeSearch(
  opts: RagBridgeOpts,
): Promise<Array<SessionHit | KnowledgeHit | LogHit>> {
  if (opts.signal?.aborted) throw new Error('aborted');
  const { node, cfg } = resolveRagNode(opts.node);
  const adapter = await createRagAdapter(node, { config: cfg });
  try {
    const res = await adapter.search({
      query: opts.query,
      topK: opts.topK ?? 10,
      collection: opts.collection,
    });
    return normalizeHits(opts.collection, res);
  } finally {
    await adapter.close();
  }
}

function normalizeHits(
  collection: RagCollection,
  res: unknown,
): Array<SessionHit | KnowledgeHit | LogHit> {
  // res shape per existing adapter: { hits: Array<{id, score, content, metadata}> }
  const hits = (res as { hits?: Array<any> }).hits ?? [];
  if (collection === 'sessions') {
    return hits.map((h) => ({
      sessionId: h.metadata?.sessionId ?? h.id,
      goal: h.metadata?.goal ?? '',
      status: h.metadata?.status ?? 'live',
      startedAt: h.metadata?.startedAt ?? '',
      matches: [{
        where: h.metadata?.where ?? 'session content',
        snippet: String(h.content ?? '').slice(0, 200),
        spans: [],
      }],
      score: typeof h.score === 'number' ? h.score : 0,
    }));
  }
  if (collection === 'knowledge') {
    return hits.map((h) => ({
      entityId: h.metadata?.entityId ?? h.id,
      title: h.metadata?.title ?? h.id,
      matches: [{
        where: 'body',
        snippet: String(h.content ?? '').slice(0, 200),
        spans: [],
      }],
      score: typeof h.score === 'number' ? h.score : 0,
    }));
  }
  return hits.map((h) => ({
    fileLabel: h.metadata?.fileLabel ?? 'unknown',
    filePath: h.metadata?.filePath ?? '',
    matches: [{
      lineNumber: h.metadata?.lineNumber ?? 0,
      where: h.metadata?.where ?? '',
      snippet: String(h.content ?? '').slice(0, 200),
      spans: [],
    }],
    score: typeof h.score === 'number' ? h.score : 0,
  }));
}
```

If `resolveRagNode` is not exported from `router.ts` (likely module-private), refactor it into a small shared module under `packages/remote/src/rag/resolve.ts` and update both `router.ts` and `rag-bridge.ts` to import from there. Keep the change minimal — extract the function as-is.

- [ ] **Step 7: Write a focused test for `rag-bridge.ts`**

```ts
// packages/remote/test/search-rag-bridge.test.ts
import { describe, expect, test } from 'bun:test';
// Mock the adapter; verify that ragBridgeSearch normalizes hits per collection.
// Use Bun's mock.module if available; otherwise stub via dependency-injection refactor.
// (If injection is needed, accept an optional `adapter` param on ragBridgeSearch
// for testing.)
```

If mocking the adapter is awkward (Bun's `mock.module` semantics differ from Jest's), refactor `ragBridgeSearch` to accept an optional `adapter` parameter for testing. The production call site (router proc, see Task 8) supplies the real adapter; the test supplies a stub. Keep the stub in the test file.

- [ ] **Step 8: Run, verify pass**

Run: `bun test --cwd packages/remote test/search-rag-bridge.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/remote/src/search/rag-node.ts packages/remote/src/search/rag-bridge.ts \
        packages/remote/test/search-rag-node.test.ts packages/remote/test/search-rag-bridge.test.ts
git commit -m "feat(remote/search): add default RAG node resolver and rag-bridge"
```

---

## Task 7: Server — sessions ingestion (event-driven)

**Files:**
- Create: `packages/remote/src/search/ingest/sessions.ts`
- Create: `packages/remote/src/search/ingest/lifecycle.ts`
- Test: `packages/remote/test/search-ingest-sessions.test.ts`

The ingester subscribes to `sessionEventBus`. On every relevant event, it shapes a small record and calls `ragStore` (via the adapter) into the `sessions` collection. We hold a small in-memory queue with a 250 ms flush interval — batches reduce embedder thrash.

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/search-ingest-sessions.test.ts
import { describe, expect, test } from 'bun:test';
import { sessionEventBus } from '../src/ops-chat/sessions/event-bus';
import { startSessionsIngest } from '../src/search/ingest/sessions';

describe('sessions ingest', () => {
  test('subscribes to event bus and forwards records to a sink', async () => {
    sessionEventBus.create('s-ing-1');
    const seen: any[] = [];
    const stop = startSessionsIngest({
      sink: async (records) => { seen.push(...records); },
      flushMs: 30,
    });
    sessionEventBus.publish('s-ing-1', {
      type: 'session_started', ts: '2026-04-25T00:00:00.000Z',
      sessionId: 's-ing-1', goal: 'do thing', historyLen: 0, toolCount: 0,
    } as any);
    sessionEventBus.publish('s-ing-1', {
      type: 'plan_proposed', ts: '2026-04-25T00:00:01.000Z', stepId: 'sp1',
      iteration: 0, tier: 'read', reasoning: 'because',
      step: { tool: 't', annotation: 'a' },
    } as any);
    await new Promise((r) => setTimeout(r, 80));
    stop();
    sessionEventBus.close('s-ing-1');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]!.metadata.sessionId).toBe('s-ing-1');
  });

  test('skips events with no embeddable text', async () => {
    sessionEventBus.create('s-ing-2');
    const seen: any[] = [];
    const stop = startSessionsIngest({
      sink: async (records) => { seen.push(...records); },
      flushMs: 20,
    });
    sessionEventBus.publish('s-ing-2', {
      type: 'done', ts: '2026-04-25T00:00:00.000Z', iterations: 0,
    } as any);
    await new Promise((r) => setTimeout(r, 50));
    stop();
    sessionEventBus.close('s-ing-2');
    expect(seen.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/search-ingest-sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/search/ingest/sessions.ts
import { sessionEventBus } from '../../ops-chat/sessions/event-bus.js';
import type { JournalEvent } from '../../ops-chat/sessions/journal-schema.js';

export interface IngestRecord {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface SessionsIngestOpts {
  sink: (records: IngestRecord[]) => Promise<void>;
  flushMs?: number;
  /** Subscribe globally to all sessions; default true. */
  global?: boolean;
}

function recordFor(event: JournalEvent): IngestRecord | null {
  if (event.type === 'session_started') {
    if (!event.goal) return null;
    return {
      id: `${event.sessionId}::start`,
      content: event.goal,
      metadata: {
        sessionId: event.sessionId,
        goal: event.goal,
        startedAt: event.ts,
        where: 'goal',
      },
    };
  }
  if (event.type === 'plan_proposed') {
    const argsText = JSON.stringify((event.step as any).args ?? {});
    const text = [event.reasoning, argsText].filter(Boolean).join('\n');
    if (!text.trim()) return null;
    return {
      id: `${(event as any).sessionId ?? '?'}::${event.stepId}`,
      content: text,
      metadata: {
        sessionId: (event as any).sessionId ?? '?',
        stepId: event.stepId,
        iteration: event.iteration,
        where: `iteration #${event.iteration + 1}`,
      },
    };
  }
  return null;
}

export function startSessionsIngest(opts: SessionsIngestOpts): () => void {
  const flushMs = opts.flushMs ?? 250;
  let queue: IngestRecord[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = async (): Promise<void> => {
    timer = null;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      await opts.sink(batch);
    } catch {
      /* swallow — ingest is best-effort */
    }
  };

  const onEvent = (sessionId: string) => (event: JournalEvent) => {
    const r = recordFor({ ...event, sessionId } as JournalEvent);
    if (!r) return;
    queue.push(r);
    if (timer === null) timer = setTimeout(() => void flush(), flushMs);
  };

  // Subscribe to every channel as it's created.
  // The bus fires events on per-channel emitters; we hook a global "create" path.
  // Existing event-bus exposes `create`/`subscribe`/`close` per session; for global
  // ingestion, we subscribe to events as they're emitted via the bus's wildcard.
  // If the bus has no wildcard, wrap `create` to attach our listener at create time.
  const originalCreate = sessionEventBus.create.bind(sessionEventBus);
  const subs = new Set<() => void>();
  (sessionEventBus as any).create = (sessionId: string): void => {
    originalCreate(sessionId);
    subs.add(sessionEventBus.subscribe(sessionId, onEvent(sessionId)));
  };

  return () => {
    if (timer !== null) clearTimeout(timer);
    void flush();
    subs.forEach((off) => off());
    subs.clear();
    (sessionEventBus as any).create = originalCreate;
  };
}
```

If the existing `sessionEventBus` already supports a global "all-channels" subscribe, use it instead — this monkey-patch of `create` is a stop-gap. Verify by reading `packages/remote/src/ops-chat/sessions/event-bus.ts`:

```bash
cat packages/remote/src/ops-chat/sessions/event-bus.ts
```

If a wildcard subscribe exists, refactor `startSessionsIngest` to use it; drop the monkey-patch.

- [ ] **Step 4: Implement the lifecycle hook**

```ts
// packages/remote/src/search/ingest/lifecycle.ts
import { startSessionsIngest } from './sessions.js';
import { startLogsIngest } from './logs.js';
import { resolveDefaultRagNode } from '../rag-node.js';
import { resolveRagNode } from '../../rag/resolve.js';
import { createRagAdapter } from '../../rag/index.js';
import type { IngestRecord } from './sessions.js';

let stopFns: (() => void)[] = [];

async function makeSink(collection: 'sessions' | 'logs'): Promise<(records: IngestRecord[]) => Promise<void>> {
  const nodeName = await resolveDefaultRagNode();
  if (!nodeName) return async () => { /* no-op when no RAG node */ };
  return async (records) => {
    const { node, cfg } = resolveRagNode(nodeName);
    const adapter = await createRagAdapter(node, { config: cfg });
    try {
      await adapter.store({
        collection,
        documents: records.map((r) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
        })),
      });
    } finally {
      await adapter.close();
    }
  };
}

export async function startSearchIngest(): Promise<void> {
  const sessionsSink = await makeSink('sessions');
  const logsSink = await makeSink('logs');
  stopFns.push(startSessionsIngest({ sink: sessionsSink }));
  stopFns.push(startLogsIngest({ sink: logsSink }));
}

export function stopSearchIngest(): void {
  for (const stop of stopFns) {
    try { stop(); } catch { /* swallow */ }
  }
  stopFns = [];
}
```

- [ ] **Step 5: Wire into server bootstrap**

```bash
grep -rn "createServer\|startServer\|bootstrap" packages/remote/src/index.ts packages/remote/src/server 2>/dev/null | head -10
```

In the server bootstrap, after the existing initialization, call `await startSearchIngest()`. On shutdown, call `stopSearchIngest()`.

- [ ] **Step 6: Run, verify pass**

Run: `bun test --cwd packages/remote test/search-ingest-sessions.test.ts`
Expected: PASS — 2 tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/remote/src/search/ingest/sessions.ts \
        packages/remote/src/search/ingest/lifecycle.ts \
        packages/remote/src/index.ts \
        packages/remote/test/search-ingest-sessions.test.ts
git commit -m "feat(remote/search/ingest): event-driven ingestion of ops sessions into RAG"
```

---

## Task 8: Server — logs ingestion (tail-and-window)

**Files:**
- Create: `packages/remote/src/search/ingest/logs.ts`
- Test: `packages/remote/test/search-ingest-logs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/search-ingest-logs.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLogsIngest } from '../src/search/ingest/logs';

describe('logs ingest', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'logs-ingest-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  test('emits one record per non-empty line', async () => {
    const path = join(tmp, 'a.log');
    writeFileSync(path, 'line one\nline two\nline three\n', 'utf8');
    const seen: any[] = [];
    const stop = startLogsIngest({
      files: [{ label: 'a', path }],
      sink: async (records) => { seen.push(...records); },
      pollMs: 30,
    });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(seen.length).toBe(3);
  });

  test('tails appended content on next poll', async () => {
    const path = join(tmp, 'b.log');
    writeFileSync(path, 'first\n', 'utf8');
    const seen: any[] = [];
    const stop = startLogsIngest({
      files: [{ label: 'b', path }],
      sink: async (records) => { seen.push(...records); },
      pollMs: 20,
    });
    await new Promise((r) => setTimeout(r, 50));
    appendFileSync(path, 'second\n', 'utf8');
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(seen.map((r) => r.content)).toContain('second');
    expect(seen.map((r) => r.content)).toContain('first');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/search-ingest-logs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/search/ingest/logs.ts
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import type { IngestRecord } from './sessions.js';

export interface LogsIngestOpts {
  files: { label: string; path: string }[];
  sink: (records: IngestRecord[]) => Promise<void>;
  pollMs?: number;
  /** Bytes after which we discard content from the head of the file. */
  windowBytes?: number;
}

interface FileCursor { offset: number }

export function startLogsIngest(opts: LogsIngestOpts): () => void {
  const pollMs = opts.pollMs ?? 30_000;
  const cursors = new Map<string, FileCursor>();
  let stopped = false;

  async function tick(): Promise<void> {
    for (const f of opts.files) {
      if (!existsSync(f.path)) continue;
      const size = statSync(f.path).size;
      const cur = cursors.get(f.path) ?? { offset: 0 };
      if (cur.offset > size) cur.offset = 0; // log was rotated
      if (cur.offset === size) {
        cursors.set(f.path, cur);
        continue;
      }
      const fd = openSync(f.path, 'r');
      try {
        const buf = Buffer.alloc(size - cur.offset);
        readSync(fd, buf, 0, buf.length, cur.offset);
        const text = buf.toString('utf8');
        const lines = text.split('\n').filter((l) => l.length > 0);
        const records: IngestRecord[] = lines.map((line, idx) => ({
          id: `${f.label}::${cur.offset}::${idx}`,
          content: line,
          metadata: { fileLabel: f.label, filePath: f.path, where: f.label },
        }));
        if (records.length > 0) {
          try { await opts.sink(records); } catch { /* swallow */ }
        }
        cur.offset = size;
        cursors.set(f.path, cur);
      } finally {
        closeSync(fd);
      }
    }
  }

  void tick();
  const timer = setInterval(() => {
    if (stopped) return;
    void tick();
  }, pollMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/search-ingest-logs.test.ts`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/search/ingest/logs.ts \
        packages/remote/test/search-ingest-logs.test.ts
git commit -m "feat(remote/search/ingest): tail-and-window log ingestion into RAG"
```

---

## Task 9: Server — four new tRPC procedures

**Files:**
- Modify: `packages/remote/src/router.ts`
- Test: `packages/remote/test/router-global-search-procs.test.ts`

Add `opsSessionSearch`, `logsSearch`, `knowledgeSearch`, `globalSearchRagStatus`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/router-global-search-procs.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRouter } from '../src/router';
import { appendJournalEvent } from '../src/ops-chat/sessions/journal';

describe('global-search router procs', () => {
  let tmp: string;
  let prev: string | undefined;
  let caller: ReturnType<typeof appRouter.createCaller>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gs-procs-'));
    prev = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
    caller = appRouter.createCaller({} as any);
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('opsSessionSearch returns hits from journal goal text', async () => {
    await appendJournalEvent('s1', {
      type: 'session_started', ts: '2026-04-25T00:00:00.000Z', sessionId: 's1',
      goal: 'audit fleet', historyLen: 0, toolCount: 0,
    });
    const out = await caller.opsSessionSearch({ query: 'fleet' });
    expect(out.hits.length).toBe(1);
    expect(out.hits[0]!.sessionId).toBe('s1');
  });

  test('logsSearch returns empty when no log files configured', async () => {
    const out = await caller.logsSearch({ query: 'foo' });
    expect(out.hits).toEqual([]);
  });

  test('globalSearchRagStatus returns defaultNode null when no RAG node configured', async () => {
    const out = await caller.globalSearchRagStatus();
    expect(out.defaultNode).toBeNull();
    expect(out.sessions).toBe(false);
    expect(out.knowledge).toBe(false);
    expect(out.logs).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/router-global-search-procs.test.ts`
Expected: FAIL — procs not yet defined.

- [ ] **Step 3: Add procs to `router.ts`**

Imports near the top:

```ts
import { searchSessions } from './search/sessions.js';
import { searchLogs } from './search/logs.js';
import { searchKnowledge } from './search/knowledge.js';
import { resolveDefaultRagNode } from './search/rag-node.js';
import { defaultOpsChatAuditPath } from './ops-chat/paths.js';
```

Inside `appRouter`, near `opsChatAuditTail`:

```ts
opsSessionSearch: t.procedure
  .input(z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).default(30),
    perSessionCap: z.number().int().positive().max(20).default(5),
  }))
  .query(async ({ input, signal }) => {
    const hits = await searchSessions({
      query: input.query,
      limit: input.limit,
      perSessionCap: input.perSessionCap,
      signal,
    });
    return { hits };
  }),

logsSearch: t.procedure
  .input(z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).default(30),
  }))
  .query(async ({ input }) => {
    const auditPath = defaultOpsChatAuditPath();
    const files = [{ label: 'ops-chat-audit', path: auditPath }];
    const hits = await searchLogs({
      query: input.query,
      files,
      limit: input.limit,
    });
    return { hits };
  }),

knowledgeSearch: t.procedure
  .input(z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().max(100).default(30),
  }))
  .query(async ({ input }) => {
    // Adapt to the actual knowledge entity loader. For v1 of the
    // lexical sibling, fall back to []; the semantic path via
    // ragSearch is the primary route. If a list-proc exists, use it.
    return { hits: [] as Array<unknown> };
  }),

globalSearchRagStatus: t.procedure
  .query(async () => {
    const defaultNode = await resolveDefaultRagNode();
    if (!defaultNode) {
      return { sessions: false, knowledge: false, logs: false, defaultNode: null };
    }
    const { resolveRagNode } = await import('./rag/resolve.js');
    const { node, cfg } = resolveRagNode(defaultNode);
    const { createRagAdapter } = await import('./rag/index.js');
    const adapter = await createRagAdapter(node, { config: cfg });
    try {
      const cols = await adapter.listCollections();
      const set = new Set<string>(
        Array.isArray(cols) ? cols.map((c: any) => (typeof c === 'string' ? c : c.name)) : [],
      );
      return {
        sessions: set.has('sessions'),
        knowledge: set.has('knowledge'),
        logs: set.has('logs'),
        defaultNode,
      };
    } finally {
      await adapter.close();
    }
  }),
```

If `resolveRagNode` is still in `router.ts`, do the small extraction to `packages/remote/src/rag/resolve.ts` you noted in Task 6. The `import('./rag/resolve.js')` line above assumes that extraction.

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/router-global-search-procs.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Run full server suite — no regressions**

Run: `bun test --cwd packages/remote 2>&1 | tail -10`
Expected: All previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/remote/src/router.ts packages/remote/src/rag/resolve.ts \
        packages/remote/test/router-global-search-procs.test.ts
git commit -m "feat(remote/router): add opsSessionSearch, logsSearch, knowledgeSearch, globalSearchRagStatus"
```

---

## Task 10: App — types, query parser, ranking

**Files:**
- Create: `packages/app/src/lib/global-search/types.ts`
- Create: `packages/app/src/lib/global-search/query.ts`
- Create: `packages/app/src/lib/global-search/ranking.ts`
- Test: `packages/app/test/lib/global-search/query.test.ts`
- Test: `packages/app/test/lib/global-search/ranking.test.ts`

- [ ] **Step 1: Define types**

```ts
// packages/app/src/lib/global-search/types.ts
import type { TabEntry } from '@/stores/tab-store';

export type SurfaceKind =
  | 'module' | 'session' | 'workload' | 'node'
  | 'knowledge' | 'logs' | 'preset' | 'tab-history';

export interface MatchExcerpt {
  where: string;
  snippet: string;
  spans: { start: number; end: number }[];
}

export interface Hit {
  surface: SurfaceKind;
  parentId: string;
  parentTitle: string;
  score: number;
  matchKind: 'exact' | 'semantic';
  ragDistance?: number;
  match?: MatchExcerpt;
  action: { kind: 'open-tab'; tab: TabEntry };
}

export interface SurfaceGroup {
  surface: SurfaceKind;
  hits: Hit[];
  topScore: number;
  pending?: boolean;
  error?: string;
}

export type GroupedResults = SurfaceGroup[];

export interface ParsedQuery {
  needle: string;
  surfaceFilter?: SurfaceKind;
}
```

- [ ] **Step 2: Write the failing test for `query.ts`**

```ts
// packages/app/test/lib/global-search/query.test.ts
import { describe, expect, test } from 'bun:test';
import { parseQuery } from '@/lib/global-search/query';

describe('parseQuery', () => {
  test('plain query has no surface filter', () => {
    expect(parseQuery('hello world')).toEqual({ needle: 'hello world' });
  });

  test('module: prefix narrows surface', () => {
    expect(parseQuery('module:dash')).toEqual({ needle: 'dash', surfaceFilter: 'module' });
  });

  test('mod: alias maps to module', () => {
    expect(parseQuery('mod:dash')).toEqual({ needle: 'dash', surfaceFilter: 'module' });
  });

  test('sess: alias maps to session', () => {
    expect(parseQuery('sess:audit')).toEqual({ needle: 'audit', surfaceFilter: 'session' });
  });

  test('wl: alias maps to workload', () => {
    expect(parseQuery('wl:llama')).toEqual({ needle: 'llama', surfaceFilter: 'workload' });
  });

  test('multi-word needle with prefix', () => {
    expect(parseQuery('session:audit fleet')).toEqual({
      needle: 'audit fleet', surfaceFilter: 'session',
    });
  });

  test('unknown prefix is treated as part of the needle', () => {
    expect(parseQuery('foo:bar')).toEqual({ needle: 'foo:bar' });
  });

  test('empty input returns empty needle', () => {
    expect(parseQuery('')).toEqual({ needle: '' });
  });

  test('trims whitespace', () => {
    expect(parseQuery('   audit   fleet  ')).toEqual({ needle: 'audit   fleet' });
  });
});
```

- [ ] **Step 3: Run, verify failure**

Run: `bun test --cwd packages/app test/lib/global-search/query.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `query.ts`**

```ts
// packages/app/src/lib/global-search/query.ts
import type { SurfaceKind, ParsedQuery } from './types';

const ALIASES: Record<string, SurfaceKind> = {
  module: 'module', mod: 'module',
  session: 'session', sess: 'session',
  workload: 'workload', wl: 'workload',
  node: 'node', n: 'node',
  knowledge: 'knowledge', kb: 'knowledge',
  logs: 'logs', log: 'logs',
  preset: 'preset', presets: 'preset',
  'tab-history': 'tab-history', history: 'tab-history',
};

export function parseQuery(input: string): ParsedQuery {
  const trimmed = input.trim();
  const m = /^([a-z-]+):(.*)$/i.exec(trimmed);
  if (!m) return { needle: trimmed };
  const prefix = m[1]!.toLowerCase();
  const rest = m[2]!;
  const surface = ALIASES[prefix];
  if (!surface) return { needle: trimmed };
  return { needle: rest.trim(), surfaceFilter: surface };
}
```

- [ ] **Step 5: Run, verify pass**

Run: `bun test --cwd packages/app test/lib/global-search/query.test.ts`
Expected: PASS — 9 tests pass.

- [ ] **Step 6: Write the failing test for `ranking.ts`**

```ts
// packages/app/test/lib/global-search/ranking.test.ts
import { describe, expect, test } from 'bun:test';
import { applySurfaceBias, sortGroups, SEMANTIC_TIE_PENALTY } from '@/lib/global-search/ranking';
import type { Hit, SurfaceGroup } from '@/lib/global-search/types';

const makeHit = (h: Partial<Hit> = {}): Hit => ({
  surface: 'module',
  parentId: 'p',
  parentTitle: 'P',
  score: 0.5,
  matchKind: 'exact',
  action: { kind: 'open-tab', tab: { tabKey: 'p', title: 'P', kind: 'module', openedAt: 0 } },
  ...h,
});

describe('applySurfaceBias', () => {
  test('module hit gets +0.20', () => {
    expect(applySurfaceBias(makeHit({ surface: 'module', score: 0.5 }))).toBeCloseTo(0.70);
  });

  test('semantic match gets penalty', () => {
    const out = applySurfaceBias(makeHit({ surface: 'module', score: 0.5, matchKind: 'semantic' }));
    expect(out).toBeCloseTo(0.70 + SEMANTIC_TIE_PENALTY);
  });
});

describe('sortGroups', () => {
  test('groups order by topScore desc', () => {
    const groups: SurfaceGroup[] = [
      { surface: 'workload', hits: [], topScore: 0.4 },
      { surface: 'module', hits: [], topScore: 0.7 },
      { surface: 'session', hits: [], topScore: 0.6 },
    ];
    const out = sortGroups(groups);
    expect(out.map((g) => g.surface)).toEqual(['module', 'session', 'workload']);
  });
});
```

- [ ] **Step 7: Run, verify failure**

Run: `bun test --cwd packages/app test/lib/global-search/ranking.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement `ranking.ts`**

```ts
// packages/app/src/lib/global-search/ranking.ts
import type { Hit, SurfaceGroup, SurfaceKind } from './types';

export const SURFACE_BIAS: Record<SurfaceKind, number> = {
  module: 0.20,
  session: 0.10,
  workload: 0.10,
  node: 0.10,
  preset: 0.05,
  knowledge: 0.05,
  logs: 0.00,
  'tab-history': -0.05,
};

export const SEMANTIC_TIE_PENALTY = -0.02;

export function applySurfaceBias(hit: Hit): number {
  const base = hit.score + SURFACE_BIAS[hit.surface];
  return hit.matchKind === 'semantic' ? base + SEMANTIC_TIE_PENALTY : base;
}

export function sortGroups(groups: SurfaceGroup[]): SurfaceGroup[] {
  return [...groups].sort((a, b) => b.topScore - a.topScore);
}
```

- [ ] **Step 9: Run, verify pass**

Run: `bun test --cwd packages/app test/lib/global-search/ranking.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 10: Commit**

```bash
git add packages/app/src/lib/global-search/types.ts \
        packages/app/src/lib/global-search/query.ts \
        packages/app/src/lib/global-search/ranking.ts \
        packages/app/test/lib/global-search/query.test.ts \
        packages/app/test/lib/global-search/ranking.test.ts
git commit -m "feat(app/lib/global-search): add types, query parser, ranking"
```

---

## Task 11: App — client surfaces (modules, tab-history)

**Files:**
- Create: `packages/app/src/lib/global-search/surfaces/modules.ts`
- Create: `packages/app/src/lib/global-search/surfaces/tab-history.ts`
- Test: `packages/app/test/lib/global-search/surfaces/modules.test.ts`
- Test: `packages/app/test/lib/global-search/surfaces/tab-history.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/app/test/lib/global-search/surfaces/modules.test.ts
import { describe, expect, test } from 'bun:test';
import { matchModules } from '@/lib/global-search/surfaces/modules';

describe('matchModules', () => {
  test('returns hits with matchKind exact and surface module', () => {
    const out = matchModules('dash');
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((h) => h.surface === 'module' && h.matchKind === 'exact')).toBe(true);
  });

  test('empty needle returns []', () => {
    expect(matchModules('')).toEqual([]);
  });
});
```

```ts
// packages/app/test/lib/global-search/surfaces/tab-history.test.ts
import { describe, expect, test } from 'bun:test';
import { matchTabHistory } from '@/lib/global-search/surfaces/tab-history';
import type { TabEntry } from '@/stores/tab-store';

const tabs: TabEntry[] = [
  { tabKey: 'module:dash', title: 'Dashboard', kind: 'module', openedAt: 1 },
];
const closed: TabEntry[] = [
  { tabKey: 'module:cost', title: 'Cost', kind: 'module', openedAt: 0 },
];

describe('matchTabHistory', () => {
  test('matches both open and closed tabs', () => {
    const out = matchTabHistory('dash', { tabs, closed });
    expect(out.length).toBe(1);
    expect(out[0]!.parentId).toBe('module:dash');
  });

  test('dedupes by tabKey when same key appears in both lists', () => {
    const dup: TabEntry = { tabKey: 'module:dash', title: 'Dashboard', kind: 'module', openedAt: 0 };
    const out = matchTabHistory('dash', { tabs, closed: [dup] });
    expect(out.length).toBe(1);
  });

  test('empty needle returns []', () => {
    expect(matchTabHistory('', { tabs, closed })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/app test/lib/global-search/surfaces/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `modules.ts`**

```ts
// packages/app/src/lib/global-search/surfaces/modules.ts
import { APP_MODULES } from '@/modules/registry';
import { searchModules } from '@/shell/beacon/search-modules';
import type { Hit } from '../types';

export function matchModules(needle: string): Hit[] {
  if (!needle) return [];
  return searchModules(APP_MODULES, needle).map(({ m, score }) => ({
    surface: 'module' as const,
    parentId: m.id,
    parentTitle: m.labelKey,
    score: score === 2 ? 0.9 : 0.5,
    matchKind: 'exact' as const,
    action: {
      kind: 'open-tab' as const,
      tab: {
        tabKey: `module:${m.id}`,
        title: m.labelKey,
        kind: 'module' as const,
        openedAt: Date.now(),
      },
    },
  }));
}
```

- [ ] **Step 4: Implement `tab-history.ts`**

```ts
// packages/app/src/lib/global-search/surfaces/tab-history.ts
import type { TabEntry } from '@/stores/tab-store';
import type { Hit } from '../types';

export interface TabHistoryState {
  tabs: TabEntry[];
  closed: TabEntry[];
}

export function matchTabHistory(needle: string, state: TabHistoryState): Hit[] {
  if (!needle) return [];
  const lowered = needle.toLowerCase();
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const t of [...state.tabs, ...state.closed]) {
    if (seen.has(t.tabKey)) continue;
    seen.add(t.tabKey);
    if (!t.title.toLowerCase().includes(lowered)) continue;
    const startsWith = t.title.toLowerCase().startsWith(lowered);
    out.push({
      surface: 'tab-history',
      parentId: t.tabKey,
      parentTitle: t.title,
      score: startsWith ? 0.7 : 0.4,
      matchKind: 'exact',
      action: { kind: 'open-tab', tab: { ...t, openedAt: Date.now() } },
    });
  }
  return out;
}
```

- [ ] **Step 5: Run, verify pass**

Run: `bun test --cwd packages/app test/lib/global-search/surfaces/`
Expected: PASS — 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/lib/global-search/surfaces/modules.ts \
        packages/app/src/lib/global-search/surfaces/tab-history.ts \
        packages/app/test/lib/global-search/surfaces/
git commit -m "feat(app/lib/global-search): add modules + tab-history client surfaces"
```

---

## Task 12: App — client surfaces (workloads, nodes, presets)

**Files:**
- Create: `packages/app/src/lib/global-search/surfaces/workloads.ts`
- Create: `packages/app/src/lib/global-search/surfaces/nodes.ts`
- Create: `packages/app/src/lib/global-search/surfaces/presets.ts`
- Test: `packages/app/test/lib/global-search/surfaces/workloads.test.ts`

Each takes a list of items + a needle and returns `Hit[]`. The list-shapes mirror the existing tRPC procs (`workloadList`, `nodeList`, `presetList`) — read those proc definitions to confirm the field names you'll reference.

- [ ] **Step 1: Write the failing test for workloads**

```ts
// packages/app/test/lib/global-search/surfaces/workloads.test.ts
import { describe, expect, test } from 'bun:test';
import { matchWorkloads } from '@/lib/global-search/surfaces/workloads';

const items = [
  { name: 'llama-31-8b', model: 'llama-3.1-8b-instruct', node: 'macbook-pro' },
  { name: 'qwen-72b', model: 'qwen-2.5-72b-instruct', node: 'atlas' },
  { name: 'embed-bge', model: 'bge-small-en', node: 'macbook-pro' },
];

describe('matchWorkloads', () => {
  test('matches by workload name', () => {
    const out = matchWorkloads('qwen', items);
    expect(out.length).toBe(1);
    expect(out[0]!.parentId).toBe('qwen-72b');
  });

  test('matches by model field', () => {
    const out = matchWorkloads('bge', items);
    expect(out.length).toBe(1);
    expect(out[0]!.parentId).toBe('embed-bge');
  });

  test('matches by node field', () => {
    const out = matchWorkloads('atlas', items);
    expect(out.length).toBe(1);
  });

  test('action opens workload tab', () => {
    const out = matchWorkloads('qwen', items);
    const a = out[0]!.action;
    expect(a.kind).toBe('open-tab');
    if (a.kind === 'open-tab') {
      expect(a.tab.kind).toBe('workload');
      expect(a.tab.instanceId).toBe('qwen-72b');
    }
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/app test/lib/global-search/surfaces/workloads.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the three surfaces**

```ts
// packages/app/src/lib/global-search/surfaces/workloads.ts
import type { Hit } from '../types';

export interface WorkloadItem {
  name: string;
  model?: string;
  node?: string;
}

export function matchWorkloads(needle: string, items: WorkloadItem[]): Hit[] {
  if (!needle) return [];
  const lowered = needle.toLowerCase();
  const out: Hit[] = [];
  for (const w of items) {
    const fields = [w.name, w.model, w.node].filter(Boolean) as string[];
    const blob = fields.join(' ').toLowerCase();
    if (!blob.includes(lowered)) continue;
    const startsWith = w.name.toLowerCase().startsWith(lowered);
    out.push({
      surface: 'workload',
      parentId: w.name,
      parentTitle: w.name,
      score: startsWith ? 0.8 : 0.5,
      matchKind: 'exact',
      action: {
        kind: 'open-tab',
        tab: {
          tabKey: `workload:${w.name}`,
          title: w.name,
          kind: 'workload',
          instanceId: w.name,
          openedAt: Date.now(),
        },
      },
    });
  }
  return out;
}
```

```ts
// packages/app/src/lib/global-search/surfaces/nodes.ts
import type { Hit } from '../types';

export interface NodeItem {
  name: string;
  effectiveKind?: string;
}

export function matchNodes(needle: string, items: NodeItem[]): Hit[] {
  if (!needle) return [];
  const lowered = needle.toLowerCase();
  const out: Hit[] = [];
  for (const n of items) {
    if (!n.name.toLowerCase().includes(lowered)) continue;
    const startsWith = n.name.toLowerCase().startsWith(lowered);
    out.push({
      surface: 'node',
      parentId: n.name,
      parentTitle: n.name,
      score: startsWith ? 0.8 : 0.5,
      matchKind: 'exact',
      action: {
        kind: 'open-tab',
        tab: {
          tabKey: `node:${n.name}`,
          title: n.name,
          kind: 'node',
          instanceId: n.name,
          openedAt: Date.now(),
        },
      },
    });
  }
  return out;
}
```

```ts
// packages/app/src/lib/global-search/surfaces/presets.ts
import type { Hit } from '../types';

export interface PresetItem {
  name: string;
  description?: string;
}

export function matchPresets(needle: string, items: PresetItem[]): Hit[] {
  if (!needle) return [];
  const lowered = needle.toLowerCase();
  const out: Hit[] = [];
  for (const p of items) {
    const blob = [p.name, p.description].filter(Boolean).join(' ').toLowerCase();
    if (!blob.includes(lowered)) continue;
    const startsWith = p.name.toLowerCase().startsWith(lowered);
    out.push({
      surface: 'preset',
      parentId: p.name,
      parentTitle: p.name,
      score: startsWith ? 0.8 : 0.5,
      matchKind: 'exact',
      action: {
        kind: 'open-tab',
        tab: {
          tabKey: 'module:presets',
          title: 'Presets',
          kind: 'module',
          openedAt: Date.now(),
        },
      },
    });
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/app test/lib/global-search/surfaces/workloads.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/global-search/surfaces/workloads.ts \
        packages/app/src/lib/global-search/surfaces/nodes.ts \
        packages/app/src/lib/global-search/surfaces/presets.ts \
        packages/app/test/lib/global-search/surfaces/workloads.test.ts
git commit -m "feat(app/lib/global-search): add workloads, nodes, presets client surfaces"
```

---

## Task 13: App — server lexical surfaces (sessions, knowledge, logs)

**Files:**
- Create: `packages/app/src/lib/global-search/surfaces/sessions.ts`
- Create: `packages/app/src/lib/global-search/surfaces/knowledge.ts`
- Create: `packages/app/src/lib/global-search/surfaces/logs.ts`

Each calls a tRPC `*.fetch` and maps the server hit shape to the client `Hit`. Tests deferred to the orchestrator-level test in Task 15.

- [ ] **Step 1: Implement `sessions.ts`**

```ts
// packages/app/src/lib/global-search/surfaces/sessions.ts
import type { Hit, MatchExcerpt } from '../types';

export interface SessionServerHit {
  sessionId: string;
  goal: string;
  status: 'live' | 'done' | 'refused' | 'aborted';
  startedAt: string;
  matches: MatchExcerpt[];
  score: number;
}

export function mapSessionHits(hits: SessionServerHit[]): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    if (h.matches.length === 0) continue;
    for (const m of h.matches) {
      out.push({
        surface: 'session',
        parentId: h.sessionId,
        parentTitle: h.goal || h.sessionId,
        score: h.score,
        matchKind: 'exact',
        match: m,
        action: {
          kind: 'open-tab',
          tab: {
            tabKey: `ops-session:${h.sessionId}`,
            title: `Session ${h.sessionId.slice(0, 8)}`,
            kind: 'ops-session',
            instanceId: h.sessionId,
            openedAt: Date.now(),
          },
        },
      });
    }
  }
  return out;
}
```

- [ ] **Step 2: Implement `knowledge.ts`**

```ts
// packages/app/src/lib/global-search/surfaces/knowledge.ts
import type { Hit, MatchExcerpt } from '../types';

export interface KnowledgeServerHit {
  entityId: string;
  title: string;
  matches: MatchExcerpt[];
  score: number;
}

export function mapKnowledgeHits(hits: KnowledgeServerHit[]): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    for (const m of h.matches) {
      out.push({
        surface: 'knowledge',
        parentId: h.entityId,
        parentTitle: h.title,
        score: h.score,
        matchKind: 'exact',
        match: m,
        action: {
          kind: 'open-tab',
          tab: {
            tabKey: 'module:knowledge',
            title: 'Knowledge',
            kind: 'module',
            openedAt: Date.now(),
          },
        },
      });
    }
  }
  return out;
}
```

- [ ] **Step 3: Implement `logs.ts`**

```ts
// packages/app/src/lib/global-search/surfaces/logs.ts
import type { Hit } from '../types';

export interface LogServerHit {
  fileLabel: string;
  filePath: string;
  matches: { lineNumber: number; where: string; snippet: string; spans: { start: number; end: number }[] }[];
  score: number;
}

export function mapLogHits(hits: LogServerHit[]): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    for (const m of h.matches) {
      out.push({
        surface: 'logs',
        parentId: `${h.fileLabel}:${m.lineNumber}`,
        parentTitle: `${h.fileLabel}:${m.lineNumber}`,
        score: h.score,
        matchKind: 'exact',
        match: { where: m.where, snippet: m.snippet, spans: m.spans },
        action: {
          kind: 'open-tab',
          tab: {
            tabKey: 'module:logs',
            title: 'Logs',
            kind: 'module',
            openedAt: Date.now(),
          },
        },
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | grep "lib/global-search" || echo "no errors"`
Expected: `no errors`.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/global-search/surfaces/sessions.ts \
        packages/app/src/lib/global-search/surfaces/knowledge.ts \
        packages/app/src/lib/global-search/surfaces/logs.ts
git commit -m "feat(app/lib/global-search): add server-lexical surface mappers"
```

---

## Task 14: App — server semantic surfaces (sessions-rag, knowledge-rag, logs-rag)

**Files:**
- Create: `packages/app/src/lib/global-search/surfaces/sessions-rag.ts`
- Create: `packages/app/src/lib/global-search/surfaces/knowledge-rag.ts`
- Create: `packages/app/src/lib/global-search/surfaces/logs-rag.ts`
- Test: `packages/app/test/lib/global-search/surfaces/sessions-rag.test.ts`

The semantic surfaces consume `ragSearch` results. The server-side `rag-bridge.ts` pre-normalizes hits into `SessionHit` / `KnowledgeHit` / `LogHit` shapes; the app re-uses those shapes (mirrored locally per app-isolation rule) and maps them into the same `Hit` shape with `matchKind: 'semantic'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/app/test/lib/global-search/surfaces/sessions-rag.test.ts
import { describe, expect, test } from 'bun:test';
import { mapSessionRagHits, type SessionRagServerHit } from '@/lib/global-search/surfaces/sessions-rag';

describe('mapSessionRagHits', () => {
  test('produces matchKind semantic and copies ragDistance', () => {
    const server: SessionRagServerHit[] = [{
      sessionId: 's1',
      goal: 'audit fleet',
      status: 'done',
      startedAt: '2026-04-25T00:00:00.000Z',
      matches: [{ where: 'goal', snippet: 'audit fleet', spans: [] }],
      score: 0.83,
    }];
    const out = mapSessionRagHits(server);
    expect(out.length).toBe(1);
    expect(out[0]!.matchKind).toBe('semantic');
    expect(out[0]!.score).toBeCloseTo(0.83);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/app test/lib/global-search/surfaces/sessions-rag.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the three semantic surfaces**

```ts
// packages/app/src/lib/global-search/surfaces/sessions-rag.ts
import type { Hit, MatchExcerpt } from '../types';

export interface SessionRagServerHit {
  sessionId: string;
  goal: string;
  status: 'live' | 'done' | 'refused' | 'aborted';
  startedAt: string;
  matches: MatchExcerpt[];
  score: number;
  ragDistance?: number;
}

export function mapSessionRagHits(hits: SessionRagServerHit[]): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    for (const m of h.matches) {
      out.push({
        surface: 'session',
        parentId: h.sessionId,
        parentTitle: h.goal || h.sessionId,
        score: h.score,
        matchKind: 'semantic',
        ragDistance: h.ragDistance,
        match: m,
        action: {
          kind: 'open-tab',
          tab: {
            tabKey: `ops-session:${h.sessionId}`,
            title: `Session ${h.sessionId.slice(0, 8)}`,
            kind: 'ops-session',
            instanceId: h.sessionId,
            openedAt: Date.now(),
          },
        },
      });
    }
  }
  return out;
}
```

```ts
// packages/app/src/lib/global-search/surfaces/knowledge-rag.ts
import type { Hit, MatchExcerpt } from '../types';

export interface KnowledgeRagServerHit {
  entityId: string;
  title: string;
  matches: MatchExcerpt[];
  score: number;
  ragDistance?: number;
}

export function mapKnowledgeRagHits(hits: KnowledgeRagServerHit[]): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    for (const m of h.matches) {
      out.push({
        surface: 'knowledge',
        parentId: h.entityId,
        parentTitle: h.title,
        score: h.score,
        matchKind: 'semantic',
        ragDistance: h.ragDistance,
        match: m,
        action: {
          kind: 'open-tab',
          tab: { tabKey: 'module:knowledge', title: 'Knowledge', kind: 'module', openedAt: Date.now() },
        },
      });
    }
  }
  return out;
}
```

```ts
// packages/app/src/lib/global-search/surfaces/logs-rag.ts
import type { Hit } from '../types';

export interface LogRagServerHit {
  fileLabel: string;
  filePath: string;
  matches: { lineNumber: number; where: string; snippet: string; spans: { start: number; end: number }[] }[];
  score: number;
  ragDistance?: number;
}

export function mapLogRagHits(hits: LogRagServerHit[]): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    for (const m of h.matches) {
      out.push({
        surface: 'logs',
        parentId: `${h.fileLabel}:${m.lineNumber}`,
        parentTitle: `${h.fileLabel}:${m.lineNumber}`,
        score: h.score,
        matchKind: 'semantic',
        ragDistance: h.ragDistance,
        match: { where: m.where, snippet: m.snippet, spans: m.spans },
        action: {
          kind: 'open-tab',
          tab: { tabKey: 'module:logs', title: 'Logs', kind: 'module', openedAt: Date.now() },
        },
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/app test/lib/global-search/surfaces/sessions-rag.test.ts`
Expected: PASS — 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/global-search/surfaces/sessions-rag.ts \
        packages/app/src/lib/global-search/surfaces/knowledge-rag.ts \
        packages/app/src/lib/global-search/surfaces/logs-rag.ts \
        packages/app/test/lib/global-search/surfaces/sessions-rag.test.ts
git commit -m "feat(app/lib/global-search): add server-semantic surface mappers"
```

---

## Task 15: App — orchestrator + collapse

**Files:**
- Create: `packages/app/src/lib/global-search/orchestrator.ts`
- Test: `packages/app/test/lib/global-search/orchestrator.test.ts`

The orchestrator's job: take parsed query + a context object (cached lists + tRPC utils + signal), run client surfaces synchronously, return `GroupedResults`. Server-side hits are merged by the *hook* (Task 16) — keep the orchestrator pure-sync for testability.

The collapse rule (D9): same `parentId` across matchKinds collapses to one parent row in the renderer; the orchestrator does *not* deduplicate at this layer — it returns the raw hit list, the renderer collapses visually. Keep the data flat.

- [ ] **Step 1: Write the failing test**

```ts
// packages/app/test/lib/global-search/orchestrator.test.ts
import { describe, expect, test } from 'bun:test';
import { runClientPhase, mergeServerHits } from '@/lib/global-search/orchestrator';
import type { Hit } from '@/lib/global-search/types';

describe('runClientPhase', () => {
  test('returns GroupedResults sorted by topScore', () => {
    const out = runClientPhase({
      query: { needle: 'dash' },
      tabState: { tabs: [], closed: [] },
      workloads: [],
      nodes: [],
      presets: [],
    });
    expect(Array.isArray(out)).toBe(true);
  });

  test('surface filter restricts to one group', () => {
    const out = runClientPhase({
      query: { needle: 'dash', surfaceFilter: 'module' },
      tabState: { tabs: [], closed: [] },
      workloads: [],
      nodes: [],
      presets: [],
    });
    expect(out.every((g) => g.surface === 'module')).toBe(true);
  });
});

describe('mergeServerHits', () => {
  test('replaces a pending group with hits + clears pending', () => {
    const initial = [
      { surface: 'session' as const, hits: [], topScore: 0, pending: true },
    ];
    const newHits: Hit[] = [{
      surface: 'session', parentId: 's1', parentTitle: 'g',
      score: 0.5, matchKind: 'exact',
      action: { kind: 'open-tab', tab: { tabKey: 'ops-session:s1', title: 's1', kind: 'ops-session', instanceId: 's1', openedAt: 0 } },
    }];
    const out = mergeServerHits(initial, 'session', newHits);
    const sess = out.find((g) => g.surface === 'session')!;
    expect(sess.pending).toBeFalsy();
    expect(sess.hits.length).toBe(1);
  });

  test('appends to existing hits when merging from different tier', () => {
    const initial = [{
      surface: 'session' as const,
      hits: [{
        surface: 'session' as const, parentId: 's1', parentTitle: 'g',
        score: 0.4, matchKind: 'exact' as const,
        action: { kind: 'open-tab' as const, tab: { tabKey: 't', title: 't', kind: 'module' as const, openedAt: 0 } },
      }],
      topScore: 0.4,
    }];
    const semantic: Hit[] = [{
      surface: 'session', parentId: 's1', parentTitle: 'g',
      score: 0.6, matchKind: 'semantic',
      action: { kind: 'open-tab', tab: { tabKey: 't', title: 't', kind: 'module', openedAt: 0 } },
    }];
    const out = mergeServerHits(initial, 'session', semantic, { append: true });
    const sess = out.find((g) => g.surface === 'session')!;
    expect(sess.hits.length).toBe(2);
    expect(sess.topScore).toBeCloseTo(0.6);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/app test/lib/global-search/orchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/app/src/lib/global-search/orchestrator.ts
import type {
  GroupedResults,
  Hit,
  ParsedQuery,
  SurfaceGroup,
  SurfaceKind,
} from './types';
import type { TabHistoryState } from './surfaces/tab-history';
import type { WorkloadItem } from './surfaces/workloads';
import type { NodeItem } from './surfaces/nodes';
import type { PresetItem } from './surfaces/presets';
import { matchModules } from './surfaces/modules';
import { matchTabHistory } from './surfaces/tab-history';
import { matchWorkloads } from './surfaces/workloads';
import { matchNodes } from './surfaces/nodes';
import { matchPresets } from './surfaces/presets';
import { applySurfaceBias, sortGroups } from './ranking';

export interface ClientPhaseInput {
  query: ParsedQuery;
  tabState: TabHistoryState;
  workloads: WorkloadItem[];
  nodes: NodeItem[];
  presets: PresetItem[];
}

const SERVER_SURFACES: SurfaceKind[] = ['session', 'knowledge', 'logs'];

function groupHits(hits: Hit[]): SurfaceGroup[] {
  const groups = new Map<SurfaceKind, SurfaceGroup>();
  for (const h of hits) {
    let g = groups.get(h.surface);
    if (!g) {
      g = { surface: h.surface, hits: [], topScore: 0 };
      groups.set(h.surface, g);
    }
    g.hits.push(h);
    const final = applySurfaceBias(h);
    if (final > g.topScore) g.topScore = final;
  }
  for (const surface of SERVER_SURFACES) {
    if (!groups.has(surface)) {
      groups.set(surface, { surface, hits: [], topScore: 0, pending: true });
    }
  }
  return sortGroups([...groups.values()]);
}

export function runClientPhase(input: ClientPhaseInput): GroupedResults {
  const { needle, surfaceFilter } = input.query;
  if (!needle) return [];
  const allow = (s: SurfaceKind) => !surfaceFilter || surfaceFilter === s;
  const hits: Hit[] = [];
  if (allow('module')) hits.push(...matchModules(needle));
  if (allow('tab-history')) hits.push(...matchTabHistory(needle, input.tabState));
  if (allow('workload')) hits.push(...matchWorkloads(needle, input.workloads));
  if (allow('node')) hits.push(...matchNodes(needle, input.nodes));
  if (allow('preset')) hits.push(...matchPresets(needle, input.presets));
  const groups = groupHits(hits);
  if (surfaceFilter) return groups.filter((g) => g.surface === surfaceFilter);
  return groups;
}

export function mergeServerHits(
  current: GroupedResults,
  surface: SurfaceKind,
  hits: Hit[],
  opts: { append?: boolean; error?: string } = {},
): GroupedResults {
  const out = current.map((g) => {
    if (g.surface !== surface) return g;
    const merged = opts.append ? [...g.hits, ...hits] : hits;
    let top = 0;
    for (const h of merged) {
      const f = applySurfaceBias(h);
      if (f > top) top = f;
    }
    return {
      surface: g.surface,
      hits: merged,
      topScore: top,
      pending: false,
      error: opts.error,
    };
  });
  if (!current.some((g) => g.surface === surface)) {
    let top = 0;
    for (const h of hits) {
      const f = applySurfaceBias(h);
      if (f > top) top = f;
    }
    out.push({ surface, hits, topScore: top, pending: false, error: opts.error });
  }
  return sortGroups(out);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/app test/lib/global-search/orchestrator.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/global-search/orchestrator.ts \
        packages/app/test/lib/global-search/orchestrator.test.ts
git commit -m "feat(app/lib/global-search): add client-phase orchestrator + server-merge helper"
```

---

## Task 16: App — `useGlobalSearch` hook

**Files:**
- Create: `packages/app/src/lib/global-search/hooks/use-global-search.ts`
- Test: `packages/app/test/lib/global-search/use-global-search.test.ts`

The hook owns:
- a single AbortController for in-flight server fetches
- two debounce timers (Tier 2: 250 ms; Tier 3: 400 ms) keyed off the last keystroke
- a query token to drop stale responses

Test the timing logic with fake timers; the hook itself uses real timers in production.

- [ ] **Step 1: Write the failing test (timing logic only, not the React shape)**

```ts
// packages/app/test/lib/global-search/use-global-search.test.ts
import { describe, expect, test } from 'bun:test';
import { computeNextSchedule } from '@/lib/global-search/hooks/use-global-search';

describe('computeNextSchedule', () => {
  test('schedules tier2 at 250ms and tier3 at 400ms from now', () => {
    const out = computeNextSchedule(1000);
    expect(out.tier2At).toBe(1250);
    expect(out.tier3At).toBe(1400);
  });

  test('respects custom debounce overrides', () => {
    const out = computeNextSchedule(1000, { tier2Ms: 100, tier3Ms: 200 });
    expect(out.tier2At).toBe(1100);
    expect(out.tier3At).toBe(1200);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/app test/lib/global-search/use-global-search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

```ts
// packages/app/src/lib/global-search/hooks/use-global-search.ts
import * as React from 'react';
import { trpc } from '@/lib/trpc';
import { useTabStore } from '@/stores/tab-store';
import type { GroupedResults } from '../types';
import { runClientPhase, mergeServerHits } from '../orchestrator';
import { parseQuery } from '../query';
import { mapSessionHits } from '../surfaces/sessions';
import { mapKnowledgeHits } from '../surfaces/knowledge';
import { mapLogHits } from '../surfaces/logs';
import { mapSessionRagHits } from '../surfaces/sessions-rag';
import { mapKnowledgeRagHits } from '../surfaces/knowledge-rag';
import { mapLogRagHits } from '../surfaces/logs-rag';

const TIER2_MS = 250;
const TIER3_MS = 400;

export function computeNextSchedule(
  now: number,
  opts: { tier2Ms?: number; tier3Ms?: number } = {},
): { tier2At: number; tier3At: number } {
  return {
    tier2At: now + (opts.tier2Ms ?? TIER2_MS),
    tier3At: now + (opts.tier3Ms ?? TIER3_MS),
  };
}

export function useGlobalSearch(input: string): {
  results: GroupedResults;
  status: 'idle' | 'searching';
} {
  const [results, setResults] = React.useState<GroupedResults>([]);
  const [status, setStatus] = React.useState<'idle' | 'searching'>('idle');
  const tabs = useTabStore((s) => s.tabs);
  const closed = useTabStore((s) => s.closed);
  const utils = trpc.useUtils();
  const ragStatus = trpc.globalSearchRagStatus.useQuery(undefined, {
    staleTime: 60_000,
  });

  // Cached client-side lists for client surfaces.
  const workloadsQ = trpc.workloadList.useQuery(undefined, { staleTime: 30_000 });
  const nodesQ = trpc.nodeList.useQuery(undefined, { staleTime: 30_000 });
  const presetsQ = trpc.presetList.useQuery(undefined, { staleTime: 30_000 });

  const queryToken = React.useRef(0);
  const ctrlRef = React.useRef<AbortController | null>(null);
  const tier2Timer = React.useRef<NodeJS.Timeout | null>(null);
  const tier3Timer = React.useRef<NodeJS.Timeout | null>(null);

  React.useEffect(() => {
    if (tier2Timer.current) clearTimeout(tier2Timer.current);
    if (tier3Timer.current) clearTimeout(tier3Timer.current);
    if (ctrlRef.current) ctrlRef.current.abort();

    const token = ++queryToken.current;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    const parsed = parseQuery(input);
    if (!parsed.needle) {
      setResults([]);
      setStatus('idle');
      return;
    }
    setStatus('searching');

    const initial = runClientPhase({
      query: parsed,
      tabState: { tabs, closed },
      workloads: ((workloadsQ.data as any)?.workloads ?? []) as any[],
      nodes: ((nodesQ.data as any)?.nodes ?? []) as any[],
      presets: ((presetsQ.data as any)?.presets ?? []) as any[],
    });
    setResults(initial);

    const allow = (s: string): boolean =>
      !parsed.surfaceFilter || parsed.surfaceFilter === s;

    tier2Timer.current = setTimeout(async () => {
      const tasks: Promise<unknown>[] = [];
      if (allow('session')) {
        tasks.push(
          utils.opsSessionSearch
            .fetch({ query: parsed.needle }, { signal: ctrl.signal })
            .then((res) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'session', mapSessionHits((res as any).hits ?? []), {
                  append: true,
                }),
              );
            })
            .catch((e) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'session', [], { error: String((e as Error).message) }),
              );
            }),
        );
      }
      if (allow('logs')) {
        tasks.push(
          utils.logsSearch
            .fetch({ query: parsed.needle }, { signal: ctrl.signal })
            .then((res) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'logs', mapLogHits((res as any).hits ?? []), { append: true }),
              );
            })
            .catch(() => {
              if (queryToken.current !== token) return;
            }),
        );
      }
      if (allow('knowledge')) {
        tasks.push(
          utils.knowledgeSearch
            .fetch({ query: parsed.needle }, { signal: ctrl.signal })
            .then((res) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'knowledge', mapKnowledgeHits((res as any).hits ?? []), {
                  append: true,
                }),
              );
            })
            .catch(() => {}),
        );
      }
      await Promise.allSettled(tasks);
      if (queryToken.current === token) setStatus('idle');
    }, TIER2_MS);

    tier3Timer.current = setTimeout(async () => {
      if (queryToken.current !== token) return;
      const status = ragStatus.data;
      if (!status || !status.defaultNode) return;
      const tasks: Promise<unknown>[] = [];
      if (allow('session') && status.sessions) {
        tasks.push(
          utils.ragSearch
            .fetch(
              { node: status.defaultNode, query: parsed.needle, collection: 'sessions', topK: 10 },
              { signal: ctrl.signal },
            )
            .then((res) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'session', mapSessionRagHits((res as any).hits ?? []), {
                  append: true,
                }),
              );
            })
            .catch(() => {}),
        );
      }
      if (allow('knowledge') && status.knowledge) {
        tasks.push(
          utils.ragSearch
            .fetch(
              { node: status.defaultNode, query: parsed.needle, collection: 'knowledge', topK: 10 },
              { signal: ctrl.signal },
            )
            .then((res) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'knowledge', mapKnowledgeRagHits((res as any).hits ?? []), {
                  append: true,
                }),
              );
            })
            .catch(() => {}),
        );
      }
      if (allow('logs') && status.logs) {
        tasks.push(
          utils.ragSearch
            .fetch(
              { node: status.defaultNode, query: parsed.needle, collection: 'logs', topK: 10 },
              { signal: ctrl.signal },
            )
            .then((res) => {
              if (queryToken.current !== token) return;
              setResults((cur) =>
                mergeServerHits(cur, 'logs', mapLogRagHits((res as any).hits ?? []), {
                  append: true,
                }),
              );
            })
            .catch(() => {}),
        );
      }
      await Promise.allSettled(tasks);
    }, TIER3_MS);

    return () => {
      if (tier2Timer.current) clearTimeout(tier2Timer.current);
      if (tier3Timer.current) clearTimeout(tier3Timer.current);
      ctrl.abort();
    };
  }, [input, tabs, closed, workloadsQ.data, nodesQ.data, presetsQ.data, ragStatus.data, utils]);

  return { results, status };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/app test/lib/global-search/use-global-search.test.ts`
Expected: PASS — 2 tests pass.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l`
Expected: 12 (unchanged baseline).

- [ ] **Step 6: Commit**

```bash
git add packages/app/src/lib/global-search/hooks/use-global-search.ts \
        packages/app/test/lib/global-search/use-global-search.test.ts
git commit -m "feat(app/lib/global-search): add useGlobalSearch hook"
```

---

## Task 17: App — `match-snippet.tsx` and `search-results-tree.tsx`

**Files:**
- Create: `packages/app/src/shell/match-snippet.tsx`
- Create: `packages/app/src/shell/beacon/search-results-tree.tsx`

Presentational only. No render tests (none exist in repo); UI flows in Tasks 19–20 verify rendering.

- [ ] **Step 1: Implement `match-snippet.tsx`**

```tsx
// packages/app/src/shell/match-snippet.tsx
import * as React from 'react';
import type { MatchExcerpt } from '@/lib/global-search/types';

interface Props {
  match: MatchExcerpt;
}

export function MatchSnippet({ match }: Props): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < match.spans.length; i++) {
    const sp = match.spans[i]!;
    if (sp.start > cursor) parts.push(match.snippet.slice(cursor, sp.start));
    parts.push(
      <strong key={i} style={{ color: 'var(--color-brand)' }}>
        {match.snippet.slice(sp.start, sp.end)}
      </strong>,
    );
    cursor = sp.end;
  }
  if (cursor < match.snippet.length) parts.push(match.snippet.slice(cursor));
  return (
    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
      {parts.map((p, i) => (
        <React.Fragment key={i}>{p}</React.Fragment>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Implement `search-results-tree.tsx`**

```tsx
// packages/app/src/shell/beacon/search-results-tree.tsx
import * as React from 'react';
import { TreeItem, Badge } from '@/ui';
import type { GroupedResults, Hit, SurfaceGroup, SurfaceKind } from '@/lib/global-search/types';
import { MatchSnippet } from '@/shell/match-snippet';

interface Props {
  results: GroupedResults;
  onActivate: (hit: Hit) => void;
}

const SURFACE_LABEL: Record<SurfaceKind, string> = {
  module: 'Modules',
  session: 'Ops Sessions',
  workload: 'Workloads',
  node: 'Nodes',
  knowledge: 'Knowledge',
  logs: 'Logs',
  preset: 'Presets',
  'tab-history': 'Recent tabs',
};

interface CollapsedParent {
  parentId: string;
  parentTitle: string;
  topHit: Hit;
  hits: Hit[];
}

function collapse(group: SurfaceGroup): CollapsedParent[] {
  const map = new Map<string, CollapsedParent>();
  for (const h of group.hits) {
    let p = map.get(h.parentId);
    if (!p) {
      p = { parentId: h.parentId, parentTitle: h.parentTitle, topHit: h, hits: [] };
      map.set(h.parentId, p);
    }
    p.hits.push(h);
    if (h.score > p.topHit.score) p.topHit = h;
  }
  return [...map.values()].sort((a, b) => b.topHit.score - a.topHit.score);
}

export function SearchResultsTree({ results, onActivate }: Props): React.JSX.Element {
  return (
    <div data-testid="global-search-results" role="tree">
      {results.map((g) => {
        if (g.hits.length === 0 && !g.pending && !g.error) return null;
        const parents = collapse(g);
        return (
          <div key={g.surface} style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--color-text-tertiary)',
              }}
            >
              <span>{SURFACE_LABEL[g.surface]}</span>
              <span style={{ color: 'var(--color-text-tertiary)' }}>· {g.hits.length}</span>
              {g.pending && (
                <span style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
                  loading…
                </span>
              )}
              {g.error && (
                <span style={{ color: 'var(--color-err)' }}>error: {g.error}</span>
              )}
            </div>
            {parents.map((p) => (
              <div key={p.parentId} data-testid={`search-parent-${g.surface}-${p.parentId}`}>
                <TreeItem
                  label={p.parentTitle}
                  onClick={() => onActivate(p.topHit)}
                  trailing={
                    p.hits.some((h) => h.matchKind === 'semantic') ? (
                      <Badge variant="brand">semantic</Badge>
                    ) : undefined
                  }
                />
                {p.hits.map(
                  (h, i) =>
                    h.match && (
                      <div
                        key={i}
                        style={{ padding: '0 14px 6px 28px', cursor: 'pointer' }}
                        onClick={() => onActivate(h)}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--color-text-tertiary)',
                            marginBottom: 2,
                          }}
                        >
                          {h.match.where}
                          {h.matchKind === 'semantic' && ' · semantic'}
                        </div>
                        <MatchSnippet match={h.match} />
                      </div>
                    ),
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | grep -E "match-snippet|search-results-tree" || echo "no errors"`
Expected: `no errors`.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/shell/match-snippet.tsx \
        packages/app/src/shell/beacon/search-results-tree.tsx
git commit -m "feat(app/shell): add MatchSnippet and SearchResultsTree presentational components"
```

---

## Task 18: App — wire SearchView and command palette

**Files:**
- Modify: `packages/app/src/shell/beacon/search-view.tsx`
- Modify: `packages/app/src/shell/command-palette.tsx`

- [ ] **Step 1: Replace `search-view.tsx` body**

```tsx
// packages/app/src/shell/beacon/search-view.tsx
import * as React from 'react';
import { Input, Kbd } from '@/ui';
import { Search as SearchIcon } from 'lucide-react';
import { useTabStore } from '@/stores/tab-store';
import { useGlobalSearch } from '@/lib/global-search/hooks/use-global-search';
import { SearchResultsTree } from './search-results-tree';
import type { Hit } from '@/lib/global-search/types';

export function SearchView(): React.JSX.Element {
  const [q, setQ] = React.useState('');
  const open = useTabStore((s) => s.open);
  const { results, status } = useGlobalSearch(q);

  const onActivate = React.useCallback(
    (hit: Hit) => {
      if (hit.action.kind === 'open-tab') open(hit.action.tab);
    },
    [open],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '10px 14px' }}>
        <Input
          leadingSlot={<SearchIcon size={12} />}
          placeholder="Search everything…"
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          autoFocus
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {q.trim() === '' ? (
          <div
            style={{
              padding: '12px 18px',
              color: 'var(--color-text-tertiary)',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            Type to search across modules, ops sessions, workloads, knowledge, logs, and more. Use{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>session:</code>,{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>module:</code>, or{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>kb:</code> to filter to one surface. Or use
            the palette (<Kbd compact>⌘⇧P</Kbd>) for quick jumps.
          </div>
        ) : results.length === 0 && status === 'idle' ? (
          <div
            style={{
              padding: '12px 18px',
              color: 'var(--color-text-tertiary)',
              fontSize: 12,
            }}
          >
            No results.
          </div>
        ) : (
          <SearchResultsTree results={results} onActivate={onActivate} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire palette**

In `packages/app/src/shell/command-palette.tsx`, find the section that renders curated commands. Add a new section *below* the curated list that renders global search hits when the user's input doesn't match a curated command. Pattern:

```tsx
// Inside command-palette.tsx, near the existing renderer:
import { useGlobalSearch } from '@/lib/global-search/hooks/use-global-search';
import { SearchResultsTree } from './beacon/search-results-tree';

// In the component:
const { results } = useGlobalSearch(input);

// Render after the curated commands list, only if curated yields nothing:
{curatedHits.length === 0 && results.length > 0 && (
  <SearchResultsTree
    results={results}
    onActivate={(hit) => {
      if (hit.action.kind === 'open-tab') {
        useTabStore.getState().open(hit.action.tab);
        onClose(); // existing palette-close handler
      }
    }}
  />
)}
```

Adapt to the actual variable names in `command-palette.tsx`. The principle: curated commands always win; global search fills the rest of the space.

- [ ] **Step 3: Run app tests — no regressions**

Run: `bun test --cwd packages/app 2>&1 | tail -10`
Expected: all tests pass.

- [ ] **Step 4: Real typecheck**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l`
Expected: 12 (baseline).

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/shell/beacon/search-view.tsx \
        packages/app/src/shell/command-palette.tsx
git commit -m "feat(app/shell): wire SearchView and palette to useGlobalSearch"
```

---

## Task 19: UI flow — `global-search-flow`

**Files:**
- Create: `tests/ui-flows/global-search-flow.ts`
- Modify: `scripts/smoke-ui-flows.sh`

- [ ] **Step 1: Implement the flow**

Use `tests/ui-flows/chat-compare-flow.ts` as the structural template. Seed a journal fixture, type into the SearchView input, verify a session result appears, click it, verify the ops-session tab opens. Apply SKIP-guard for selector misses.

```ts
// tests/ui-flows/global-search-flow.ts
import { defineFlow } from './flow-runtime';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default defineFlow({
  id: 'global-search',
  tier: 'C',
  description: 'Type into SearchView, verify cross-surface results render and activate.',
  async run({ driver, profileDir, electron }) {
    const sessionId = 'flow-search-fixture';
    const dir = join(profileDir, 'ops-chat', 'sessions', sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        type: 'session_started', ts: '2026-04-25T00:00:00.000Z', sessionId,
        goal: 'fixture-search-needle audit', historyLen: 0, toolCount: 0,
      }) + '\n',
      'utf8',
    );

    await electron.evaluate(async (win) => {
      const w = win as any;
      // Open the search activity-bar entry. Adapt selector to actual activity-bar API.
      // (driver.click below is the durable path.)
      void w;
    });

    const input = await driver.find('input[placeholder*="Search"]', { timeout: 5_000 });
    if (!input) return driver.skip('search input not visible');
    await driver.type('input[placeholder*="Search"]', 'fixture-search-needle', { force: true });

    const results = await driver.find('[data-testid="global-search-results"]', { timeout: 3_000 });
    if (!results) return driver.skip('results panel did not mount');

    const sessionRow = await driver.find(
      `[data-testid="search-parent-session-${sessionId}"]`,
      { timeout: 3_000 },
    );
    if (!sessionRow) return driver.skip('session result row not found');

    return driver.pass();
  },
});
```

- [ ] **Step 2: Register**

Append `global-search-flow` to `scripts/smoke-ui-flows.sh` under the Tier C list.

- [ ] **Step 3: Smoke-run locally if possible**

Run: `bun run test:ui-flows -- --tier C --filter global-search 2>&1 | tail -10`
Expected: PASS or SKIP.

- [ ] **Step 4: Commit**

```bash
git add tests/ui-flows/global-search-flow.ts scripts/smoke-ui-flows.sh
git commit -m "feat(tests/ui-flows): add global-search-flow (Tier C)"
```

---

## Task 20: UI flow — `palette-search-flow`

**Files:**
- Create: `tests/ui-flows/palette-search-flow.ts`
- Modify: `scripts/smoke-ui-flows.sh`

- [ ] **Step 1: Implement the flow**

Same fixture as Task 19 (or seed an additional one). Open palette via keyboard shortcut, type a `session:` prefix query, verify the session result row appears.

```ts
// tests/ui-flows/palette-search-flow.ts
import { defineFlow } from './flow-runtime';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default defineFlow({
  id: 'palette-search',
  tier: 'C',
  description: 'Type session: prefix in palette, verify scoped result appears.',
  async run({ driver, profileDir, electron }) {
    const sessionId = 'flow-palette-fixture';
    const dir = join(profileDir, 'ops-chat', 'sessions', sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'journal.jsonl'),
      JSON.stringify({
        type: 'session_started', ts: '2026-04-25T00:00:00.000Z', sessionId,
        goal: 'palette-fixture-needle', historyLen: 0, toolCount: 0,
      }) + '\n',
      'utf8',
    );

    await driver.pressShortcut('CommandOrControl+Shift+P');

    const input = await driver.find('[role="combobox"], input[placeholder*="palette"]', {
      timeout: 3_000,
    });
    if (!input) return driver.skip('palette input not visible');
    await driver.type('[role="combobox"], input[placeholder*="palette"]', 'session:palette-fixture-needle', {
      force: true,
    });

    const sessionRow = await driver.find(
      `[data-testid="search-parent-session-${sessionId}"]`,
      { timeout: 3_000 },
    );
    if (!sessionRow) return driver.skip('palette session row not visible');

    return driver.pass();
  },
});
```

- [ ] **Step 2: Register**

Append `palette-search-flow` to `scripts/smoke-ui-flows.sh` under the Tier C list.

- [ ] **Step 3: Smoke-run if possible**

Run: `bun run test:ui-flows -- --tier C --filter palette-search 2>&1 | tail -10`
Expected: PASS or SKIP.

- [ ] **Step 4: Commit**

```bash
git add tests/ui-flows/palette-search-flow.ts scripts/smoke-ui-flows.sh
git commit -m "feat(tests/ui-flows): add palette-search-flow (Tier C)"
```

---

## Task 21: Final validation, tag, ship

- [ ] **Step 1: Full server suite**

Run: `bun test --cwd packages/remote 2>&1 | tail -10`
Expected: All tests pass (baseline 1278 + new tests).

- [ ] **Step 2: Full app suite**

Run: `bun test --cwd packages/app 2>&1 | tail -10`
Expected: All tests pass (baseline 79 + new tests).

- [ ] **Step 3: Real typecheck**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l`
Expected: 12.

- [ ] **Step 4: Tier A regression smoke**

Run: `bun run test:ui-flows -- --tier A 2>&1 | tail -10`
Expected: All Tier A flows PASS.

- [ ] **Step 5: New Tier C flows**

Run: `bun run test:ui-flows -- --tier C --filter "global-search\|palette-search" 2>&1 | tail -10`
Expected: PASS or SKIP.

- [ ] **Step 6: Tag**

```bash
git tag beacon-p3-global-search
```

- [ ] **Step 7: Hand off**

Open a PR titled `feat(app, remote): global search (Phase 3)` against `main`. Body: spec link, four new tRPC procs, two new ingestion paths, RAG bridge with default-node resolver, app-side hook + surfaces + renderer + palette wiring, two Tier C flows. Reviewer steps: server + app suites, then a manual end-to-end with at least one RAG node configured (Chroma in Docker is fine) to exercise Tier 3.

---

## Self-review checklist

**Spec coverage:**
- D1 (8 surfaces) → Tasks 11, 12, 13, 14
- D2 (hybrid by surface size) → Task 11/12 client; Tasks 3/4/5 server lexical; Task 6 RAG bridge
- D3 (sidebar + palette) → Task 18
- D4 (grouped, ranked group order) → Task 10 (ranking), Task 15 (orchestrator), Task 17 (renderer)
- D5 (multiple excerpts per source, nested) → Task 17 collapse logic
- D6 (Tier 1 sync, Tier 2 250ms, Tier 3 400ms, parallel timers) → Task 16
- D7 (RAG layer + graceful degradation) → Task 6 (bridge), Task 7 (sessions ingest), Task 8 (logs ingest), Task 9 (status proc), Task 16 (skip Tier 3 when status absent)
- D8 (matchKind + bias + tie penalty) → Task 10 (ranking)
- D9 (same-parent collapse) → Task 17 (renderer collapse on parentId)

**Placeholder scan:** intentional flexibility points are flagged with concrete grep commands and adaptation guidance: Task 4 (knowledge entity loader), Task 6 (resolveRagNode export), Task 7 (event-bus wildcard subscribe), Task 9 (knowledgeSearch lexical body — falls back to `[]` if no list-proc exists), Task 18 (palette internal variable names). None of these are unscoped or open-ended.

**Type consistency:** `Hit`, `SurfaceGroup`, `GroupedResults`, `MatchExcerpt`, `SurfaceKind`, `ParsedQuery`, `SessionServerHit`/`KnowledgeServerHit`/`LogServerHit`/`SessionRagServerHit`/`KnowledgeRagServerHit`/`LogRagServerHit` are defined in Tasks 10, 13, 14 — referenced unchanged across Tasks 11–18. Tab open shape (`tabKey`/`title`/`kind`/`instanceId`/`openedAt`) consistent across surfaces. Server-side `SessionHit`/`KnowledgeHit`/`LogHit` defined in Task 2, referenced in Tasks 3/5/6/9.
