import * as React from 'react';
import { Badge } from '../../../ui';
import type { IterationView, OutcomeView } from '../../../lib/use-ops-session';
import { ResultViewer } from './result-viewer';

interface Props {
  it: IterationView;
  expanded: boolean;
  onToggle: () => void;
}

export function statusGlyph(it: IterationView): string {
  const last = it.wet ?? it.preview;
  if (!last) return '·';
  return last.ok ? '✓' : '✗';
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function OutcomeBlock({ label, outcome }: { label: string; outcome: OutcomeView }): React.JSX.Element {
  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--color-text-secondary)',
          marginBottom: 6,
        }}
      >
        {label} — {outcome.ok ? 'ok' : 'failed'} · {fmtMs(outcome.durationMs)}
      </div>
      {outcome.error && (
        <div
          style={{
            padding: 8,
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-error, #d4554d)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 6,
            marginBottom: 8,
            fontSize: 13,
          }}
        >
          <code>{outcome.error.code}</code>: {outcome.error.message}
        </div>
      )}
      {outcome.result !== undefined || outcome.resultRedacted ? (
        <ResultViewer value={outcome.result} redacted={outcome.resultRedacted} />
      ) : null}
    </div>
  );
}

export function IterationCard({ it, expanded, onToggle }: Props): React.JSX.Element {
  return (
    <div
      data-testid={`iteration-card-${it.stepId}`}
      style={{
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 8,
        background: 'var(--color-bg-surface)',
        overflow: 'hidden',
      }}
    >
      <button
        data-testid={`iteration-card-header-${it.stepId}`}
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--color-text)',
          font: 'inherit',
          textAlign: 'left',
        }}
      >
        <span
          data-testid={`iteration-status-${it.stepId}`}
          style={{ fontWeight: 600, width: 16 }}
        >
          {statusGlyph(it)}
        </span>
        <span style={{ color: 'var(--color-text-secondary)' }}>#{it.iteration + 1}</span>
        <code style={{ flex: 1, fontFamily: 'var(--font-mono)' }}>{it.tool}</code>
        <Badge variant={it.tier === 'mutation-destructive' ? 'err' : 'default'}>
          {it.tier}
        </Badge>
        {(it.wet ?? it.preview) && (
          <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
            {fmtMs((it.wet ?? it.preview)!.durationMs)}
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            padding: '0 16px 16px',
            borderTop: '1px solid var(--color-border-subtle)',
          }}
        >
          {it.reasoning && (
            <div style={{ marginTop: 12, color: 'var(--color-text-secondary)', fontSize: 14, fontStyle: 'italic' }}>
              {it.reasoning}
            </div>
          )}
          <div style={{ marginTop: 16 }}>
            <div
              style={{
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--color-text-secondary)',
                marginBottom: 6,
              }}
            >
              Args
            </div>
            <ResultViewer value={it.args} />
          </div>
          {it.preview && <OutcomeBlock label="Preview (dry)" outcome={it.preview} />}
          {it.wet && <OutcomeBlock label="Wet run" outcome={it.wet} />}
        </div>
      )}
    </div>
  );
}