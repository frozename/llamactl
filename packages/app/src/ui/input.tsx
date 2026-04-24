import * as React from 'react';
import { cx } from './classes';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  leadingSlot?: React.ReactNode;
  trailingSlot?: React.ReactNode;
  invalid?: boolean;
}

/**
 * Text input with Beacon focus-ring (brand-ghost 3 px). Optional
 * leading/trailing slots render inside the frame; the real <input>
 * stretches the middle. Pass ref through for focus management.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { leadingSlot, trailingSlot, invalid, className, style, disabled, ...rest },
  ref,
) {
  const borderColor = invalid ? 'var(--color-err)' : 'var(--color-border)';
  return (
    <label
      className={cx('bcn-input', invalid && 'bcn-input--invalid', disabled && 'bcn-input--disabled', className)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '9px 12px',
        fontSize: 13,
        background: 'var(--color-surface-2)',
        color: 'var(--color-text)',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--r-lg)',
        transition: 'border-color 160ms, box-shadow 160ms, background 160ms',
        cursor: disabled ? 'not-allowed' : 'text',
        opacity: disabled ? 0.6 : 1,
        ...style,
      }}
      onFocusCapture={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-brand)';
        e.currentTarget.style.boxShadow = '0 0 0 3px var(--color-brand-ghost)';
        e.currentTarget.style.background = 'var(--color-surface-1)';
      }}
      onBlurCapture={(e) => {
        e.currentTarget.style.borderColor = borderColor;
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.background = 'var(--color-surface-2)';
      }}
    >
      {leadingSlot}
      <input
        ref={ref}
        disabled={disabled}
        {...rest}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'inherit',
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
        }}
      />
      {trailingSlot}
    </label>
  );
});
