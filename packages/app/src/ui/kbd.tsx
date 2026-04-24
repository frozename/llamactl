import * as React from 'react';
import { cx } from './classes';

export interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  /** Render compact (18×18 instead of 22×22). Used inside input hints. */
  compact?: boolean;
}

export function Kbd({ compact, className, style, children, ...rest }: KbdProps): React.JSX.Element {
  const size = compact ? { minWidth: 18, height: 18, fontSize: 10, padding: '0 5px' } : {};
  return (
    <kbd
      {...rest}
      className={cx('bcn-kbd', className)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 22,
        height: 22,
        padding: '0 6px',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        color: 'var(--color-text-secondary)',
        background: 'var(--color-surface-2)',
        border: '1px solid var(--color-border)',
        borderBottomWidth: 2,
        borderRadius: 'var(--r-sm)',
        lineHeight: 1,
        ...size,
        ...style,
      }}
    >
      {children}
    </kbd>
  );
}
