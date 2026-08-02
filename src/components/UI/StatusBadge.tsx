import type { HTMLAttributes, ReactNode } from "react";
import { mergeClassNames } from "./classNames";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";
export type StatusBadgeSize = "sm" | "md";

export interface StatusBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  children: ReactNode;
  tone?: StatusTone;
  size?: StatusBadgeSize;
  dot?: boolean;
  icon?: ReactNode;
}

export function StatusBadge({
  children,
  tone = "neutral",
  size = "md",
  dot = false,
  icon,
  className,
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={mergeClassNames("ch-status-badge", className)}
      data-tone={tone}
      data-size={size}
      {...props}
    >
      {dot ? <span className="ch-status-badge__dot" aria-hidden="true" /> : null}
      {icon ? <span className="ch-status-badge__icon" aria-hidden="true">{icon}</span> : null}
      <span className="ch-status-badge__label">{children}</span>
    </span>
  );
}
