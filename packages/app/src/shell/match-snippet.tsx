// packages/app/src/shell/match-snippet.tsx
import * as React from 'react';
import type { MatchExcerpt } from '../lib/global-search/types';

interface Props {
  match: MatchExcerpt;
}

export function MatchSnippet({ match }: Props): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < match.spans.length; i++) {
    const sp = match.spans[i]!;
    if (sp.start > cursor) parts.push(match.snippet.slice(cursor, sp.start));
    parts.push(
      <strong key={i} style={{ color: 'var(--color-brand)' }}>
        {match.snippet.slice(sp.start, sp.end)}
      </strong>,
    );
    cursor = sp.end;
  }
  if (cursor < match.snippet.length) parts.push(match.snippet.slice(cursor));
  return (
    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
      {parts.map((p, i) => (
        <React.Fragment key={i}>{p}</React.Fragment>
      ))}
    </div>
  );
}