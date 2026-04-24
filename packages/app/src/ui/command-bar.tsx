import * as React from 'react';
import { cx } from './classes';
import { Kbd } from './kbd';

export interface CommandBarCrumb {
  label: React.ReactNode;
  /** If true, render in full text color (active segment). */
  current?: boolean;
}

export interface CommandBarProps extends React.HTMLAttributes<HTMLButtonElement> {
  crumbs: readonly CommandBarCrumb[];
  /** Keyboard hint shown at the right edge. */
  shortcut?: React.ReactNode;
}

/**
 * Title-bar breadcrumb that behaves as a single button — clicking it
 * opens the command palette (⌘K). Orb-led, slash-separated, with a
 * kbd hint on the right. Used as the center slot of TitleBar Layout B.
 */
export function CommandBar({
  crumbs,
  shortcut = '⌘K',
  className,
  style,
  onClick,
  ...rest
}: CommandBarProps): React.JSX.Element {
  return (
    <button
      type="button"
      {...rest}
      onClick={onClick}
      className={cx('bcn-command-bar', className)}
      style={{
        all: 'unset',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 16px',
        background: 'var(--color-surface-2)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--r-lg)',
        minWidth: 360,
        maxWidth: 520,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--color-text-secondary)',
        cursor: 'text',
        transition: 'border-color 160ms',
        ...style,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-strong)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-subtle)'; }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: 'var(--color-brand)',
          boxShadow: '0 0 10px var(--color-brand)',
          flexShrink: 0,
        }}
      />
      {crumbs.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color: 'var(--color-text-ghost)' }}>/</span>}
          <span style={{ color: c.current ? 'var(--color-text)' : 'var(--color-text-secondary)' }}>
            {c.label}
          </span>
        </React.Fragment>
      ))}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
        <Kbd compact>{shortcut}</Kbd>
      </span>
    </button>
  );
}
