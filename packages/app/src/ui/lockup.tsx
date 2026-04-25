import * as React from 'react';
import { cx } from './classes';

export interface LockupProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Optional — default 14 px wordmark. */
  size?: 'sm' | 'md';
}

/**
 * The Beacon lockup: lowercase wordmark + brand orb with glow. The
 * orb always renders in brand; the wordmark in the current text color
 * so it reads against every theme surface.
 */
export function Lockup({ size = 'md', className, style, ...rest }: LockupProps): React.JSX.Element {
  const fontSize = size === 'sm' ? 12 : 14;
  const orbSize = size === 'sm' ? 7 : 8;
  return (
    <div
      {...rest}
      className={cx('bcn-lockup', className)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: 'var(--font-sans)',
        fontWeight: 600,
        fontSize,
        letterSpacing: '-0.01em',
        color: 'var(--color-text)',
        userSelect: 'none',
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: orbSize,
          height: orbSize,
          borderRadius: '50%',
          background: 'var(--color-brand)',
          boxShadow: `0 0 ${orbSize + 2}px var(--color-brand)`,
          flexShrink: 0,
        }}
      />
      <span>llamactl</span>
    </div>
  );
}
