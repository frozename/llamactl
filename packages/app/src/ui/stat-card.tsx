import * as React from 'react';
import { cx } from './classes';

export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  unit?: string;
  delta?: { text: string; direction?: 'up' | 'down' | 'flat' };
  sparkline?: readonly number[];
}

/**
 * Scales a sample series into bar heights for the 32 px sparkline.
 * Max value → full height; min value → floor of 2 px so zero samples
 * are still visible. Exported for unit testing.
 */
export function sparklineHeights(samples: readonly number[], maxHeight: number): number[] {
  if (samples.length === 0) return [];
  const max = Math.max(...samples);
  if (max === 0) return samples.map(() => Math.min(2, maxHeight));
  return samples.map((s) => {
    const raw = (s / max) * maxHeight;
    return Math.max(2, Math.round(raw));
  });
}

export function StatCard({
  label,
  value,
  unit,
  delta,
  sparkline,
  className,
  style,
  ...rest
}: StatCardProps): React.JSX.Element {
  const deltaColor =
    delta?.direction === 'up' ? 'var(--color-ok)' :
    delta?.direction === 'down' ? 'var(--color-err)' :
    'var(--color-text-secondary)';

  const heights = sparkline ? sparklineHeights(sparkline, 32) : undefined;

  return (
    <div
      {...rest}
      className={cx('bcn-stat-card', className)}
      style={{
        padding: 20,
        background: 'var(--color-surface-1)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--r-lg)',
        ...style,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--color-text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 36,
          fontWeight: 600,
          lineHeight: 1,
          letterSpacing: '-0.02em',
          marginBottom: 6,
          color: 'var(--color-text)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
        {unit && (
          <span
            style={{
              color: 'var(--color-brand)',
              fontSize: 20,
              fontWeight: 400,
              verticalAlign: 'top',
              marginLeft: 2,
            }}
          >
            {unit}
          </span>
        )}
      </div>
      {delta && (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: deltaColor }}>
          {delta.text}
        </div>
      )}
      {heights && (
        <div style={{ height: 32, marginTop: 10, display: 'flex', alignItems: 'flex-end', gap: 2 }}>
          {heights.map((h, i) => (
            <div
              key={i}
              aria-hidden="true"
              style={{
                flex: 1,
                height: h,
                background: 'var(--color-brand)',
                opacity: 0.6,
                borderRadius: 1,
                transition: 'opacity 200ms',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
