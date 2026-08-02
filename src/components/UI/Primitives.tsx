import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import type { StatusTone } from "./StatusBadge";
import { mergeClassNames } from "./classNames";

export function StatusDot({ tone = "neutral", label, className }: { tone?: StatusTone; label: string; className?: string }) {
  return <span className={mergeClassNames("ch-status-dot", className)} data-tone={tone} role="img" aria-label={label} />;
}

export function Chip({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={mergeClassNames("ch-chip", className)} />;
}

export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}

export function Toggle({ checked, onCheckedChange, label, className, disabled, ...props }: ToggleProps) {
  return (
    <button
      {...props}
      className={mergeClassNames("ch-toggle", className)}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="ch-toggle__thumb" />
    </button>
  );
}

export interface MetricCardProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  value: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: StatusTone;
}

export function MetricCard({ label, value, description, icon, tone = "info", className, ...props }: MetricCardProps) {
  return (
    <div {...props} className={mergeClassNames("ch-metric-card", className)} data-tone={tone}>
      <div className="ch-metric-card__copy"><span>{label}</span><strong>{value}</strong>{description ? <small>{description}</small> : null}</div>
      {icon ? <div className="ch-metric-card__icon" aria-hidden="true">{icon}</div> : null}
    </div>
  );
}
