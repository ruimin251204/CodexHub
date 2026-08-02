import type { HTMLAttributes, ReactNode } from "react";
import { mergeClassNames } from "./classNames";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      {...props}
      className={mergeClassNames("ch-empty-state", className)}
      data-compact={compact || undefined}
    >
      {icon ? <div className="ch-empty-state__icon" aria-hidden="true">{icon}</div> : null}
      <strong className="ch-empty-state__title">{title}</strong>
      {description ? <p className="ch-empty-state__description">{description}</p> : null}
      {action ? <div className="ch-empty-state__action">{action}</div> : null}
    </div>
  );
}
