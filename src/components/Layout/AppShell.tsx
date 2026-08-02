import type { ReactNode } from "react";
import { mergeClassNames } from "../UI/classNames";

export interface AppShellProps {
  header?: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
  sidebarCollapsed?: boolean;
  mainLabel?: string;
  className?: string;
  mainClassName?: string;
}

/** 统一承载顶栏、侧栏和主内容区，不持有任何路由或业务状态。 */
export function AppShell({
  header,
  sidebar,
  children,
  sidebarCollapsed = false,
  mainLabel,
  className,
  mainClassName
}: AppShellProps) {
  return (
    <div
      className={mergeClassNames("ch-app-shell", className)}
      data-has-header={header ? "true" : "false"}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
    >
      {header ? <div className="ch-app-shell__header">{header}</div> : null}
      <div className="ch-app-shell__sidebar">{sidebar}</div>
      <main className={mergeClassNames("ch-app-shell__main", mainClassName)} aria-label={mainLabel}>
        {children}
      </main>
    </div>
  );
}
