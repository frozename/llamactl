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