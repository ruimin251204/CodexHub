import { useId, useRef } from "react";
import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { mergeClassNames } from "./classNames";

export type TabsVariant = "underline" | "segmented";

export interface TabItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  panelId?: string;
}

export interface TabsProps {
  items: readonly TabItem[];
  activeId: string;
  onActiveIdChange: (id: string) => void;
  ariaLabel: string;
  variant?: TabsVariant;
  className?: string;
}

export function Tabs({
  items,
  activeId,
  onActiveIdChange,
  ariaLabel,
  variant = "underline",
  className
}: TabsProps) {
  const generatedId = useId();
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, currentId: string) {
    const enabledItems = items.filter((item) => !item.disabled);
    const currentIndex = enabledItems.findIndex((item) => item.id === currentId);
    if (currentIndex < 0) {
      return;
    }

    let targetIndex: number | undefined;
    if (event.key === "ArrowRight") {
      targetIndex = (currentIndex + 1) % enabledItems.length;
    } else if (event.key === "ArrowLeft") {
      targetIndex = (currentIndex - 1 + enabledItems.length) % enabledItems.length;
    } else if (event.key === "Home") {
      targetIndex = 0;
    } else if (event.key === "End") {
      targetIndex = enabledItems.length - 1;
    }

    if (targetIndex === undefined) {
      return;
    }
    event.preventDefault();
    const target = enabledItems[targetIndex];
    onActiveIdChange(target.id);
    buttonRefs.current.get(target.id)?.focus();
  }

  return (
    <div
      className={mergeClassNames("ch-tabs", className)}
      role="tablist"
      aria-label={ariaLabel}
      data-variant={variant}
    >
      {items.map((item) => {
        const selected = item.id === activeId;
        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node) {
                buttonRefs.current.set(item.id, node);
              } else {
                buttonRefs.current.delete(item.id);
              }
            }}
            id={`${generatedId}-tab-${item.id}`}
            className="ch-tabs__tab"
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={item.panelId}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onActiveIdChange(item.id)}
            onKeyDown={(event) => moveFocus(event, item.id)}
          >
            {item.icon ? <span className="ch-tabs__icon" aria-hidden="true">{item.icon}</span> : null}
            <span className="ch-tabs__label">{item.label}</span>
            {item.badge ? <span className="ch-tabs__badge">{item.badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  active: boolean;
  labelledBy: string;
}

export function TabPanel({ active, labelledBy, className, ...props }: TabPanelProps) {
  return (
    <div
      {...props}
      className={mergeClassNames("ch-tab-panel", className)}
      role="tabpanel"
      aria-labelledby={labelledBy}
      hidden={!active}
      tabIndex={0}
    />
  );
}
