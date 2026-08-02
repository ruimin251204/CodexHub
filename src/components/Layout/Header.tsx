import type { ReactNode } from "react";
import { mergeClassNames } from "../UI/classNames";

export interface HeaderProps {
  brand?: ReactNode;
  hostSelector?: ReactNode;
  search?: ReactNode;
  actions?: ReactNode;
  identity?: ReactNode;
  ariaLabel?: string;
  className?: string;
}

export function Header({
  brand,
  hostSelector,
  search,
  actions,
  identity,
  ariaLabel,
  className
}: HeaderProps) {
  return (
    <header className={mergeClassNames("ch-header", className)} aria-label={ariaLabel}>
      <div className="ch-header__start">
        {brand ? <div className="ch-header__brand">{brand}</div> : null}
        {hostSelector ? <div className="ch-header__host">{hostSelector}</div> : null}
      </div>
      {search ? <div className="ch-header__center">{search}</div> : null}
      <div className="ch-header__end">
        {actions ? <div className="ch-header__actions">{actions}</div> : null}
        {identity ? <div className="ch-header__identity">{identity}</div> : null}
      </div>
    </header>
  );
}
