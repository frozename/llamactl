import * as React from 'react';
import { cx } from './classes';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Surface tier: 1 (default) or 2 for an elevated variant. */
  tier?: 1 | 2;
  /** Render a subtle border (default: true). */
  bordered?: boolean;
}

export function Card({ tier = 1, bordered = true, className, style, children, ...rest }: CardProps): React.JSX.Element {
  const bg = tier === 2 ? 'var(--color-surface-2)' : 'var(--color-surface-1)';
  return (
    <div
      {...rest}
      className={cx('bcn-card', `bcn-card--tier${tier}`, className)}
      style={{
        background: bg,
        border: bordered ? '1px solid var(--color-border-subtle)' : 'none',
        borderRadius: 'var(--r-xl)',
        padding: 28,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Panel shares Card's prop shape — exported as a distinct alias so
 *  consumers can type against Panel specifically. */
export type PanelProps = CardProps;

/** Same visual weight as Card but meant for a larger section container
 *  without the 28 px internal padding. Caller controls layout. */
export function Panel({ tier = 1, bordered = true, className, style, children, ...rest }: CardProps): React.JSX.Element {
  const bg = tier === 2 ? 'var(--color-surface-2)' : 'var(--color-surface-1)';
  return (
    <div
      {...rest}
      className={cx('bcn-panel', `bcn-panel--tier${tier}`, className)}
      style={{
        background: bg,
        border: bordered ? '1px solid var(--color-border-subtle)' : 'none',
        borderRadius: 'var(--r-xl)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
