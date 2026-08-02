import type { ChangeEvent, ReactNode } from "react";
import type { StatusTone } from "./StatusBadge";
import { mergeClassNames } from "./classNames";

export interface HostSelectorOption {
  id: string;
  label: string;
  description?: string;
  statusTone?: StatusTone;
  icon?: ReactNode;
}

export interface HostSelectorProps {
  options: readonly HostSelectorOption[];
  value?: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  placeholder: string;
  latency?: ReactNode;
  latencyLabel?: string;
  statusTone?: StatusTone;
  disabled?: boolean;
  compact?: boolean;
  className?: string;
  name?: string;
}

export function HostSelector({
  options,
  value,
  onValueChange,
  ariaLabel,
  placeholder,
  latency,
  latencyLabel,
  statusTone,
  disabled = false,
  compact = false,
  className,
  name
}: HostSelectorProps) {
  const selected = options.find((option) => option.id === value);
  const effectiveTone = statusTone ?? selected?.statusTone ?? "neutral";

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    onValueChange(event.currentTarget.value);
  }

  return (
    <div
      className={mergeClassNames("ch-host-selector", className)}
      data-compact={compact || undefined}
      data-disabled={disabled || undefined}
      data-tone={effectiveTone}
    >
      <span className="ch-host-selector__summary" aria-hidden="true">
        <span className="ch-host-selector__status" />
        {selected?.icon ? <span className="ch-host-selector__icon">{selected.icon}</span> : null}
        <span className="ch-host-selector__text">
          <strong>{selected?.label ?? placeholder}</strong>
          {selected?.description ? <small>{selected.description}</small> : null}
        </span>
        {latency ? (
          <span className="ch-host-selector__latency" aria-label={latencyLabel}>
            <span className="ch-host-selector__latency-dot" />
            {latency}
          </span>
        ) : null}
        <span className="ch-host-selector__chevron">⌄</span>
      </span>
      <select
        className="ch-host-selector__native"
        name={name}
        value={value ?? ""}
        onChange={handleChange}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        {!selected ? <option value="" disabled>{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.description ? `${option.label} — ${option.description}` : option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
