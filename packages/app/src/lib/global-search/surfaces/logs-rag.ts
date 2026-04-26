// packages/app/src/lib/global-search/surfaces/logs-rag.ts
import type { Hit } from '../types';

export interface LogRagServerHit {
  fileLabel: string;
  filePath: string;
  matches: { lineNumber: number; where: string; snippet: string; spans: { start: number; end: number }[] }[];
  score: number;
  ragDistance?: number;
}

export function mapLogRagHits(hits: LogRagServerHit[]): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    for (const m of h.matches) {
      out.push({
        surface: 'logs',
        parentId: `${h.fileLabel}:${m.lineNumber}`,
        parentTitle: `${h.fileLabel}:${m.lineNumber}`,
        score: h.score,
        matchKind: 'semantic',
        ragDistance: h.ragDistance,
        match: { where: m.where, snippet: m.snippet, spans: m.spans },
        action: {
          kind: 'open-tab',
          tab: { tabKey: 'module:logs', title: 'Logs', kind: 'module', openedAt: Date.now() },
        },
      });
    }
  }
  return out;
}