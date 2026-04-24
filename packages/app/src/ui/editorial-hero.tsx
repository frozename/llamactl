import * as React from 'react';
import { cx } from './classes';
import { AtmosphericPanel } from './atmospheric-panel';

export interface EditorialHeroProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** Secondary emphasis span inside the title (renders in brand). Pass
   *  plain text or a <em> — this component wraps it. */
  titleAccent?: React.ReactNode;
  lede?: React.ReactNode;
  pills?: readonly { label: React.ReactNode; tone?: 'default' | 'ok' | 'info' }[];
  actions?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Hero block with serif display title, atmospheric backdrop, and an
 * optional pill row. Used on Dashboard landing, module empty states,
 * Settings section heads, About page. Never inside dense data views.
 */
export function EditorialHero({
  eyebrow,
  title,
  titleAccent,
  lede,
  pills,
  actions,
  className,
  style,
}: EditorialHeroProps): React.JSX.Element {
  return (
    <AtmosphericPanel className={cx('bcn-editorial-hero', className)} style={style}>
      {eyebrow && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--color-text-tertiary)',
            marginBottom: 20,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--color-brand)',
              boxShadow: '0 0 8px var(--color-brand)',
            }}
          />
          {eyebrow}
        </div>
      )}
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 300,
          fontSize: 'clamp(48px, 7vw, 96px)',
          letterSpacing: '-0.03em',
          lineHeight: 0.98,
          margin: '0 0 20px',
          color: 'var(--color-text)',
        }}
      >
        {title}
        {titleAccent && (
          <>
            {' '}
            <em className="t-brand" style={{ color: 'var(--color-brand)', fontWeight: 400, fontStyle: 'normal' }}>{titleAccent}</em>
          </>
        )}
      </h1>
      {lede && (
        <p
          style={{
            fontSize: 19,
            lineHeight: 1.55,
            color: 'var(--color-text-secondary)',
            maxWidth: '62ch',
            margin: '0 0 24px',
            fontWeight: 300,
          }}
        >
          {lede}
        </p>
      )}
      {pills && pills.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: actions ? 24 : 0 }}>
          {pills.map((p, i) => (
            <span
              key={i}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 'var(--r-pill)',
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-border-subtle)',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--color-text-secondary)',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background:
                    p.tone === 'ok' ? 'var(--color-ok)' :
                    p.tone === 'info' ? 'var(--color-info)' :
                    'var(--color-text-tertiary)',
                  boxShadow:
                    p.tone === 'ok' ? '0 0 6px var(--color-ok)' :
                    p.tone === 'info' ? '0 0 6px var(--color-info)' :
                    'none',
                }}
              />
              {p.label}
            </span>
          ))}
        </div>
      )}
      {actions && <div>{actions}</div>}
    </AtmosphericPanel>
  );
}
