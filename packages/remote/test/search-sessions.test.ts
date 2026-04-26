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
