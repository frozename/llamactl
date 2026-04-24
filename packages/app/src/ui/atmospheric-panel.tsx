import * as React from 'react';
import { cx } from './classes';

export interface AtmosphericPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Blob palette — `brand`/`amber` matches Beacon's hero aesthetic. */
  palette?: 'brand' | 'amber' | 'brand-amber';
}

/**
 * Gradient surface-1 background with two blurred blobs — used for
 * editorial hero containers (Dashboard landing, empty states, etc.).
 * Blobs are absolutely positioned inside the rounded frame; caller's
 * content renders above them at z:1.
 */
export function AtmosphericPanel({
  palette = 'brand-amber',
  className,
  style,
  children,
  ...rest
}: AtmosphericPanelProps): React.JSX.Element {
  const blobA = 'var(--color-brand)';
  const blobB = palette === 'brand-amber' ? '#f59e0b' : palette === 'amber' ? '#f59e0b' : 'var(--color-brand)';
  return (
    <div
      {...rest}
      className={cx('bcn-atmospheric', className)}
      style={{
        position: 'relative',
        padding: 48,
        borderRadius: 'var(--r-xl)',
        background: 'linear-gradient(135deg, var(--color-surface-1), var(--color-surface-2))',
        border: '1px solid var(--color-border-subtle)',
        overflow: 'hidden',
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: -80,
          right: -80,
          width: 320,
          height: 320,
          borderRadius: '50%',
          background: blobA,
          opacity: 0.10,
          filter: 'blur(60px)',
        }}
      />
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          bottom: -60,
          left: -60,
          width: 200,
          height: 200,
          borderRadius: '50%',
          background: blobB,
          opacity: 0.08,
          filter: 'blur(60px)',
        }}
      />
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  );
}
