import * as React from 'react';
import { cx } from './classes';
import { THEMES, type ThemeId } from '@/themes';

export interface ThemeOrbsProps extends React.HTMLAttributes<HTMLDivElement> {
  activeId: ThemeId;
  onPick: (id: ThemeId) => void;
}

/** Four-dot theme picker — the title-bar control. Pure presentation;
 *  orchestration (persisting, hovering for live-preview) belongs to
 *  the caller. */
export function ThemeOrbs({ activeId, onPick, className, style, ...rest }: ThemeOrbsProps): React.JSX.Element {
  return (
    <div
      role="tablist"
      {...rest}
      className={cx('bcn-theme-orbs', className)}
      style={{
        display: 'flex',
        gap: 2,
        padding: 3,
        background: 'var(--color-surface-2)',
        borderRadius: 'var(--r-pill)',
        border: '1px solid var(--color-border-subtle)',
        ...style,
      }}
    >
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === activeId}
          onClick={() => onPick(t.id)}
          title={`${t.label} — ${t.tagline}`}
          style={{
            all: 'unset',
            width: 16,
            height: 16,
            borderRadius: '50%',
            cursor: 'pointer',
            position: 'relative',
            transition: 'transform 160ms',
            background: orbBackground(t.id),
            boxShadow: t.id === 'clinical' ? 'inset 0 0 0 1.5px #faf9f7' : undefined,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.15)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; }}
        >
          {t.id === activeId && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                inset: -3,
                borderRadius: '50%',
                border: '1.5px solid var(--color-text)',
              }}
            />
          )}
        </button>
      ))}
    </div>
  );
}

function orbBackground(id: ThemeId): string {
  switch (id) {
    case 'sirius':   return '#6366f1';
    case 'ember':    return '#f59e0b';
    case 'clinical': return '#2563eb';
    case 'scrubs':   return '#14b8a6';
  }
}
