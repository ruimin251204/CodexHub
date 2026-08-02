import type { FormEvent, InputHTMLAttributes, ReactNode } from "react";
import { mergeClassNames } from "./classNames";

export interface SearchBoxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "size" | "value"> {
  value: string;
  onValueChange: (value: string) => void;
  onSubmitValue?: (value: string) => void;
  icon?: ReactNode;
  shortcutLabel?: string;
  clearLabel?: string;
  onClear?: () => void;
  containerClassName?: string;
}

export function SearchBox({
  value,
  onValueChange,
  onSubmitValue,
  icon,
  shortcutLabel,
  clearLabel,
  onClear,
  containerClassName,
  className,
  disabled,
  ...inputProps
}: SearchBoxProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmitValue?.(value);
  }

  return (
    <form
      className={mergeClassNames("ch-search-box", containerClassName)}
      role="search"
      onSubmit={handleSubmit}
      data-disabled={disabled || undefined}
    >
      <span className="ch-search-box__icon" aria-hidden="true">{icon ?? "⌕"}</span>
      <input
        {...inputProps}
        className={mergeClassNames("ch-search-box__input", className)}
        type="search"
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.currentTarget.value)}
      />
      {value && clearLabel ? (
        <button
          className="ch-search-box__clear"
          type="button"
          aria-label={clearLabel}
          disabled={disabled}
          onClick={() => {
            onValueChange("");
            onClear?.();
          }}
        >
          ×
        </button>
      ) : shortcutLabel ? (
        <kbd className="ch-search-box__shortcut">{shortcutLabel}</kbd>
      ) : null}
    </form>
  );
}
