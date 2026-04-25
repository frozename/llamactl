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
