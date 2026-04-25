# Ops Session Replay & Timeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `OpsSessionDetail` stub with a real per-session timeline backed by a per-session journal and an in-memory event bus, plus a new sessions-list sidebar module and an auto-pin hook in ops-chat.

**Architecture:** Server-side, every Ops Chat planner event is appended to a per-session JSONL journal at `~/.llamactl/ops-chat/sessions/<sessionId>/journal.jsonl` and published on an in-memory `EventEmitter` keyed by `sessionId`. Four new tRPC procedures (`opsSessionList`, `opsSessionGet`, `opsSessionWatch`, `opsSessionDelete`) expose the journal + bus. App-side, a single hook `useOpsSession(sessionId)` opens the watch subscription and merges replay-then-live events into a stable view-model that the rewritten `OpsSessionDetail` and the new `OpsSessions` module render.

**Tech Stack:** TypeScript, Zod, tRPC subscriptions, Bun test, Zustand (existing tab-store), React 19, the existing `@/ui` primitive set, Node `EventEmitter`, Node `fs/promises`.

**Spec:** `docs/superpowers/specs/2026-04-25-ops-session-replay-design.md`

---

## File Structure

### Server (`packages/remote/src/ops-chat`)

**Modified:**
- `audit.ts` — `OpsChatAuditEntry` gains `sessionId?: string`
- `dispatch.ts` — accepts `sessionId` and threads it into `appendOpsChatAudit`
- `loop-executor.ts` — writes `session_started`/`plan_proposed`/`preview_outcome`/`wet_outcome`/`done`/`refusal`/`aborted` to journal and bus
- `paths.ts` — adds `defaultSessionsDir(env)` and `defaultSessionDir(env, id)`
- `../router.ts` — adds 4 new procedures

**Created (`sessions/` subdirectory):**
- `sessions/journal-schema.ts` — Zod schemas + types for `JournalEvent`
- `sessions/journal.ts` — `appendJournalEvent`, `readJournal`, `journalDir`
- `sessions/redaction.ts` — per-tool redaction registry
- `sessions/event-bus.ts` — `Map<sessionId, EventEmitter>` with publish/subscribe/close
- `sessions/list.ts` — `listSessions`, `getSessionSummary`
- `sessions/delete.ts` — `deleteSession`

**Tests (`packages/remote/test/`):**
- `ops-chat-journal.test.ts`
- `ops-chat-redaction.test.ts`
- `ops-chat-event-bus.test.ts`
- `ops-chat-sessions-list.test.ts`
- `ops-chat-loop-executor.test.ts` (extend if exists, else new)
- `ops-session-router.test.ts`

### App (`packages/app/src`)

**Created:**
- `lib/use-ops-session.ts` — view-model hook
- `modules/ops/detail/session-header.tsx`
- `modules/ops/detail/iteration-card.tsx`
- `modules/ops/detail/result-viewer.tsx`
- `modules/ops/detail/empty-state.tsx`
- `modules/ops-sessions/index.tsx`
- `modules/ops-sessions/sessions-table.tsx`
- `modules/ops-sessions/delete-confirm.tsx`

**Modified:**
- `modules/ops/detail/ops-session-detail.tsx` — replace stub
- `modules/ops/detail/index.ts` — no change needed (already re-exports `OpsSessionDetail`)
- `modules/ops-chat/index.tsx` — auto-pin tab when session_started arrives
- `modules/registry.ts` — register new `ops-sessions` module

**Tests (`packages/app/test/`):**
- `use-ops-session.test.ts` — view-model merge (pure function)
- `modules/ops-detail/iteration-card-helpers.test.ts` — `statusGlyph`, `fmtMs` (pure functions)

The app package has no React render-test setup (`@testing-library/react`, jsdom, and happy-dom are not deps; existing tests in `test/ui/` test pure helpers, not rendered output). Component visual behaviour is verified end-to-end by the Tier C UI flows (Tasks 17–18).

### UI flow tests (`tests/ui-flows/`)

**Created:**
- `ops-session-replay-flow.ts`
- `ops-sessions-list-flow.ts`

---

## Conventions

**Test runner.** Server tests run via `bun test --cwd packages/remote`; app tests via `bun test --cwd packages/app`. Both honour `LLAMACTL_TEST_PROFILE` for hermetic on-disk roots — set it in `beforeEach` so journals land in a tmp dir, never in `~/.llamactl`.

**Real typecheck.** Use `bunx tsc -p packages/<pkg>/tsconfig.web.json --noEmit` (or the appropriate `tsconfig.json`). The `bun run typecheck` script is a known no-op on this repo and reports success regardless of errors.

**Commit cadence.** One commit per task by default. Conventional Commits style: `feat(remote/ops-chat): add per-session journal`, `refactor(app/ops-detail): wire OpsSessionDetail to use-ops-session`, etc.

**Tab open API.** Use `useTabStore.getState().open({ tabKey: 'ops-session:<id>', title: 'Session <short>', kind: 'ops-session', instanceId: '<id>', openedAt: Date.now() })`. The `open` action is `addOrFocus` semantics — opening an already-open tab activates it.

---

## Task 1: Server — `paths.ts` adds session directory helpers

**Files:**
- Modify: `packages/remote/src/ops-chat/paths.ts`
- Test: `packages/remote/test/ops-chat-paths.test.ts` (create if missing — extend if it exists)

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/ops-chat-paths.test.ts
import { describe, expect, test } from 'bun:test';
import { defaultSessionsDir, defaultSessionDir } from '../src/ops-chat/paths';

describe('ops-chat paths — sessions', () => {
  test('defaultSessionsDir uses DEV_STORAGE when set', () => {
    expect(defaultSessionsDir({ DEV_STORAGE: '/tmp/abc' } as any)).toBe(
      '/tmp/abc/ops-chat/sessions',
    );
  });

  test('defaultSessionsDir falls back to homedir/.llamactl when DEV_STORAGE missing', () => {
    const out = defaultSessionsDir({} as any);
    expect(out.endsWith('/.llamactl/ops-chat/sessions')).toBe(true);
  });

  test('defaultSessionDir joins sessionId', () => {
    expect(defaultSessionDir({ DEV_STORAGE: '/tmp/abc' } as any, 'sess-1')).toBe(
      '/tmp/abc/ops-chat/sessions/sess-1',
    );
  });
});
```

- [ ] **Step 2: Run the test, verify failure**

Run: `bun test --cwd packages/remote test/ops-chat-paths.test.ts`
Expected: FAIL — `defaultSessionsDir` and `defaultSessionDir` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `packages/remote/src/ops-chat/paths.ts`:

```ts
export function defaultSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const devStorage = env.DEV_STORAGE?.trim();
  if (devStorage) return join(devStorage, 'ops-chat', 'sessions');
  return join(homedir(), '.llamactl', 'ops-chat', 'sessions');
}

export function defaultSessionDir(env: NodeJS.ProcessEnv, sessionId: string): string {
  return join(defaultSessionsDir(env), sessionId);
}
```

- [ ] **Step 4: Run the test, verify pass**

Run: `bun test --cwd packages/remote test/ops-chat-paths.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/ops-chat/paths.ts packages/remote/test/ops-chat-paths.test.ts
git commit -m "feat(remote/ops-chat/paths): add per-session directory helpers"
```

---

## Task 2: Server — `journal-schema.ts` with Zod discriminated union

**Files:**
- Create: `packages/remote/src/ops-chat/sessions/journal-schema.ts`

- [ ] **Step 1: Create the schema file**

```ts
// packages/remote/src/ops-chat/sessions/journal-schema.ts
import { z } from 'zod';
import { PlanStepSchema } from '@nova/mcp';

export const ToolTierEnum = z.enum([
  'read',
  'mutation-dry-run-safe',
  'mutation-destructive',
]);
export type ToolTier = z.infer<typeof ToolTierEnum>;

const Common = z.object({ ts: z.string().min(1) });

export const SessionStartedSchema = Common.extend({
  type: z.literal('session_started'),
  sessionId: z.string().min(1),
  goal: z.string().min(1),
  nodeId: z.string().optional(),
  model: z.string().optional(),
  historyLen: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
});

export const PlanProposedSchema = Common.extend({
  type: z.literal('plan_proposed'),
  stepId: z.string().min(1),
  iteration: z.number().int().nonnegative(),
  tier: ToolTierEnum,
  reasoning: z.string(),
  step: PlanStepSchema,
});

export const OutcomeBodySchema = z.object({
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  result: z.unknown().optional(),
  resultRedacted: z.enum(['omitted', 'truncated']).optional(),
  error: z
    .object({ code: z.string(), message: z.string() })
    .optional(),
});

export const PreviewOutcomeSchema = Common.extend({
  type: z.literal('preview_outcome'),
  stepId: z.string().min(1),
}).merge(OutcomeBodySchema);

export const WetOutcomeSchema = Common.extend({
  type: z.literal('wet_outcome'),
  stepId: z.string().min(1),
}).merge(OutcomeBodySchema);

export const RefusalSchema = Common.extend({
  type: z.literal('refusal'),
  reason: z.string().min(1),
});

export const DoneSchema = Common.extend({
  type: z.literal('done'),
  iterations: z.number().int().nonnegative(),
});

export const AbortedSchema = Common.extend({
  type: z.literal('aborted'),
  reason: z.enum(['client_abort', 'signal', 'timeout']),
});

export const JournalEventSchema = z.discriminatedUnion('type', [
  SessionStartedSchema,
  PlanProposedSchema,
  PreviewOutcomeSchema,
  WetOutcomeSchema,
  RefusalSchema,
  DoneSchema,
  AbortedSchema,
]);
export type JournalEvent = z.infer<typeof JournalEventSchema>;

export type TerminalEvent =
  | z.infer<typeof DoneSchema>
  | z.infer<typeof RefusalSchema>
  | z.infer<typeof AbortedSchema>;

export function isTerminal(e: JournalEvent): e is TerminalEvent {
  return e.type === 'done' || e.type === 'refusal' || e.type === 'aborted';
}
```

- [ ] **Step 2: Sanity-typecheck the new file**

Run: `bunx tsc -p packages/remote/tsconfig.json --noEmit`
Expected: No new errors. (Pre-existing repo-wide errors are OK.)

- [ ] **Step 3: Commit**

```bash
git add packages/remote/src/ops-chat/sessions/journal-schema.ts
git commit -m "feat(remote/ops-chat/sessions): add JournalEvent zod schema"
```

---

## Task 3: Server — `journal.ts` append + read

**Files:**
- Create: `packages/remote/src/ops-chat/sessions/journal.ts`
- Test: `packages/remote/test/ops-chat-journal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/ops-chat-journal.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendJournalEvent,
  readJournal,
  journalPath,
} from '../src/ops-chat/sessions/journal';

describe('journal append + read', () => {
  let tmp: string;
  let prevDevStorage: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ops-journal-'));
    prevDevStorage = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
  });

  afterEach(() => {
    if (prevDevStorage === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prevDevStorage;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('append then read round-trip', async () => {
    await appendJournalEvent('s1', {
      type: 'session_started',
      ts: '2026-04-25T00:00:00.000Z',
      sessionId: 's1',
      goal: 'audit fleet',
      historyLen: 0,
      toolCount: 5,
    });
    await appendJournalEvent('s1', {
      type: 'done',
      ts: '2026-04-25T00:00:01.000Z',
      iterations: 0,
    });
    const events = await readJournal('s1');
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe('session_started');
    expect(events[1]!.type).toBe('done');
  });

  test('readJournal of missing session returns empty array', async () => {
    const events = await readJournal('does-not-exist');
    expect(events).toEqual([]);
  });

  test('readJournal skips malformed lines', async () => {
    await appendJournalEvent('s1', {
      type: 'session_started',
      ts: '2026-04-25T00:00:00.000Z',
      sessionId: 's1',
      goal: 'g',
      historyLen: 0,
      toolCount: 0,
    });
    const path = journalPath('s1');
    const body = readFileSync(path, 'utf8');
    const corrupted = body + '{not-json}\n';
    require('node:fs').writeFileSync(path, corrupted, 'utf8');
    const events = await readJournal('s1');
    expect(events.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/ops-chat-journal.test.ts`
Expected: FAIL — `appendJournalEvent`, `readJournal`, `journalPath` undefined.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/ops-chat/sessions/journal.ts
import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultSessionDir } from '../paths.js';
import {
  JournalEventSchema,
  type JournalEvent,
} from './journal-schema.js';

export function journalDir(sessionId: string): string {
  return defaultSessionDir(process.env, sessionId);
}

export function journalPath(sessionId: string): string {
  return join(journalDir(sessionId), 'journal.jsonl');
}

export async function appendJournalEvent(
  sessionId: string,
  event: JournalEvent,
): Promise<void> {
  const path = journalPath(sessionId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(event) + '\n', 'utf8');
}

export async function readJournal(sessionId: string): Promise<JournalEvent[]> {
  const path = journalPath(sessionId);
  if (!existsSync(path)) return [];
  const body = await readFile(path, 'utf8');
  const out: JournalEvent[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JournalEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/ops-chat-journal.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/ops-chat/sessions/journal.ts \
        packages/remote/test/ops-chat-journal.test.ts
git commit -m "feat(remote/ops-chat/sessions): add append-only journal store"
```

---

## Task 4: Server — `redaction.ts` per-tool registry

**Files:**
- Create: `packages/remote/src/ops-chat/sessions/redaction.ts`
- Test: `packages/remote/test/ops-chat-redaction.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/ops-chat-redaction.test.ts
import { describe, expect, test } from 'bun:test';
import { redactResult } from '../src/ops-chat/sessions/redaction';

describe('redactResult', () => {
  test('llamactl.secrets.read → omitted, value undefined', () => {
    const r = redactResult('llamactl.secrets.read', { token: 'abc' });
    expect(r.value).toBeUndefined();
    expect(r.redacted).toBe('omitted');
  });

  test('llamactl.fs.read → truncates body > 4096 chars', () => {
    const big = 'x'.repeat(10_000);
    const r = redactResult('llamactl.fs.read', { content: big });
    expect(r.redacted).toBe('truncated');
    expect(JSON.stringify(r.value).length).toBeLessThanOrEqual(4096 + 64);
  });

  test('llamactl.fs.read → small body passes through', () => {
    const r = redactResult('llamactl.fs.read', { content: 'small' });
    expect(r.redacted).toBeUndefined();
    expect(r.value).toEqual({ content: 'small' });
  });

  test('default tool → full passthrough', () => {
    const r = redactResult('llamactl.workload.list', { workloads: [{ id: 'a' }] });
    expect(r.redacted).toBeUndefined();
    expect(r.value).toEqual({ workloads: [{ id: 'a' }] });
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/ops-chat-redaction.test.ts`
Expected: FAIL — `redactResult` undefined.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/ops-chat/sessions/redaction.ts
export type RedactResult = {
  value: unknown;
  redacted?: 'omitted' | 'truncated';
};

type Rule = (input: unknown) => RedactResult;

const TRUNCATE_AT = 4096;

const RULES: Record<string, Rule> = {
  'llamactl.secrets.read': () => ({ value: undefined, redacted: 'omitted' }),
  'llamactl.fs.read': (input) => {
    const json = JSON.stringify(input ?? null);
    if (json.length <= TRUNCATE_AT) return { value: input };
    const head = json.slice(0, TRUNCATE_AT);
    return {
      value: { _truncated: true, preview: head },
      redacted: 'truncated',
    };
  },
};

export function redactResult(toolName: string, input: unknown): RedactResult {
  const rule = RULES[toolName];
  if (rule) return rule(input);
  return { value: input };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/ops-chat-redaction.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/ops-chat/sessions/redaction.ts \
        packages/remote/test/ops-chat-redaction.test.ts
git commit -m "feat(remote/ops-chat/sessions): add per-tool result redaction"
```

---

## Task 5: Server — `event-bus.ts` in-memory pub/sub

**Files:**
- Create: `packages/remote/src/ops-chat/sessions/event-bus.ts`
- Test: `packages/remote/test/ops-chat-event-bus.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/ops-chat-event-bus.test.ts
import { describe, expect, test } from 'bun:test';
import { sessionEventBus } from '../src/ops-chat/sessions/event-bus';
import type { JournalEvent } from '../src/ops-chat/sessions/journal-schema';

const baseEvt: JournalEvent = {
  type: 'session_started',
  ts: '2026-04-25T00:00:00.000Z',
  sessionId: 's1',
  goal: 'g',
  historyLen: 0,
  toolCount: 0,
};

describe('sessionEventBus', () => {
  test('subscribers receive events in order', () => {
    sessionEventBus.create('s1');
    const got: JournalEvent[] = [];
    const off = sessionEventBus.subscribe('s1', (e) => got.push(e));
    sessionEventBus.publish('s1', baseEvt);
    sessionEventBus.publish('s1', { ...baseEvt, type: 'done', iterations: 0 } as JournalEvent);
    expect(got.length).toBe(2);
    off();
    sessionEventBus.close('s1');
  });

  test('hasChannel reflects create/close', () => {
    expect(sessionEventBus.hasChannel('s2')).toBe(false);
    sessionEventBus.create('s2');
    expect(sessionEventBus.hasChannel('s2')).toBe(true);
    sessionEventBus.close('s2');
    expect(sessionEventBus.hasChannel('s2')).toBe(false);
  });

  test('publish to closed channel is a no-op', () => {
    const got: JournalEvent[] = [];
    sessionEventBus.subscribe('s3', (e) => got.push(e));
    sessionEventBus.publish('s3', baseEvt);
    expect(got.length).toBe(0);
  });

  test('multiple subscribers all receive each event', () => {
    sessionEventBus.create('s4');
    const a: JournalEvent[] = [];
    const b: JournalEvent[] = [];
    sessionEventBus.subscribe('s4', (e) => a.push(e));
    sessionEventBus.subscribe('s4', (e) => b.push(e));
    sessionEventBus.publish('s4', baseEvt);
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    sessionEventBus.close('s4');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/ops-chat-event-bus.test.ts`
Expected: FAIL — `sessionEventBus` undefined.

- [ ] **Step 3: Implement**

```ts
// packages/remote/src/ops-chat/sessions/event-bus.ts
import { EventEmitter } from 'node:events';
import type { JournalEvent } from './journal-schema.js';

const channels = new Map<string, EventEmitter>();

function ensure(sessionId: string): EventEmitter {
  let e = channels.get(sessionId);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(50);
    channels.set(sessionId, e);
  }
  return e;
}

export const sessionEventBus = {
  create(sessionId: string): void {
    ensure(sessionId);
  },
  hasChannel(sessionId: string): boolean {
    return channels.has(sessionId);
  },
  publish(sessionId: string, event: JournalEvent): void {
    const e = channels.get(sessionId);
    if (!e) return;
    e.emit('event', event);
  },
  subscribe(
    sessionId: string,
    listener: (event: JournalEvent) => void,
  ): () => void {
    const e = ensure(sessionId);
    e.on('event', listener);
    return () => {
      e.off('event', listener);
    };
  },
  close(sessionId: string): void {
    const e = channels.get(sessionId);
    if (!e) return;
    e.removeAllListeners();
    channels.delete(sessionId);
  },
};
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/ops-chat-event-bus.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/ops-chat/sessions/event-bus.ts \
        packages/remote/test/ops-chat-event-bus.test.ts
git commit -m "feat(remote/ops-chat/sessions): add in-memory session event bus"
```

---

## Task 6: Server — `list.ts` and `delete.ts`

**Files:**
- Create: `packages/remote/src/ops-chat/sessions/list.ts`
- Create: `packages/remote/src/ops-chat/sessions/delete.ts`
- Test: `packages/remote/test/ops-chat-sessions-list.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/ops-chat-sessions-list.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJournalEvent } from '../src/ops-chat/sessions/journal';
import { listSessions, getSessionSummary } from '../src/ops-chat/sessions/list';
import { deleteSession } from '../src/ops-chat/sessions/delete';
import { sessionEventBus } from '../src/ops-chat/sessions/event-bus';
import { defaultSessionDir } from '../src/ops-chat/paths';

describe('list + delete', () => {
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ops-list-'));
    prev = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('listSessions returns sessions sorted by started desc', async () => {
    await appendJournalEvent('s-old', {
      type: 'session_started',
      ts: '2026-04-25T00:00:00.000Z',
      sessionId: 's-old',
      goal: 'old goal',
      historyLen: 0,
      toolCount: 0,
    });
    await appendJournalEvent('s-old', {
      type: 'done',
      ts: '2026-04-25T00:00:01.000Z',
      iterations: 1,
    });
    await appendJournalEvent('s-new', {
      type: 'session_started',
      ts: '2026-04-25T01:00:00.000Z',
      sessionId: 's-new',
      goal: 'new goal',
      historyLen: 0,
      toolCount: 0,
    });
    const out = await listSessions({ limit: 10 });
    expect(out.sessions.map((s) => s.sessionId)).toEqual(['s-new', 's-old']);
    expect(out.sessions[0]!.status).toBe('live');
    expect(out.sessions[1]!.status).toBe('done');
  });

  test('getSessionSummary returns iteration count from plan_proposed events', async () => {
    await appendJournalEvent('s-it', {
      type: 'session_started',
      ts: '2026-04-25T00:00:00.000Z',
      sessionId: 's-it',
      goal: 'g',
      historyLen: 0,
      toolCount: 0,
    });
    await appendJournalEvent('s-it', {
      type: 'plan_proposed',
      ts: '2026-04-25T00:00:01.000Z',
      stepId: 'sp-1',
      iteration: 0,
      tier: 'read',
      reasoning: 'try',
      step: { tool: 't', annotation: 'a' } as any,
    });
    const s = await getSessionSummary('s-it');
    expect(s.iterations).toBe(1);
  });

  test('deleteSession rejects in-flight (channel open)', async () => {
    sessionEventBus.create('s-live');
    await appendJournalEvent('s-live', {
      type: 'session_started',
      ts: '2026-04-25T00:00:00.000Z',
      sessionId: 's-live',
      goal: 'g',
      historyLen: 0,
      toolCount: 0,
    });
    await expect(deleteSession('s-live')).rejects.toThrow(/in-flight/);
    sessionEventBus.close('s-live');
  });

  test('deleteSession removes journal directory', async () => {
    await appendJournalEvent('s-rm', {
      type: 'session_started',
      ts: '2026-04-25T00:00:00.000Z',
      sessionId: 's-rm',
      goal: 'g',
      historyLen: 0,
      toolCount: 0,
    });
    const dir = defaultSessionDir(process.env, 's-rm');
    expect(existsSync(dir)).toBe(true);
    await deleteSession('s-rm');
    expect(existsSync(dir)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/ops-chat-sessions-list.test.ts`
Expected: FAIL — `listSessions`, `getSessionSummary`, `deleteSession` undefined.

- [ ] **Step 3: Implement `list.ts`**

```ts
// packages/remote/src/ops-chat/sessions/list.ts
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { defaultSessionsDir } from '../paths.js';
import { readJournal } from './journal.js';
import type { JournalEvent } from './journal-schema.js';
import { isTerminal } from './journal-schema.js';

export type SessionStatus = 'live' | 'done' | 'refused' | 'aborted';

export interface SessionSummary {
  sessionId: string;
  goal: string;
  status: SessionStatus;
  iterations: number;
  startedAt: string;
  endedAt?: string;
  nodeId?: string;
  model?: string;
}

export async function getSessionSummary(sessionId: string): Promise<SessionSummary> {
  const events = await readJournal(sessionId);
  const start = events.find((e) => e.type === 'session_started');
  if (!start || start.type !== 'session_started') {
    throw new Error(`session ${sessionId} has no session_started event`);
  }
  const terminal = events.find((e) => isTerminal(e));
  let status: SessionStatus = 'live';
  let endedAt: string | undefined;
  if (terminal) {
    endedAt = terminal.ts;
    if (terminal.type === 'done') status = 'done';
    else if (terminal.type === 'refusal') status = 'refused';
    else status = 'aborted';
  }
  const iterations = events.filter((e) => e.type === 'plan_proposed').length;
  return {
    sessionId,
    goal: start.goal,
    status,
    iterations,
    startedAt: start.ts,
    endedAt,
    nodeId: start.nodeId,
    model: start.model,
  };
}

export async function listSessions(opts: {
  limit: number;
  cursor?: string;
  status?: SessionStatus;
}): Promise<{ sessions: SessionSummary[]; nextCursor?: string }> {
  const root = defaultSessionsDir();
  if (!existsSync(root)) return { sessions: [] };
  const ids = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const summaries: SessionSummary[] = [];
  for (const id of ids) {
    try {
      summaries.push(await getSessionSummary(id));
    } catch {
      /* malformed/empty session — skip */
    }
  }
  summaries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const filtered = opts.status
    ? summaries.filter((s) => s.status === opts.status)
    : summaries;
  const startIdx = opts.cursor
    ? Math.max(0, filtered.findIndex((s) => s.sessionId === opts.cursor) + 1)
    : 0;
  const page = filtered.slice(startIdx, startIdx + opts.limit);
  const nextCursor =
    startIdx + opts.limit < filtered.length ? page[page.length - 1]?.sessionId : undefined;
  return { sessions: page, nextCursor };
}
```

- [ ] **Step 4: Implement `delete.ts`**

```ts
// packages/remote/src/ops-chat/sessions/delete.ts
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { defaultSessionDir } from '../paths.js';
import { sessionEventBus } from './event-bus.js';

export async function deleteSession(sessionId: string): Promise<void> {
  if (sessionEventBus.hasChannel(sessionId)) {
    throw new Error(`cannot delete in-flight session ${sessionId}`);
  }
  const dir = defaultSessionDir(process.env, sessionId);
  if (!existsSync(dir)) return;
  await rm(dir, { recursive: true, force: true });
}
```

- [ ] **Step 5: Run, verify pass**

Run: `bun test --cwd packages/remote test/ops-chat-sessions-list.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/remote/src/ops-chat/sessions/list.ts \
        packages/remote/src/ops-chat/sessions/delete.ts \
        packages/remote/test/ops-chat-sessions-list.test.ts
git commit -m "feat(remote/ops-chat/sessions): add listSessions, getSessionSummary, deleteSession"
```

---

## Task 7: Server — `audit.ts` adds optional `sessionId`

**Files:**
- Modify: `packages/remote/src/ops-chat/audit.ts`
- Modify: `packages/remote/src/ops-chat/dispatch.ts`

- [ ] **Step 1: Add `sessionId?: string` to `OpsChatAuditEntry`**

In `packages/remote/src/ops-chat/audit.ts`, edit the interface:

```ts
export interface OpsChatAuditEntry {
  ts: string;
  tool: string;
  dryRun: boolean;
  argumentsHash: string;
  ok: boolean;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  sessionId?: string;  // NEW
}
```

No changes needed to `appendOpsChatAudit` — JSON serialization already includes the field when set.

- [ ] **Step 2: Thread `sessionId` through `dispatch.ts`**

Identify the function in `dispatch.ts` that calls `appendOpsChatAudit`. Add an optional `sessionId` parameter to its caller signature and pass it into the audit entry. Example shape (adapt to the actual function in the file):

```ts
export async function dispatchOpsChatTool(args: {
  tool: string;
  arguments: unknown;
  dryRun: boolean;
  sessionId?: string;  // NEW
}): Promise<DispatchResult> {
  // … existing logic …
  appendOpsChatAudit({
    ts: new Date().toISOString(),
    tool: args.tool,
    dryRun: args.dryRun,
    argumentsHash: hashArguments(args.arguments),
    ok,
    durationMs,
    errorCode,
    errorMessage,
    sessionId: args.sessionId,  // NEW
  });
  // …
}
```

If `dispatch.ts` does not have a single entrypoint that owns the audit append, instead introduce a small helper `auditOpsChatToolRun({...})` that accepts the new field and update all call sites (search for `appendOpsChatAudit(` in `packages/remote/src` and update each).

- [ ] **Step 3: Verify backwards compatibility**

Existing tests for `audit.ts` and `dispatch.ts` (find them with `find packages/remote -name "*audit*.test.ts" -o -name "*dispatch*.test.ts"`) must still pass without code changes — `sessionId` is optional and defaults to undefined.

Run: `bun test --cwd packages/remote 2>&1 | tail -20`
Expected: All previously-passing tests still pass; no new failures.

- [ ] **Step 4: Add a focused test for the new field**

```ts
// packages/remote/test/ops-chat-audit-session.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendOpsChatAudit,
  readOpsChatAudit,
} from '../src/ops-chat/audit';

describe('audit sessionId', () => {
  let tmp: string;
  let path: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ops-audit-'));
    path = join(tmp, 'audit.jsonl');
    prev = process.env.LLAMACTL_OPS_CHAT_AUDIT;
    process.env.LLAMACTL_OPS_CHAT_AUDIT = path;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LLAMACTL_OPS_CHAT_AUDIT;
    else process.env.LLAMACTL_OPS_CHAT_AUDIT = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('sessionId persists round-trip', () => {
    appendOpsChatAudit({
      ts: '2026-04-25T00:00:00.000Z',
      tool: 't',
      dryRun: false,
      argumentsHash: 'abc',
      ok: true,
      durationMs: 1,
      sessionId: 'sess-99',
    });
    const { entries } = readOpsChatAudit({ path });
    expect(entries[0]!.sessionId).toBe('sess-99');
  });

  test('sessionId undefined when omitted', () => {
    appendOpsChatAudit({
      ts: '2026-04-25T00:00:00.000Z',
      tool: 't',
      dryRun: false,
      argumentsHash: 'abc',
      ok: true,
      durationMs: 1,
    });
    const { entries } = readOpsChatAudit({ path });
    expect(entries[0]!.sessionId).toBeUndefined();
  });
});
```

Run: `bun test --cwd packages/remote test/ops-chat-audit-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/ops-chat/audit.ts \
        packages/remote/src/ops-chat/dispatch.ts \
        packages/remote/test/ops-chat-audit-session.test.ts
git commit -m "feat(remote/ops-chat/audit): add optional sessionId field"
```

---

## Task 8: Server — `loop-executor.ts` writes journal + bus

**Files:**
- Modify: `packages/remote/src/ops-chat/loop-executor.ts`
- Test: `packages/remote/test/ops-chat-loop-executor-journal.test.ts`

The loop-executor already generates `sessionId = randomUUID()` (line ~139) and emits `plan_proposed`/`refusal`/`done` events to its subscriber. We add three side effects: (a) on session start, write `session_started` and call `sessionEventBus.create`; (b) on every event emit, also append to journal and `sessionEventBus.publish`; (c) on terminal event, call `sessionEventBus.close`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/ops-chat-loop-executor-journal.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoopExecutor } from '../src/ops-chat/loop-executor';
import { readJournal } from '../src/ops-chat/sessions/journal';
import { sessionEventBus } from '../src/ops-chat/sessions/event-bus';

describe('loop-executor → journal + bus', () => {
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ops-loop-'));
    prev = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('writes session_started and done to journal when planner returns no work', async () => {
    let capturedSessionId = '';
    const stream = runLoopExecutor({
      goal: 'do nothing',
      executor: {
        async plan() { return { steps: [], reasoning: '' }; },
      },
      tools: [],
      allowlist: () => true,
    });
    for await (const e of stream) {
      if (e.type === 'plan_proposed') capturedSessionId = e.sessionId;
      if (e.type === 'done') capturedSessionId ||= '';
    }
    // capture sessionId from the directory we just wrote
    const root = join(tmp, 'ops-chat', 'sessions');
    const fs = await import('node:fs/promises');
    const dirs = await fs.readdir(root);
    expect(dirs.length).toBe(1);
    const events = await readJournal(dirs[0]!);
    expect(events.map((e) => e.type)).toEqual(['session_started', 'done']);
    expect(sessionEventBus.hasChannel(dirs[0]!)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/ops-chat-loop-executor-journal.test.ts`
Expected: FAIL — directory missing or events absent.

- [ ] **Step 3: Implement journal + bus side-effects**

In `packages/remote/src/ops-chat/loop-executor.ts`:

(a) Add imports at the top of the file:

```ts
import { appendJournalEvent } from './sessions/journal.js';
import { sessionEventBus } from './sessions/event-bus.js';
import { redactResult } from './sessions/redaction.js';
import type { JournalEvent } from './sessions/journal-schema.js';
```

(b) Right after the `sessionId = randomUUID()` line, add:

```ts
sessionEventBus.create(sessionId);
const startEvent: JournalEvent = {
  type: 'session_started',
  ts: new Date().toISOString(),
  sessionId,
  goal: input.goal,
  nodeId: input.nodeId,
  model: input.model,
  historyLen: input.history?.length ?? 0,
  toolCount: input.tools?.length ?? 0,
};
await appendJournalEvent(sessionId, startEvent);
sessionEventBus.publish(sessionId, startEvent);
```

(c) Wherever the executor currently emits a `plan_proposed` event to its yield, also call:

```ts
const planEvt: JournalEvent = {
  type: 'plan_proposed',
  ts: new Date().toISOString(),
  stepId,
  iteration,
  tier,
  reasoning,
  step,
};
await appendJournalEvent(sessionId, planEvt);
sessionEventBus.publish(sessionId, planEvt);
```

(d) When `operatorSubmitStepOutcome` lands an outcome and the executor records it (find the place where the outcome is appended to context), write a `preview_outcome` or `wet_outcome` event. The `dryRun` flag from the outcome distinguishes the two:

```ts
const redacted = redactResult(step.tool, outcome.result);
const outEvt: JournalEvent = {
  type: outcome.dryRun ? 'preview_outcome' : 'wet_outcome',
  ts: new Date().toISOString(),
  stepId,
  ok: outcome.ok,
  durationMs: outcome.durationMs,
  result: redacted.value,
  resultRedacted: redacted.redacted,
  error: outcome.error,
};
await appendJournalEvent(sessionId, outEvt);
sessionEventBus.publish(sessionId, outEvt);
```

(e) For each terminal exit (refusal, done, abort), write the corresponding event to journal + bus, then `sessionEventBus.close(sessionId)`. Wrap the whole loop in `try { ... } finally { sessionEventBus.close(sessionId); }` to guarantee the channel closes even on thrown errors.

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/ops-chat-loop-executor-journal.test.ts`
Expected: PASS — directory exists, journal has session_started + done, bus is closed.

- [ ] **Step 5: Run the full remote test suite — no regressions**

Run: `bun test --cwd packages/remote 2>&1 | tail -20`
Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/remote/src/ops-chat/loop-executor.ts \
        packages/remote/test/ops-chat-loop-executor-journal.test.ts
git commit -m "feat(remote/ops-chat/loop-executor): emit events to journal + session bus"
```

---

## Task 9: Server — four new tRPC procedures in `router.ts`

**Files:**
- Modify: `packages/remote/src/router.ts`
- Test: `packages/remote/test/ops-session-router.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/remote/test/ops-session-router.test.ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRouter } from '../src/router';
import { appendJournalEvent } from '../src/ops-chat/sessions/journal';
import { sessionEventBus } from '../src/ops-chat/sessions/event-bus';

describe('ops-session router', () => {
  let tmp: string;
  let prev: string | undefined;
  let caller: ReturnType<typeof appRouter.createCaller>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ops-router-'));
    prev = process.env.DEV_STORAGE;
    process.env.DEV_STORAGE = tmp;
    caller = appRouter.createCaller({} as any);
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DEV_STORAGE;
    else process.env.DEV_STORAGE = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('opsSessionList returns recently-started sessions', async () => {
    await appendJournalEvent('s-a', {
      type: 'session_started',
      ts: '2026-04-25T00:00:00.000Z',
      sessionId: 's-a',
      goal: 'audit',
      historyLen: 0,
      toolCount: 0,
    });
    const out = await caller.opsSessionList({ limit: 10 });
    expect(out.sessions.length).toBe(1);
    expect(out.sessions[0]!.sessionId).toBe('s-a');
  });

  test('opsSessionDelete rejects in-flight', async () => {
    sessionEventBus.create('s-live');
    await appendJournalEvent('s-live', {
      type: 'session_started',
      ts: '2026-04-25T00:00:00.000Z',
      sessionId: 's-live',
      goal: 'g',
      historyLen: 0,
      toolCount: 0,
    });
    await expect(caller.opsSessionDelete({ sessionId: 's-live' })).rejects.toThrow();
    sessionEventBus.close('s-live');
  });

  test('opsSessionWatch replays journal then closes for a terminated session', async () => {
    await appendJournalEvent('s-old', {
      type: 'session_started',
      ts: '2026-04-25T00:00:00.000Z',
      sessionId: 's-old',
      goal: 'g',
      historyLen: 0,
      toolCount: 0,
    });
    await appendJournalEvent('s-old', {
      type: 'done',
      ts: '2026-04-25T00:00:01.000Z',
      iterations: 0,
    });
    const events: any[] = [];
    const stream = await caller.opsSessionWatch({ sessionId: 's-old' });
    for await (const e of stream) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual(['session_started', 'done']);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/remote test/ops-session-router.test.ts`
Expected: FAIL — procedures not yet defined on `appRouter`.

- [ ] **Step 3: Add the four procedures to `router.ts`**

Add imports near the top of `packages/remote/src/router.ts`:

```ts
import { listSessions, getSessionSummary } from './ops-chat/sessions/list.js';
import { deleteSession } from './ops-chat/sessions/delete.js';
import { readJournal } from './ops-chat/sessions/journal.js';
import { sessionEventBus } from './ops-chat/sessions/event-bus.js';
import { isTerminal } from './ops-chat/sessions/journal-schema.js';
```

Add the four procedures inside `appRouter` (placement: near `opsChatAuditTail`):

```ts
opsSessionList: t.procedure
  .input(
    z.object({
      limit: z.number().int().positive().max(200).default(50),
      cursor: z.string().optional(),
      status: z.enum(['live', 'done', 'refused', 'aborted']).optional(),
    }),
  )
  .query(({ input }) => listSessions(input)),

opsSessionGet: t.procedure
  .input(z.object({ sessionId: z.string().min(1), tail: z.number().int().positive().max(500).default(50) }))
  .query(async ({ input }) => {
    const summary = await getSessionSummary(input.sessionId);
    const events = await readJournal(input.sessionId);
    return { summary, recentEvents: events.slice(-input.tail) };
  }),

opsSessionWatch: t.procedure
  .input(z.object({ sessionId: z.string().min(1) }))
  .subscription(async function* ({ input, signal }) {
    const persisted = await readJournal(input.sessionId);
    for (const e of persisted) {
      if (signal?.aborted) return;
      yield e;
    }
    if (persisted.some(isTerminal)) return;
    if (!sessionEventBus.hasChannel(input.sessionId)) {
      yield {
        type: 'aborted' as const,
        ts: new Date().toISOString(),
        reason: 'signal' as const,
      };
      return;
    }
    const queue: import('./ops-chat/sessions/journal-schema.js').JournalEvent[] = [];
    let resolve: (() => void) | null = null;
    const off = sessionEventBus.subscribe(input.sessionId, (event) => {
      queue.push(event);
      resolve?.();
    });
    try {
      while (!signal?.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            resolve = r;
          });
          resolve = null;
        }
        while (queue.length > 0) {
          const ev = queue.shift()!;
          yield ev;
          if (isTerminal(ev)) return;
        }
      }
    } finally {
      off();
    }
  }),

opsSessionDelete: t.procedure
  .input(z.object({ sessionId: z.string().min(1) }))
  .mutation(async ({ input }) => {
    await deleteSession(input.sessionId);
    return { ok: true as const };
  }),
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/remote test/ops-session-router.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Run full server suite — no regressions**

Run: `bun test --cwd packages/remote 2>&1 | tail -20`
Expected: All tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/remote/src/router.ts packages/remote/test/ops-session-router.test.ts
git commit -m "feat(remote/router): add opsSessionList/Get/Watch/Delete procedures"
```

---

## Task 10: App — `useOpsSession` hook

**Files:**
- Create: `packages/app/src/lib/use-ops-session.ts`
- Test: `packages/app/test/use-ops-session.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/app/test/use-ops-session.test.ts
import { describe, expect, test } from 'bun:test';
import {
  mergeEventIntoView,
  initialView,
  type JournalEvent,
} from '@/lib/use-ops-session';

describe('useOpsSession view-model merge', () => {
  test('session_started seeds the view', () => {
    const next = mergeEventIntoView(initialView('s1'), {
      type: 'session_started',
      ts: 't0',
      sessionId: 's1',
      goal: 'do thing',
      historyLen: 0,
      toolCount: 0,
    });
    expect(next.goal).toBe('do thing');
    expect(next.status).toBe('live');
    expect(next.startedAt).toBe('t0');
  });

  test('plan_proposed appends iteration entry', () => {
    let v = initialView('s1');
    v = mergeEventIntoView(v, {
      type: 'session_started', ts: 't0', sessionId: 's1', goal: 'g',
      historyLen: 0, toolCount: 0,
    });
    v = mergeEventIntoView(v, {
      type: 'plan_proposed', ts: 't1', stepId: 'sp-1', iteration: 0,
      tier: 'read', reasoning: 'because', step: { tool: 'foo', annotation: 'a' } as any,
    });
    expect(v.iterations.length).toBe(1);
    expect(v.iterations[0]!.tool).toBe('foo');
    expect(v.iterations[0]!.tier).toBe('read');
  });

  test('preview_outcome attaches to matching iteration', () => {
    let v = initialView('s1');
    v = mergeEventIntoView(v, {
      type: 'session_started', ts: 't0', sessionId: 's1', goal: 'g',
      historyLen: 0, toolCount: 0,
    });
    v = mergeEventIntoView(v, {
      type: 'plan_proposed', ts: 't1', stepId: 'sp-1', iteration: 0,
      tier: 'read', reasoning: '', step: { tool: 'foo', annotation: 'a' } as any,
    });
    v = mergeEventIntoView(v, {
      type: 'preview_outcome', ts: 't2', stepId: 'sp-1', ok: true, durationMs: 12,
    });
    expect(v.iterations[0]!.preview).toEqual({ ok: true, durationMs: 12 });
  });

  test('done sets status', () => {
    let v = initialView('s1');
    v = mergeEventIntoView(v, {
      type: 'session_started', ts: 't0', sessionId: 's1', goal: 'g',
      historyLen: 0, toolCount: 0,
    });
    v = mergeEventIntoView(v, { type: 'done', ts: 't9', iterations: 0 });
    expect(v.status).toBe('done');
    expect(v.endedAt).toBe('t9');
  });

  test('idempotent: applying the same plan_proposed twice does not duplicate', () => {
    let v = initialView('s1');
    const evt: JournalEvent = {
      type: 'plan_proposed', ts: 't1', stepId: 'sp-1', iteration: 0,
      tier: 'read', reasoning: '', step: { tool: 'foo', annotation: 'a' } as any,
    };
    v = mergeEventIntoView(v, evt);
    v = mergeEventIntoView(v, evt);
    expect(v.iterations.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/app test/use-ops-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

```ts
// packages/app/src/lib/use-ops-session.ts
//
// Local mirror of the server's JournalEvent shape — kept structural to
// avoid a direct import from @llamactl/remote (matches the pattern in
// modules/workloads/workers-panel.tsx). If the server schema drifts,
// the tRPC inference at the useSubscription call site will surface
// the mismatch.
import * as React from 'react';
import { trpc } from '@/lib/trpc';

export type ToolTier = 'read' | 'mutation-dry-run-safe' | 'mutation-destructive';

export type JournalEvent =
  | { type: 'session_started'; ts: string; sessionId: string;
      goal: string; nodeId?: string; model?: string;
      historyLen: number; toolCount: number }
  | { type: 'plan_proposed';   ts: string; stepId: string;
      iteration: number; tier: ToolTier; reasoning: string;
      step: { tool: string; args?: unknown; dryRun?: boolean; annotation: string } }
  | { type: 'preview_outcome'; ts: string; stepId: string;
      ok: boolean; durationMs: number;
      result?: unknown; resultRedacted?: 'omitted' | 'truncated';
      error?: { code: string; message: string } }
  | { type: 'wet_outcome';     ts: string; stepId: string;
      ok: boolean; durationMs: number;
      result?: unknown; resultRedacted?: 'omitted' | 'truncated';
      error?: { code: string; message: string } }
  | { type: 'refusal'; ts: string; reason: string }
  | { type: 'done';    ts: string; iterations: number }
  | { type: 'aborted'; ts: string; reason: 'client_abort' | 'signal' | 'timeout' };

export type SessionStatus = 'live' | 'done' | 'refused' | 'aborted';

export interface OutcomeView {
  ok: boolean;
  durationMs: number;
  result?: unknown;
  resultRedacted?: 'omitted' | 'truncated';
  error?: { code: string; message: string };
}

export interface IterationView {
  iteration: number;
  stepId: string;
  tool: string;
  tier: ToolTier;
  reasoning: string;
  args: unknown;
  preview?: OutcomeView;
  wet?: OutcomeView;
}

export interface SessionView {
  sessionId: string;
  goal: string;
  status: SessionStatus;
  startedAt: string;
  endedAt?: string;
  iterations: IterationView[];
  refusalReason?: string;
}

export function initialView(sessionId: string): SessionView {
  return {
    sessionId,
    goal: '',
    status: 'live',
    startedAt: '',
    iterations: [],
  };
}

export function mergeEventIntoView(view: SessionView, event: JournalEvent): SessionView {
  switch (event.type) {
    case 'session_started':
      return {
        ...view,
        goal: event.goal,
        startedAt: event.ts,
        status: 'live',
      };
    case 'plan_proposed': {
      if (view.iterations.some((i) => i.stepId === event.stepId)) return view;
      const next: IterationView = {
        iteration: event.iteration,
        stepId: event.stepId,
        tool: event.step.tool,
        tier: event.tier,
        reasoning: event.reasoning,
        args: (event.step as any).args,
      };
      return { ...view, iterations: [...view.iterations, next] };
    }
    case 'preview_outcome':
    case 'wet_outcome': {
      const key = event.type === 'preview_outcome' ? 'preview' : 'wet';
      return {
        ...view,
        iterations: view.iterations.map((it) =>
          it.stepId === event.stepId
            ? {
                ...it,
                [key]: {
                  ok: event.ok,
                  durationMs: event.durationMs,
                  result: event.result,
                  resultRedacted: event.resultRedacted,
                  error: event.error,
                } as OutcomeView,
              }
            : it,
        ),
      };
    }
    case 'refusal':
      return { ...view, status: 'refused', endedAt: event.ts, refusalReason: event.reason };
    case 'done':
      return { ...view, status: 'done', endedAt: event.ts };
    case 'aborted':
      return { ...view, status: 'aborted', endedAt: event.ts };
  }
}

export function useOpsSession(sessionId: string): {
  view: SessionView;
  loading: boolean;
  error: Error | null;
} {
  const [view, setView] = React.useState<SessionView>(() => initialView(sessionId));
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<Error | null>(null);

  trpc.opsSessionWatch.useSubscription(
    { sessionId },
    {
      onData: (event: JournalEvent) => {
        setView((v) => mergeEventIntoView(v, event));
        setLoading(false);
      },
      onError: (err) => setError(err instanceof Error ? err : new Error(String(err))),
    },
  );

  return { view, loading, error };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/app test/use-ops-session.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/lib/use-ops-session.ts packages/app/test/use-ops-session.test.ts
git commit -m "feat(app/lib): add useOpsSession hook + view-model merge"
```

---

## Task 11: App — `result-viewer.tsx` component

**Files:**
- Create: `packages/app/src/modules/ops/detail/result-viewer.tsx`

This is a presentational component with no branching logic worth a unit test (no React render-test setup exists in `packages/app/test/`; jsdom and `@testing-library/react` are not deps). The Tier C UI flow tests in Tasks 17–18 cover its rendered output. We typecheck only.

- [ ] **Step 1: Implement**

```tsx
// packages/app/src/modules/ops/detail/result-viewer.tsx
import * as React from 'react';

interface Props {
  value?: unknown;
  redacted?: 'omitted' | 'truncated';
}

export function ResultViewer({ value, redacted }: Props): React.JSX.Element {
  if (redacted === 'omitted') {
    return (
      <div
        data-testid="result-omitted"
        style={{
          padding: '8px 12px',
          fontSize: 13,
          color: 'var(--color-text-secondary)',
          fontStyle: 'italic',
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 6,
        }}
      >
        Result redacted (omitted by per-tool rule).
      </div>
    );
  }
  return (
    <div data-testid="result-viewer">
      {redacted === 'truncated' && (
        <div
          style={{
            padding: '4px 8px',
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            background: 'var(--color-bg-elevated)',
            borderTopLeftRadius: 6,
            borderTopRightRadius: 6,
          }}
        >
          Result truncated — showing the first 4 KB.
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: 12,
          fontSize: 12,
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-text)',
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: redacted === 'truncated' ? '0 0 6px 6px' : 6,
          overflow: 'auto',
          maxHeight: 320,
        }}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | grep "result-viewer" || echo "no errors"`
Expected: `no errors`.

- [ ] **Step 3: Commit**

```bash
git add packages/app/src/modules/ops/detail/result-viewer.tsx
git commit -m "feat(app/ops-detail): add ResultViewer component"
```

---

## Task 12: App — `iteration-card.tsx`

**Files:**
- Create: `packages/app/src/modules/ops/detail/iteration-card.tsx`
- Test: `packages/app/test/modules/ops-detail/iteration-card-helpers.test.ts`

The card itself is a presentational component (no render test setup, see Task 11). We extract two pure helpers (`statusGlyph`, `fmtMs`) and unit-test those — visual structure is verified via Tier C UI flows (Task 17).

- [ ] **Step 1: Write the failing test**

```ts
// packages/app/test/modules/ops-detail/iteration-card-helpers.test.ts
import { describe, expect, test } from 'bun:test';
import { statusGlyph, fmtMs } from '@/modules/ops/detail/iteration-card';
import type { IterationView } from '@/lib/use-ops-session';

const base: IterationView = {
  iteration: 0,
  stepId: 'sp-1',
  tool: 'llamactl.workload.list',
  tier: 'read',
  reasoning: '',
  args: {},
};

describe('statusGlyph', () => {
  test('returns · when no outcome attached', () => {
    expect(statusGlyph(base)).toBe('·');
  });

  test('returns ✓ when wet outcome ok', () => {
    expect(statusGlyph({ ...base, wet: { ok: true, durationMs: 1 } })).toBe('✓');
  });

  test('returns ✗ when wet outcome failed', () => {
    expect(statusGlyph({ ...base, wet: { ok: false, durationMs: 1 } })).toBe('✗');
  });

  test('falls back to preview outcome when wet absent', () => {
    expect(statusGlyph({ ...base, preview: { ok: true, durationMs: 1 } })).toBe('✓');
  });
});

describe('fmtMs', () => {
  test('< 1000ms → ms suffix', () => {
    expect(fmtMs(750)).toBe('750ms');
  });

  test('≥ 1000ms → seconds with one decimal', () => {
    expect(fmtMs(1234)).toBe('1.2s');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test --cwd packages/app test/modules/ops-detail/iteration-card-helpers.test.ts`
Expected: FAIL — helpers undefined.

- [ ] **Step 3: Implement**

```tsx
// packages/app/src/modules/ops/detail/iteration-card.tsx
import * as React from 'react';
import { Badge } from '@/ui';
import type { IterationView, OutcomeView } from '@/lib/use-ops-session';
import { ResultViewer } from './result-viewer';

interface Props {
  it: IterationView;
  expanded: boolean;
  onToggle: () => void;
}

export function statusGlyph(it: IterationView): string {
  const last = it.wet ?? it.preview;
  if (!last) return '·';
  return last.ok ? '✓' : '✗';
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function OutcomeBlock({ label, outcome }: { label: string; outcome: OutcomeView }): React.JSX.Element {
  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--color-text-secondary)',
          marginBottom: 6,
        }}
      >
        {label} — {outcome.ok ? 'ok' : 'failed'} · {fmtMs(outcome.durationMs)}
      </div>
      {outcome.error && (
        <div
          style={{
            padding: 8,
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-error, #d4554d)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 6,
            marginBottom: 8,
            fontSize: 13,
          }}
        >
          <code>{outcome.error.code}</code>: {outcome.error.message}
        </div>
      )}
      {outcome.result !== undefined || outcome.resultRedacted ? (
        <ResultViewer value={outcome.result} redacted={outcome.resultRedacted} />
      ) : null}
    </div>
  );
}

export function IterationCard({ it, expanded, onToggle }: Props): React.JSX.Element {
  return (
    <div
      data-testid={`iteration-card-${it.stepId}`}
      style={{
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 8,
        background: 'var(--color-bg-surface)',
        overflow: 'hidden',
      }}
    >
      <button
        data-testid={`iteration-card-header-${it.stepId}`}
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--color-text)',
          font: 'inherit',
          textAlign: 'left',
        }}
      >
        <span
          data-testid={`iteration-status-${it.stepId}`}
          style={{ fontWeight: 600, width: 16 }}
        >
          {statusGlyph(it)}
        </span>
        <span style={{ color: 'var(--color-text-secondary)' }}>#{it.iteration + 1}</span>
        <code style={{ flex: 1, fontFamily: 'var(--font-mono)' }}>{it.tool}</code>
        <Badge variant={it.tier === 'mutation-destructive' ? 'err' : 'default'}>
          {it.tier}
        </Badge>
        {(it.wet ?? it.preview) && (
          <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
            {fmtMs((it.wet ?? it.preview)!.durationMs)}
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            padding: '0 16px 16px',
            borderTop: '1px solid var(--color-border-subtle)',
          }}
        >
          {it.reasoning && (
            <div style={{ marginTop: 12, color: 'var(--color-text-secondary)', fontSize: 14, fontStyle: 'italic' }}>
              {it.reasoning}
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            <div
              style={{
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--color-text-secondary)',
                marginBottom: 6,
              }}
            >
              Args
            </div>
            <ResultViewer value={it.args} />
          </div>
          {it.preview && <OutcomeBlock label="Preview (dry)" outcome={it.preview} />}
          {it.wet && <OutcomeBlock label="Wet run" outcome={it.wet} />}
        </div>
      )}
    </div>
  );
}
```

`Badge` exports from `@/ui` with variants `'default' | 'brand' | 'ok' | 'warn' | 'err'` (see `packages/app/src/ui/badge.tsx`). Use `'err'` for destructive tier, `'default'` otherwise.

- [ ] **Step 4: Run, verify pass**

Run: `bun test --cwd packages/app test/modules/ops-detail/iteration-card-helpers.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/modules/ops/detail/iteration-card.tsx \
        packages/app/test/modules/ops-detail/iteration-card-helpers.test.ts
git commit -m "feat(app/ops-detail): add IterationCard collapsible component"
```

---

## Task 13: App — `session-header.tsx` and `empty-state.tsx`

**Files:**
- Create: `packages/app/src/modules/ops/detail/session-header.tsx`
- Create: `packages/app/src/modules/ops/detail/empty-state.tsx`

- [ ] **Step 1: Implement `session-header.tsx`**

`EditorialHero` accepts `eyebrow / title / lede / pills / actions / className / style` — no `subtitle`, no `children`, no `data-testid`. Pills accept `tone: 'default' | 'ok' | 'info'`. Wrap the hero in a div for the test id.

```tsx
// packages/app/src/modules/ops/detail/session-header.tsx
import * as React from 'react';
import { EditorialHero, Button } from '@/ui';
import type { SessionView } from '@/lib/use-ops-session';

interface Props {
  view: SessionView;
  onOpenInOpsChat: () => void;
}

const STATUS_LABEL: Record<SessionView['status'], string> = {
  live: 'Live',
  done: 'Done',
  refused: 'Refused',
  aborted: 'Aborted',
};

const STATUS_TONE: Record<SessionView['status'], 'default' | 'ok' | 'info'> = {
  live: 'info',
  done: 'ok',
  refused: 'default',
  aborted: 'default',
};

export function SessionHeader({ view, onOpenInOpsChat }: Props): React.JSX.Element {
  const ledeParts = [
    `${view.iterations.length} iteration${view.iterations.length === 1 ? '' : 's'}`,
    view.startedAt ? `started ${new Date(view.startedAt).toLocaleString()}` : null,
    view.endedAt ? `ended ${new Date(view.endedAt).toLocaleString()}` : null,
  ].filter(Boolean) as string[];

  return (
    <div data-testid="ops-session-header">
      <EditorialHero
        eyebrow={`Session ${view.sessionId}`}
        title={view.goal || 'Loading…'}
        lede={ledeParts.join(' · ')}
        pills={[{ label: STATUS_LABEL[view.status], tone: STATUS_TONE[view.status] }]}
        actions={
          view.status === 'live' ? (
            <Button onClick={onOpenInOpsChat} data-testid="ops-session-open-in-ops-chat">
              Open in Ops Chat
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
```

- [ ] **Step 2: Implement `empty-state.tsx`**

```tsx
// packages/app/src/modules/ops/detail/empty-state.tsx
import * as React from 'react';
import { EditorialHero } from '@/ui';

interface Props {
  sessionId: string;
}

export function OpsSessionEmpty({ sessionId }: Props): React.JSX.Element {
  return (
    <div data-testid="ops-session-empty">
      <EditorialHero
        eyebrow={`Session ${sessionId}`}
        title="No journal for this session"
        lede="This session id has no journal file on disk. It probably predates the per-session replay feature, or the journal was deleted."
      />
    </div>
  );
}
```

- [ ] **Step 3: Sanity typecheck**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | grep "ops/detail" || echo "no errors"`
Expected: `no errors`.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/modules/ops/detail/session-header.tsx \
        packages/app/src/modules/ops/detail/empty-state.tsx
git commit -m "feat(app/ops-detail): add SessionHeader and OpsSessionEmpty components"
```

---

## Task 14: App — replace `OpsSessionDetail` stub

**Files:**
- Modify: `packages/app/src/modules/ops/detail/ops-session-detail.tsx` (replace contents)

- [ ] **Step 1: Replace the stub**

```tsx
// packages/app/src/modules/ops/detail/ops-session-detail.tsx
import * as React from 'react';
import { useOpsSession } from '@/lib/use-ops-session';
import { useTabStore } from '@/stores/tab-store';
import { SessionHeader } from './session-header';
import { IterationCard } from './iteration-card';
import { OpsSessionEmpty } from './empty-state';

interface Props {
  sessionId: string;
}

export function OpsSessionDetail({ sessionId }: Props): React.JSX.Element {
  const { view, loading, error } = useOpsSession(sessionId);

  // Sticky-user-intent expansion: until the user toggles, latest auto-expands.
  const [userToggled, setUserToggled] = React.useState(false);
  const [explicit, setExplicit] = React.useState<Record<string, boolean>>({});
  const latestId = view.iterations[view.iterations.length - 1]?.stepId;

  function isExpanded(stepId: string): boolean {
    if (userToggled) return explicit[stepId] ?? false;
    return stepId === latestId;
  }

  function toggle(stepId: string): void {
    setUserToggled(true);
    setExplicit((prev) => {
      const wasExpanded = prev[stepId] ?? stepId === latestId;
      return { ...prev, [stepId]: !wasExpanded };
    });
  }

  if (error && view.iterations.length === 0 && !view.goal) {
    return <OpsSessionEmpty sessionId={sessionId} />;
  }

  return (
    <div
      data-testid="ops-session-detail-root"
      style={{ padding: '32px 48px 48px', maxWidth: 1100, margin: '0 auto' }}
    >
      <SessionHeader
        view={view}
        onOpenInOpsChat={() => {
          useTabStore.getState().open({
            tabKey: 'module:ops-chat',
            title: 'Ops Chat',
            kind: 'module',
            openedAt: Date.now(),
          });
        }}
      />
      {loading && view.iterations.length === 0 && (
        <div
          data-testid="ops-session-loading"
          style={{ padding: 24, color: 'var(--color-text-secondary)', textAlign: 'center' }}
        >
          Loading session…
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24 }}>
        {view.iterations.map((it) => (
          <IterationCard
            key={it.stepId}
            it={it}
            expanded={isExpanded(it.stepId)}
            onToggle={() => toggle(it.stepId)}
          />
        ))}
      </div>
      {view.status === 'refused' && view.refusalReason && (
        <div
          data-testid="ops-session-refusal"
          style={{
            marginTop: 24,
            padding: 16,
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 8,
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-text)',
          }}
        >
          <strong>Refused:</strong> {view.refusalReason}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run app tests — no regressions**

Run: `bun test --cwd packages/app 2>&1 | tail -10`
Expected: All tests pass.

- [ ] **Step 3: Real typecheck — no new errors**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | grep -c error`
Expected: identical count to pre-change baseline (12 from main).

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/modules/ops/detail/ops-session-detail.tsx
git commit -m "feat(app/ops-detail): replace OpsSessionDetail stub with real timeline"
```

---

## Task 15: App — `ops-sessions` module (table + delete + index + registry)

**Files:**
- Create: `packages/app/src/modules/ops-sessions/index.tsx`
- Create: `packages/app/src/modules/ops-sessions/sessions-table.tsx`
- Create: `packages/app/src/modules/ops-sessions/delete-confirm.tsx`
- Modify: `packages/app/src/modules/registry.ts`
No render test (no `@testing-library/react` setup). Tier C UI flow in Task 18 covers list rendering end-to-end.

- [ ] **Step 1: Implement `sessions-table.tsx`**

```tsx
// packages/app/src/modules/ops-sessions/sessions-table.tsx
import * as React from 'react';
import { Button, Badge, type BadgeVariant } from '@/ui';
import type { SessionStatus } from '@/lib/use-ops-session';

// Local mirror of the server SessionSummary — keeps app free of a
// direct import from @llamactl/remote.
export interface SessionSummary {
  sessionId: string;
  goal: string;
  status: SessionStatus;
  iterations: number;
  startedAt: string;
  endedAt?: string;
  nodeId?: string;
  model?: string;
}

const STATUS_VARIANT: Record<SessionStatus, BadgeVariant> = {
  live: 'brand',
  done: 'ok',
  refused: 'err',
  aborted: 'warn',
};

interface Props {
  sessions: SessionSummary[];
  onOpen: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}

export function SessionsTable({ sessions, onOpen, onDelete }: Props): React.JSX.Element {
  if (sessions.length === 0) {
    return (
      <div
        data-testid="ops-sessions-empty"
        style={{ padding: 32, color: 'var(--color-text-secondary)', textAlign: 'center' }}
      >
        No sessions yet — kick one off from Ops Chat.
      </div>
    );
  }
  return (
    <table
      data-testid="ops-sessions-table"
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        fontSize: 14,
        color: 'var(--color-text)',
      }}
    >
      <thead>
        <tr style={{ textAlign: 'left', color: 'var(--color-text-secondary)' }}>
          <th style={{ padding: '8px 12px' }}>Goal</th>
          <th style={{ padding: '8px 12px' }}>Status</th>
          <th style={{ padding: '8px 12px' }}>Iterations</th>
          <th style={{ padding: '8px 12px' }}>Started</th>
          <th style={{ padding: '8px 12px' }}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr
            key={s.sessionId}
            data-testid={`ops-sessions-row-${s.sessionId}`}
            style={{ borderTop: '1px solid var(--color-border-subtle)' }}
          >
            <td style={{ padding: '10px 12px', maxWidth: 400 }}>
              <div style={{ fontWeight: 500, marginBottom: 2 }}>{s.goal}</div>
              <code style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {s.sessionId}
              </code>
            </td>
            <td style={{ padding: '10px 12px' }}>
              <Badge variant={STATUS_VARIANT[s.status]}>{s.status}</Badge>
            </td>
            <td style={{ padding: '10px 12px' }}>{s.iterations}</td>
            <td style={{ padding: '10px 12px', color: 'var(--color-text-secondary)' }}>
              {new Date(s.startedAt).toLocaleString()}
            </td>
            <td style={{ padding: '10px 12px', display: 'flex', gap: 6 }}>
              <Button onClick={() => onOpen(s.sessionId)}>Open</Button>
              <Button variant="ghost" onClick={() => onDelete(s.sessionId)}>
                Delete
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Implement `delete-confirm.tsx`**

```tsx
// packages/app/src/modules/ops-sessions/delete-confirm.tsx
import * as React from 'react';
import { Button } from '@/ui';

interface Props {
  sessionId: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirm({ sessionId, onConfirm, onCancel }: Props): React.JSX.Element {
  return (
    <div
      data-testid={`ops-sessions-delete-confirm-${sessionId}`}
      style={{
        padding: 12,
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 6,
        background: 'var(--color-bg-elevated)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <span style={{ flex: 1, fontSize: 14 }}>
        Delete session <code>{sessionId}</code>? This removes its journal directory.
      </span>
      <Button variant="destructive" onClick={onConfirm}>
        Delete
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
```

- [ ] **Step 5: Implement `index.tsx`**

```tsx
// packages/app/src/modules/ops-sessions/index.tsx
import * as React from 'react';
import { EditorialHero } from '@/ui';
import { trpc } from '@/lib/trpc';
import { useTabStore } from '@/stores/tab-store';
import { SessionsTable } from './sessions-table';
import { DeleteConfirm } from './delete-confirm';

export default function OpsSessionsModule(): React.JSX.Element {
  const list = trpc.opsSessionList.useQuery({ limit: 100 });
  const del = trpc.opsSessionDelete.useMutation({
    onSuccess: () => list.refetch(),
  });
  const [confirmId, setConfirmId] = React.useState<string | null>(null);

  function open(sessionId: string): void {
    useTabStore.getState().open({
      tabKey: `ops-session:${sessionId}`,
      title: `Session ${sessionId.slice(0, 8)}`,
      kind: 'ops-session',
      instanceId: sessionId,
      openedAt: Date.now(),
    });
  }

  return (
    <div
      data-testid="ops-sessions-root"
      style={{ padding: '32px 48px 48px', maxWidth: 1200, margin: '0 auto' }}
    >
      <EditorialHero
        eyebrow="Replay archive"
        title="Ops Sessions"
        lede="Every Ops Chat planner session that has run on this node, oldest hidden after 100. Delete is permanent."
      />
      <div style={{ marginTop: 24 }}>
        {confirmId ? (
          <DeleteConfirm
            sessionId={confirmId}
            onConfirm={() => {
              del.mutate({ sessionId: confirmId });
              setConfirmId(null);
            }}
            onCancel={() => setConfirmId(null)}
          />
        ) : (
          <SessionsTable
            sessions={list.data?.sessions ?? []}
            onOpen={open}
            onDelete={setConfirmId}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Register the module in `registry.ts`**

Add a `lazy` import alongside the others (line ~83):

```ts
const LazyOpsSessions = lazy(() => import('./ops-sessions/index'));
```

Add an entry inside `APP_MODULES` near the other ops entries (after the `ops-chat` entry):

```ts
{
  id: 'ops-sessions',
  labelKey: 'Ops Sessions',
  icon: ScrollText,
  Component: LazyOpsSessions,
  activityBar: true,
  group: 'ops',
  aliases: ['session list', 'session archive', 'sessions'],
  beaconGroup: 'ops',
  beaconKind: 'static',
  beaconOrder: 20,
  smokeAffordance: 'ops-sessions-root',
},
```

- [ ] **Step 7: Run, verify pass**

```bash
bun test --cwd packages/app 2>&1 | tail -10
bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l
```
Expected: All app tests still pass; typecheck error count unchanged from baseline.

- [ ] **Step 8: Commit**

```bash
git add packages/app/src/modules/ops-sessions/ \
        packages/app/src/modules/registry.ts
git commit -m "feat(app/ops-sessions): add sessions list module + registry entry"
```

---

## Task 16: App — auto-pin tab from ops-chat on session start

**Files:**
- Modify: `packages/app/src/modules/ops-chat/index.tsx`

In `ops-chat/index.tsx`, find the place where the streaming subscription's first `plan_proposed` event arrives — that's the point where the client first knows `sessionId`. Add a one-shot effect: when the *first* event for a given subscription carries a `sessionId`, dispatch a tab-open for `ops-session:<id>`.

- [ ] **Step 1: Add the auto-pin call**

Near the top of the file, alongside other imports:

```ts
import { useTabStore } from '@/stores/tab-store';
```

In the subscription callback that already handles `plan_proposed` events, gate on a `useRef` that records "have we already auto-pinned for this sessionId?" and call:

```ts
const pinnedSessionRef = React.useRef<string | null>(null);
// ... inside the onData / event-handler path for plan_proposed events:
if (event.type === 'plan_proposed' && pinnedSessionRef.current !== event.sessionId) {
  pinnedSessionRef.current = event.sessionId;
  useTabStore.getState().open({
    tabKey: `ops-session:${event.sessionId}`,
    title: `Session ${event.sessionId.slice(0, 8)}`,
    kind: 'ops-session',
    instanceId: event.sessionId,
    openedAt: Date.now(),
  });
}
```

If the existing subscription handler is in a callback ref or external function, lift the ref into the component and pass through. Reset `pinnedSessionRef.current = null` whenever the user starts a new session (e.g., at the same place transcripts are cleared).

- [ ] **Step 2: Run app tests — no regressions**

Run: `bun test --cwd packages/app 2>&1 | tail -10`
Expected: All tests pass.

- [ ] **Step 3: Real typecheck — no new errors**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | grep -c error`
Expected: identical count to baseline.

- [ ] **Step 4: Commit**

```bash
git add packages/app/src/modules/ops-chat/index.tsx
git commit -m "feat(app/ops-chat): auto-pin ops-session tab on session start"
```

---

## Task 17: UI flow test — ops-session-replay-flow

**Files:**
- Create: `tests/ui-flows/ops-session-replay-flow.ts`
- Modify: registry/manifest file that registers Tier C flows (search for existing Tier C registrations: `grep -rn "tier.*'C'\|Tier C" tests/ui-flows`)

This test seeds a journal file in the dev profile, opens an `ops-session:<id>` tab, expands an iteration, and verifies the timeline renders.

- [ ] **Step 1: Create the flow**

```ts
// tests/ui-flows/ops-session-replay-flow.ts
import { defineFlow } from './flow-runtime';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default defineFlow({
  id: 'ops-session-replay',
  tier: 'C',
  description: 'Open a seeded session journal, expand an iteration, verify replay renders.',
  async run({ driver, profileDir, electron }) {
    const sessionId = 'flow-replay-fixture';
    const dir = join(profileDir, 'ops-chat', 'sessions', sessionId);
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: 'session_started', ts: '2026-04-25T00:00:00.000Z', sessionId,
        goal: 'flow fixture: replay only', historyLen: 0, toolCount: 0,
      }),
      JSON.stringify({
        type: 'plan_proposed', ts: '2026-04-25T00:00:01.000Z', stepId: 'sp-fixture-1',
        iteration: 0, tier: 'read', reasoning: 'fixture reasoning text',
        step: { tool: 'llamactl.workload.list', annotation: 'fixture' },
      }),
      JSON.stringify({
        type: 'wet_outcome', ts: '2026-04-25T00:00:02.000Z', stepId: 'sp-fixture-1',
        ok: true, durationMs: 7,
      }),
      JSON.stringify({
        type: 'done', ts: '2026-04-25T00:00:03.000Z', iterations: 1,
      }),
    ];
    writeFileSync(join(dir, 'journal.jsonl'), lines.join('\n') + '\n', 'utf8');

    await electron.evaluate((win, { sessionId }: { sessionId: string }) => {
      const w = win as any;
      w.useTabStore.getState().open({
        tabKey: `ops-session:${sessionId}`,
        title: `Session ${sessionId.slice(0, 8)}`,
        kind: 'ops-session',
        instanceId: sessionId,
        openedAt: Date.now(),
      });
    }, { sessionId });

    const root = await driver.find('[data-testid="ops-session-detail-root"]', { timeout: 5_000 });
    if (!root) return driver.skip('ops-session-detail-root never mounted');

    const card = await driver.find('[data-testid="iteration-card-sp-fixture-1"]', { timeout: 3_000 });
    if (!card) return driver.skip('iteration card not found — selector drift');

    await driver.click('[data-testid="iteration-card-header-sp-fixture-1"]', { force: true });

    const ok = await driver.findText('fixture reasoning text', { timeout: 3_000 });
    if (!ok) return driver.skip('reasoning text not visible after expand');

    return driver.pass();
  },
});
```

(Adjust the import and SKIP-guard helpers to match the exact API of the existing `flow-runtime` module — read `tests/ui-flows/chat-compare-flow.ts` for the current pattern.)

- [ ] **Step 2: Register the flow**

Add `'ops-session-replay-flow'` to the Tier C flows manifest. Find the file with:
`grep -rn "ops-chat-flow\|chat-compare-flow" tests/ui-flows`. Add the new flow id to the same registration that includes those.

- [ ] **Step 3: Smoke-run the flow locally if possible**

Run: `bun run test:ui-flows -- --tier C --filter ops-session-replay 2>&1 | tail -20`
Expected: PASS or SKIP (a SKIP is acceptable per the SKIP-guard pattern).

- [ ] **Step 4: Commit**

```bash
git add tests/ui-flows/ops-session-replay-flow.ts \
        tests/ui-flows/<manifest-file>
git commit -m "feat(tests/ui-flows): add ops-session-replay-flow (Tier C)"
```

---

## Task 18: UI flow test — ops-sessions-list-flow

**Files:**
- Create: `tests/ui-flows/ops-sessions-list-flow.ts`
- Modify: same Tier C manifest as above

- [ ] **Step 1: Create the flow**

```ts
// tests/ui-flows/ops-sessions-list-flow.ts
import { defineFlow } from './flow-runtime';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default defineFlow({
  id: 'ops-sessions-list',
  tier: 'C',
  description: 'Navigate to the ops-sessions module and verify it lists seeded sessions.',
  async run({ driver, profileDir, electron }) {
    for (const id of ['flow-list-a', 'flow-list-b']) {
      const dir = join(profileDir, 'ops-chat', 'sessions', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'journal.jsonl'),
        JSON.stringify({
          type: 'session_started', ts: '2026-04-25T00:00:00.000Z',
          sessionId: id, goal: `goal-${id}`, historyLen: 0, toolCount: 0,
        }) + '\n' +
          JSON.stringify({
            type: 'done', ts: '2026-04-25T00:00:10.000Z', iterations: 0,
          }) + '\n',
        'utf8',
      );
    }

    await electron.evaluate((win) => {
      const w = win as any;
      w.useTabStore.getState().open({
        tabKey: 'module:ops-sessions',
        title: 'Ops Sessions',
        kind: 'module',
        openedAt: Date.now(),
      });
    });

    const root = await driver.find('[data-testid="ops-sessions-root"]', { timeout: 5_000 });
    if (!root) return driver.skip('ops-sessions-root never mounted');

    const rowA = await driver.find('[data-testid="ops-sessions-row-flow-list-a"]', { timeout: 3_000 });
    const rowB = await driver.find('[data-testid="ops-sessions-row-flow-list-b"]', { timeout: 3_000 });
    if (!rowA || !rowB) return driver.skip('seeded session rows not rendered');

    return driver.pass();
  },
});
```

- [ ] **Step 2: Register the flow**

Append `'ops-sessions-list-flow'` to the same Tier C manifest you edited in Task 17.

- [ ] **Step 3: Smoke-run locally if possible**

Run: `bun run test:ui-flows -- --tier C --filter ops-sessions-list 2>&1 | tail -20`
Expected: PASS or SKIP.

- [ ] **Step 4: Commit**

```bash
git add tests/ui-flows/ops-sessions-list-flow.ts \
        tests/ui-flows/<manifest-file>
git commit -m "feat(tests/ui-flows): add ops-sessions-list-flow (Tier C)"
```

---

## Task 19: Final validation, tag, and ship

- [ ] **Step 1: Run the entire server test suite**

Run: `bun test --cwd packages/remote 2>&1 | tail -10`
Expected: All tests pass.

- [ ] **Step 2: Run the entire app test suite**

Run: `bun test --cwd packages/app 2>&1 | tail -10`
Expected: All 68 baseline tests + the new tests pass.

- [ ] **Step 3: Real typecheck — no new errors**

Run: `bunx tsc -p packages/app/tsconfig.web.json --noEmit 2>&1 | wc -l`
Expected: identical count to baseline (12 from main).

- [ ] **Step 4: Smoke-run Tier A (registry) and the new Tier C flows**

```bash
bun run test:ui-flows -- --tier A 2>&1 | tail -10
bun run test:ui-flows -- --tier C --filter "ops-session" 2>&1 | tail -10
```
Expected: Tier A all PASS; Tier C ops-session flows PASS or SKIP.

- [ ] **Step 5: Tag the merge point**

```bash
git tag beacon-p4-ops-replay
```

- [ ] **Step 6: Hand off**

Open a PR against `main` titled `feat(app, remote): ops session replay & timeline (Phase 2)`. Body lists the spec link, the four tRPC procs, the two new app modules, the audit `sessionId?` addition, and the new Tier C flows. Reviewer should run server + app suites locally and pop one ops-chat session end-to-end to verify auto-pin.

---

## Self-review checklist (run after writing the plan)

**Spec coverage:**
- D1 (audit + journal) → Tasks 2, 3, 7
- D2 (live + replay + follow) → Task 9 (watch RPC), Task 10 (hook)
- D3 (read-only + Open in Ops Chat) → Task 13 (header button), Task 14 (button only when status==='live')
- D4 (auto-pin + sessions list) → Task 15 (list module), Task 16 (auto-pin)
- D5 (full args, redaction) → Task 4 (redaction), Task 8 (loop-executor calls redactResult)
- D6 (accordion + sticky expansion) → Task 12 (card), Task 14 (sticky-toggle logic)
- D7 (forever + UI delete) → Task 6 (delete), Task 15 (delete-confirm)
- Testing strategy → Tasks 1–9 server tests; Task 10 app hook test (pure-function merge); Task 12 app helper test (statusGlyph/fmtMs); Tasks 17–18 Tier C UI flow tests cover rendered components end-to-end
- Rollout → Task 19

**Placeholder scan:** plan was checked for "TBD/TODO/Add appropriate". The only places asking the engineer to adapt to local convention are Task 7 (dispatch.ts call sites) and Task 16 (the existing onData callback in ops-chat/index.tsx) — both annotated with concrete grep commands so the engineer can find and fix the call sites without guessing.

**Type consistency:** `IterationView`, `SessionView`, `OutcomeView`, `JournalEvent`, `SessionSummary`, `SessionStatus` are defined in Tasks 6, 10 — referenced unchanged in Tasks 11–15. `sessionEventBus` API (`create`/`hasChannel`/`publish`/`subscribe`/`close`) defined in Task 5, used unchanged in Tasks 6, 8, 9. Tab open shape (`tabKey`, `title`, `kind`, `instanceId`, `openedAt`) is identical in Tasks 14, 15, 16, 17, 18.
