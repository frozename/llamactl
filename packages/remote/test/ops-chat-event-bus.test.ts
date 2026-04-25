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
