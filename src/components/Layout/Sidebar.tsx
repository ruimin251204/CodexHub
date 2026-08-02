import { useEffect, useState, type ReactNode } from "react";
import type { StatusTone } from "../UI/StatusBadge";
import { mergeClassNames } from "../UI/classNames";

const COMPACT_SIDEBAR_MEDIA_QUERY = "(max-width: 820px)";

function matchesCompactSidebarViewport() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY).matches;
}

/** Keeps icon-only navigation semantics aligned with the responsive CSS breakpoint. */
function useCompactSidebarViewport() {
  const [compact, setCompact] = useState(matchesCompactSidebarViewport);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const mediaQuery = window.matchMedia(COMPACT_SIDEBAR_MEDIA_QUERY);
    const updateCompact = () => setCompact(mediaQuery.matches);

    updateCompact();
    mediaQuery.addEventListener("change", updateCompact);
    return () => mediaQuery.removeEventListener("change", updateCompact);
  }, []);

  return compact;
}

export interface SidebarIndicator {
  tone: StatusTone;
  label: string;
}

export interface SidebarItem {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: ReactNode;
  indicator?: SidebarIndicator;
  disabled?: boolean;
}

export interface SidebarGroup {
  id: string;
  label?: string;
  items: readonly SidebarItem[];
}

export interface SidebarProps {
  groups: readonly SidebarGroup[];
  activeItemId?: string;
  onItemSelect: (id: string) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  collapseLabel: string;
  expandLabel: string;
  ariaLabel: string;
  brand?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** 侧栏只负责导航呈现，展开状态与页面跳转均由调用方控制。 */
export function Sidebar({
  groups,
  activeItemId,
  onItemSelect,
  collapsed,
  onCollapsedChange,
  collapseLabel,
  expandLabel,
  ariaLabel,
  brand,
  footer,
  className
}: SidebarProps) {
  const forcedCompact = useCompactSidebarViewport();
  const compact = collapsed || forcedCompact;
  const toggleLabel = collapsed ? expandLabel : collapseLabel;

  return (
    <aside
      className={mergeClassNames("ch-sidebar", className)}
      data-collapsed={compact || undefined}
      data-forced-compact={forcedCompact || undefined}
    >
      {brand ? <div className="ch-sidebar__brand">{brand}</div> : null}
      <nav className="ch-sidebar__navigation" aria-label={ariaLabel}>
        {groups.map((group) => (
          <div className="ch-sidebar__group" key={group.id}>
            {group.label ? <div className="ch-sidebar__group-label">{group.label}</div> : null}
            <div className="ch-sidebar__items">
              {group.items.map((item) => {
                const active = item.id === activeItemId;
                const accessibleLabel = item.indicator
                  ? `${item.label}. ${item.indicator.label}`
                  : item.label;
                return (
                  <button
                    key={item.id}
                    className="ch-sidebar__item"
                    type="button"
                    aria-current={active ? "page" : undefined}
                    aria-label={item.indicator || compact ? accessibleLabel : undefined}
                    title={compact ? accessibleLabel : undefined}
                    data-active={active || undefined}
                    disabled={item.disabled}
                    onClick={() => onItemSelect(item.id)}
                  >
                    <span className="ch-sidebar__icon" aria-hidden="true">{item.icon}</span>
                    <span className="ch-sidebar__label">{item.label}</span>
                    {item.badge ? <span className="ch-sidebar__badge">{item.badge}</span> : null}
                    {item.indicator ? (
                      <span
                        className="ch-sidebar__indicator"
                        data-tone={item.indicator.tone}
                        role="img"
                        aria-label={item.indicator.label}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="ch-sidebar__bottom">
        {footer ? <div className="ch-sidebar__footer">{footer}</div> : null}
        {!forcedCompact ? (
          <button
            className="ch-sidebar__collapse"
            type="button"
            aria-label={toggleLabel}
            title={toggleLabel}
            aria-expanded={!collapsed}
            onClick={() => onCollapsedChange(!collapsed)}
          >
            <svg className="ch-sidebar__collapse-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <rect x="2.75" y="3" width="14.5" height="14" rx="2" />
              <path d="M7.25 3v14" />
              <path d={collapsed ? "m10.25 7.25 2.75 2.75-2.75 2.75" : "m13 7.25-2.75 2.75L13 12.75"} />
            </svg>
            <span className="ch-sidebar__collapse-label">{toggleLabel}</span>
          </button>
        ) : null}
      </div>
    </aside>
  );
}
