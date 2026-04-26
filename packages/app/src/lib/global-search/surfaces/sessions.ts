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