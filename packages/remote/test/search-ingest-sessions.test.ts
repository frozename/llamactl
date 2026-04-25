// packages/remote/test/search-ingest-sessions.test.ts
import { describe, expect, test } from 'bun:test';
import { sessionEventBus } from '../src/ops-chat/sessions/event-bus.js';
import { startSessionsIngest } from '../src/search/ingest/sessions.js';

describe('sessions ingest', () => {
  test('subscribes to event bus and forwards records to a sink', async () => {
    const seen: any[] = [];
    const stop = startSessionsIngest({
      sink: async (records) => { seen.push(...records); },
      flushMs: 30,
    });
    sessionEventBus.create('s-ing-1');
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
    const seen: any[] = [];
    const stop = startSessionsIngest({
      sink: async (records) => { seen.push(...records); },
      flushMs: 20,
    });
    sessionEventBus.create('s-ing-2');
    sessionEventBus.publish('s-ing-2', {
      type: 'done', ts: '2026-04-25T00:00:00.000Z', iterations: 0,
    } as any);
    await new Promise((r) => setTimeout(r, 50));
    stop();
    sessionEventBus.close('s-ing-2');
    expect(seen.length).toBe(0);
  });
});