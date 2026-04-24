import * as React from 'react';

interface TokensPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 380 px slide-in inspector showing live values for every Beacon CSS
 * custom property. Grouped (Brand / Surface / Border / Text / Status).
 * Click a row to copy the computed value to the clipboard.
 */
export function TokensPanel({ open, onClose }: TokensPanelProps): React.JSX.Element {
  const sections = React.useMemo(() => SECTIONS, []);
  const root = typeof document !== 'undefined' ? document.documentElement : null;

  const read = (name: string): string => {
    if (!root) return '';
    return window.getComputedStyle(root).getPropertyValue(name).trim();
  };

  return (
    <div
      role="dialog"
      aria-label="Tokens"
      style={{
        position: 'fixed',
        top: 44,
        bottom: 26,
        right: 0,
        width: 380,
        maxWidth: '100%',
        background: 'var(--color-surface-1)',
        borderLeft: '1px solid var(--color-border-subtle)',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 260ms cubic-bezier(.4,0,.2,1)',
        zIndex: 30,
        overflowY: 'auto',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div
        style={{
          position: 'sticky',
          top: 0,
          padding: '16px 20px',
          background: 'var(--color-surface-1)',
          borderBottom: '1px solid var(--color-border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <h3 style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: '0.12em', textTransform: 'uppercase' }}>Tokens</h3>
        <button
          type="button"
          onClick={onClose}
          style={{ all: 'unset', cursor: 'pointer', padding: '4px 8px', color: 'var(--color-text-tertiary)' }}
        >
          ×
        </button>
      </div>
      <div style={{ padding: '12px 4px 32px' }}>
        {sections.map((section) => (
          <section key={section.label} style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border-subtle)' }}>
            <h4 style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', margin: '0 0 10px', fontWeight: 500 }}>
              {section.label}
            </h4>
            {section.tokens.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => navigator.clipboard.writeText(read(name))}
                title={`Copy ${name}`}
                style={{
                  all: 'unset',
                  display: 'grid',
                  gridTemplateColumns: '20px 1fr auto',
                  gap: 10,
                  padding: '6px 0',
                  alignItems: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  width: '100%',
                  cursor: 'copy',
                }}
              >
                <span style={{ width: 16, height: 16, borderRadius: 3, background: `var(${name})`, border: '1px solid var(--color-border-subtle)' }} />
                <span style={{ color: 'var(--color-text-secondary)' }}>{name}</span>
                <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>{read(name)}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

const SECTIONS = [
  { label: 'Brand', tokens: ['--color-brand', '--color-brand-subtle', '--color-brand-muted', '--color-brand-ghost', '--color-brand-contrast'] },
  { label: 'Surface', tokens: ['--color-surface-0', '--color-surface-1', '--color-surface-2', '--color-surface-3', '--color-surface-4'] },
  { label: 'Border', tokens: ['--color-border', '--color-border-subtle', '--color-border-strong', '--color-border-focus'] },
  { label: 'Text', tokens: ['--color-text', '--color-text-secondary', '--color-text-tertiary', '--color-text-ghost', '--color-text-inverse'] },
  { label: 'Status', tokens: ['--color-ok', '--color-warn', '--color-err', '--color-info'] },
];
