import * as React from 'react';

interface Props {
  value?: unknown;
  redacted?: 'omitted' | 'truncated';
}

export function ResultViewer({ value, redacted }: Props): React.JSX.Element {
  if (redacted === 'omitted') {
    return (
      <div
        data-testid="result-omitted"
        style={{
          padding: '8px 12px',
          fontSize: 13,
          color: 'var(--color-text-secondary)',
          fontStyle: 'italic',
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 6,
        }}
      >
        Result redacted (omitted by per-tool rule).
      </div>
    );
  }
  return (
    <div data-testid="result-viewer">
      {redacted === 'truncated' && (
        <div
          style={{
            padding: '4px 8px',
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            background: 'var(--color-bg-elevated)',
            borderTopLeftRadius: 6,
            borderTopRightRadius: 6,
          }}
        >
          Result truncated — showing the first 4 KB.
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: 12,
          fontSize: 12,
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-text)',
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: redacted === 'truncated' ? '0 0 6px 6px' : 6,
          overflow: 'auto',
          maxHeight: 320,
        }}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}