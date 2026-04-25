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