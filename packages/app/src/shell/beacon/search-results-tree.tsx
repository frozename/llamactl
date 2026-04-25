// packages/app/src/shell/beacon/search-results-tree.tsx
import * as React from 'react';
import { TreeItem, Badge } from '../../ui';
import type { GroupedResults, Hit, SurfaceGroup, SurfaceKind } from '../../lib/global-search/types';
import { MatchSnippet } from '../match-snippet';

interface Props {
  results: GroupedResults;
  onActivate: (hit: Hit) => void;
}

const SURFACE_LABEL: Record<SurfaceKind, string> = {
  module: 'Modules',
  session: 'Ops Sessions',
  workload: 'Workloads',
  node: 'Nodes',
  knowledge: 'Knowledge',
  logs: 'Logs',
  preset: 'Presets',
  'tab-history': 'Recent tabs',
};

interface CollapsedParent {
  parentId: string;
  parentTitle: string;
  topHit: Hit;
  hits: Hit[];
}

function collapse(group: SurfaceGroup): CollapsedParent[] {
  const map = new Map<string, CollapsedParent>();
  for (const h of group.hits) {
    let p = map.get(h.parentId);
    if (!p) {
      p = { parentId: h.parentId, parentTitle: h.parentTitle, topHit: h, hits: [] };
      map.set(h.parentId, p);
    }
    p.hits.push(h);
    if (h.score > p.topHit.score) p.topHit = h;
  }
  return [...map.values()].sort((a, b) => b.topHit.score - a.topHit.score);
}

export function SearchResultsTree({ results, onActivate }: Props): React.JSX.Element {
  return (
    <div data-testid="global-search-results" role="tree">
      {results.map((g) => {
        if (g.hits.length === 0 && !g.pending && !g.error) return null;
        const parents = collapse(g);
        return (
          <div key={g.surface} style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--color-text-tertiary)',
              }}
            >
              <span>{SURFACE_LABEL[g.surface]}</span>
              <span style={{ color: 'var(--color-text-tertiary)' }}>· {g.hits.length}</span>
              {g.pending && (
                <span style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
                  loading…
                </span>
              )}
              {g.error && (
                <span style={{ color: 'var(--color-err)' }}>error: {g.error}</span>
              )}
            </div>
            {parents.map((p) => (
              <div key={p.parentId} data-testid={`search-parent-${g.surface}-${p.parentId}`}>
                <TreeItem
                  label={p.parentTitle}
                  onClick={() => onActivate(p.topHit)}
                  trailing={
                    p.hits.some((h) => h.matchKind === 'semantic') ? (
                      <Badge variant="brand">semantic</Badge>
                    ) : undefined
                  }
                />
                {p.hits.map(
                  (h, i) =>
                    h.match && (
                      <div
                        key={i}
                        style={{ padding: '0 14px 6px 28px', cursor: 'pointer' }}
                        onClick={() => onActivate(h)}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--color-text-tertiary)',
                            marginBottom: 2,
                          }}
                        >
                          {h.match.where}
                          {h.matchKind === 'semantic' && ' · semantic'}
                        </div>
                        <MatchSnippet match={h.match} />
                      </div>
                    ),
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}