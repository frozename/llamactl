// packages/app/src/lib/global-search/surfaces/logs.ts
import type { Hit } from '../types';

export interface LogServerHit {
  fileLabel: string;
  filePath: string;
  matches: { lineNumber: number; where: string; snippet: string; spans: { start: number; end: number }[] }[];
  score: number;
}

export function mapLogHits(hits: LogServerHit[]): Hit[] {
  const out: Hit[] = [];
  for (const h of hits) {
    for (const m of h.matches) {
      out.push({
        surface: 'logs',
        parentId: `${h.fileLabel}:${m.lineNumber}`,
        parentTitle: `${h.fileLabel}:${m.lineNumber}`,
        originNode: (h as { originNode?: string }).originNode,
        score: h.score,
        matchKind: 'exact',
        match: { where: m.where, snippet: m.snippet, spans: m.spans },
        action: {
          kind: 'open-tab',
          tab: {
            tabKey: 'module:logs',
            title: 'Logs',
            kind: 'module',
            openedAt: Date.now(),
          },
        },
      });
    }
  }
  return out;
}