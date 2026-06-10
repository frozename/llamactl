import * as React from "react";

import { buttonClasses, type ButtonSize, type ButtonVariant } from "./button-classes";
import { cx } from "./classes";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
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
      disabled={loading ? true : disabled}
      className={cx(buttonClasses(variant, size), className)}
    >
      {leadingIcon && <span className="bcn-btn__icon">{leadingIcon}</span>}
      <span>{children}</span>
      {trailingIcon && <span className="bcn-btn__icon">{trailingIcon}</span>}
    </button>
  );
}
