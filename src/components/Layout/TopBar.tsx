import type { ReactNode } from "react";
import { mergeClassNames } from "../UI/classNames";

export interface TopBarProps {
  leading?: ReactNode;
  search: ReactNode;
  trailing?: ReactNode;
  windowControls?: ReactNode;
  ariaLabel: string;
  className?: string;
}

/** 统一桌面顶栏；窗口控制由实际运行平台注入。 */
export function TopBar({ leading, search, trailing, windowControls, ariaLabel, className }: TopBarProps) {
  return (
    <header className={mergeClassNames("ch-top-bar", className)} aria-label={ariaLabel}>
      <div className="ch-top-bar__leading">{leading}</div>
      <div className="ch-top-bar__search">{search}</div>
      <div className="ch-top-bar__trailing">{trailing}</div>
      {windowControls ? <div className="ch-top-bar__window-controls">{windowControls}</div> : null}
    </header>
  );
}
