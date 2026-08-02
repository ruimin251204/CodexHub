import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { mergeClassNames } from "./classNames";

export type ActionButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ActionButtonSize = "sm" | "md" | "lg";

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ActionButtonVariant;
  size?: ActionButtonSize;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  fullWidth?: boolean;
}

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton({
  variant = "secondary",
  size = "md",
  icon,
  trailingIcon,
  loading = false,
  loadingLabel,
  fullWidth = false,
  className,
  children,
  disabled,
  type = "button",
  ...props
}, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={mergeClassNames("ch-action-button", className)}
      data-variant={variant}
      data-size={size}
      data-full-width={fullWidth || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
    >
      {loading ? <span className="ch-action-button__spinner" aria-hidden="true" /> : null}
      {!loading && icon ? <span className="ch-action-button__icon" aria-hidden="true">{icon}</span> : null}
      <span className="ch-action-button__label">{loading && loadingLabel ? loadingLabel : children}</span>
      {!loading && trailingIcon ? <span className="ch-action-button__icon" aria-hidden="true">{trailingIcon}</span> : null}
    </button>
  );
});
