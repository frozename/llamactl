// packages/app/src/lib/global-search/surfaces/knowledge.ts
import type { Hit, MatchExcerpt } from '../types';

export interface KnowledgeServerHit {
  entityId: string;
  title: string;
  matches: MatchExcerpt[];
  score: number;
}

export function mapKnowledgeHits(hits: KnowledgeServerHit[]): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    for (const m of h.matches) {
      out.push({
        surface: 'knowledge',
        parentId: h.entityId,
        parentTitle: h.title,
        score: h.score,
        matchKind: 'exact',
        match: m,
        action: {
          kind: 'open-tab',
          tab: {
            tabKey: 'module:knowledge',
            title: 'Knowledge',
            kind: 'module',
            openedAt: Date.now(),
          },
        },
      });
    }
  }
  return out;
}