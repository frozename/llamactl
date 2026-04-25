import './setup.ts';
import { describe, expect, test } from 'bun:test';

import {
  mergeEventIntoView,
  initialView,
  type JournalEvent,
} from '../src/lib/use-ops-session';

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
