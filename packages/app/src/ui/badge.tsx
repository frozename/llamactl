import * as React from 'react';
import { cx } from './classes';

export type BadgeVariant = 'default' | 'brand' | 'ok' | 'warn' | 'err';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const VARIANT_STYLE: Record<BadgeVariant, React.CSSProperties> = {
  default: { background: 'var(--color-surface-3)', color: 'var(--color-text-secondary)' },
  brand:   { background: 'var(--color-brand-muted)', color: 'var(--color-brand)' },
  ok:      { background: 'rgba(52,211,153,0.15)', color: 'var(--color-ok)' },
  warn:    { background: 'rgba(251,191,36,0.15)', color: 'var(--color-warn)' },
  err:     { background: 'rgba(248,113,113,0.15)', color: 'var(--color-err)' },
};

const BASE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 8px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  borderRadius: 'var(--r-sm)',
  letterSpacing: '0.04em',
};

export function Badge({
  variant = 'default',
  className,
  style,
  children,
  ...rest
}: BadgeProps): React.JSX.Element {
  return (
    <span
      {...rest}
      className={cx('bcn-badge', `bcn-badge--${variant}`, className)}
      style={{ ...BASE, ...VARIANT_STYLE[variant], ...style }}
    >
      {children}
    </span>
  );
}
