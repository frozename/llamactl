// packages/app/test/lib/global-search/surfaces/sessions-rag.test.ts
import { describe, expect, test } from 'bun:test';
import { mapSessionRagHits, type SessionRagServerHit } from '../../../../src/lib/global-search/surfaces/sessions-rag';

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