import * as React from 'react';
import { cx } from './classes';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  loading?: boolean;
}

/** Pure — exported so the variant mapping is unit-testable without
 *  mounting React. */
export function buttonClasses(variant: ButtonVariant, size: ButtonSize): string {
  const v: ButtonVariant = ['primary', 'secondary', 'ghost', 'outline'].includes(variant)
    ? variant
    : 'primary';
  const s: ButtonSize = ['sm', 'md', 'lg'].includes(size) ? size : 'md';
  return cx('bcn-btn', `bcn-btn--${v}`, `bcn-btn--${s}`);
}

export function Button({
  variant = 'primary',
  size = 'md',
  leadingIcon,
  trailingIcon,
  loading = false,
  disabled,
  className,
  children,
  style,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(buttonClasses(variant, size), className)}
      style={{ ...BASE_STYLE, ...VARIANT_STYLE[variant], ...SIZE_STYLE[size], ...style }}
    >
      {leadingIcon && <span className="bcn-btn__icon">{leadingIcon}</span>}
      <span>{children}</span>
      {trailingIcon && <span className="bcn-btn__icon">{trailingIcon}</span>}
    </button>
  );
}

const BASE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  borderRadius: 'var(--r-lg)',
  transition: 'background 160ms, border-color 160ms, box-shadow 160ms',
  border: '1px solid transparent',
  fontFamily: 'var(--font-sans)',
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

const VARIANT_STYLE: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    background: 'var(--color-brand)',
    color: 'var(--color-brand-contrast)',
  },
  secondary: {
    background: 'var(--color-surface-3)',
    color: 'var(--color-text)',
    borderColor: 'var(--color-border)',
  },
  ghost: { background: 'transparent', color: 'var(--color-text-secondary)' },
  outline: {
    background: 'transparent',
    color: 'var(--color-text)',
    borderColor: 'var(--color-border-strong)',
  },
};

const SIZE_STYLE: Record<ButtonSize, React.CSSProperties> = {
  sm: { padding: '5px 10px', fontSize: 12 },
  md: { padding: '8px 14px', fontSize: 13 },
  lg: { padding: '10px 18px', fontSize: 14 },
};
