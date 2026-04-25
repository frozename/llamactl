import * as React from 'react';
import { cx } from './classes';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  loading?: boolean;
}

const VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'ghost', 'outline', 'destructive'];
const SIZES: readonly ButtonSize[] = ['sm', 'md', 'lg'];

/** Pure — exported so the variant mapping is unit-testable without
 *  mounting React. Visual styling lives in tokens.css under
 *  .bcn-btn / .bcn-btn--{variant} / .bcn-btn--{size}. */
export function buttonClasses(variant: ButtonVariant, size: ButtonSize): string {
  const v = VARIANTS.includes(variant) ? variant : 'primary';
  const s = SIZES.includes(size) ? size : 'md';
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
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(buttonClasses(variant, size), className)}
    >
      {leadingIcon && <span className="bcn-btn__icon">{leadingIcon}</span>}
      <span>{children}</span>
      {trailingIcon && <span className="bcn-btn__icon">{trailingIcon}</span>}
    </button>
  );
}
