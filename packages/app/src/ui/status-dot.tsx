import * as React from 'react';
import { cx } from './classes';

export type StatusDotTone = 'ok' | 'warn' | 'err' | 'idle' | 'info';

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: StatusDotTone;
  pulse?: boolean;
  label?: React.ReactNode;
}

const COLOR: Record<StatusDotTone, string> = {
  ok: 'var(--color-ok)',
  warn: 'var(--color-warn)',
  err: 'var(--color-err)',
  idle: 'var(--color-text-ghost)',
  info: 'var(--color-info)',
};

export function StatusDot({
  tone = 'ok',
  pulse = false,
  label,
  className,
  style,
  ...rest
}: StatusDotProps): React.JSX.Element {
  const color = COLOR[tone];
  const glow = tone === 'idle' ? 'none' : `0 0 8px ${color}`;
  return (
    <span
      {...rest}
      className={cx('bcn-status-dot', className)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
        color: 'var(--color-text-secondary)',
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          boxShadow: glow,
          flexShrink: 0,
          animation: pulse ? 'bcn-pulse 2s ease-in-out infinite' : undefined,
        }}
      />
      {label && <span>{label}</span>}
    </span>
  );
}
