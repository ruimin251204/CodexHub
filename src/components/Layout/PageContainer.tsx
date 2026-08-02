import { useId } from "react";
import type { ReactNode } from "react";
import { mergeClassNames } from "../UI/classNames";

export type PageContainerWidth = "contained" | "wide" | "full";

export interface PageContainerProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
  navigation?: ReactNode;
  children: ReactNode;
  width?: PageContainerWidth;
  className?: string;
  bodyClassName?: string;
}

export function PageContainer({
  title,
  description,
  icon,
  actions,
  status,
  navigation,
  children,
  width = "wide",
  className,
  bodyClassName
}: PageContainerProps) {
  const titleId = useId();

  return (
    <section
      className={mergeClassNames("ch-page", className)}
      data-width={width}
      aria-labelledby={titleId}
    >
      <div className="ch-page__header">
        <div className="ch-page__heading">
          {icon ? <div className="ch-page__icon" aria-hidden="true">{icon}</div> : null}
          <div className="ch-page__heading-copy">
            <h1 id={titleId}>{title}</h1>
            {description ? <p>{description}</p> : null}
          </div>
        </div>
        <div className="ch-page__controls">
          {status ? <div className="ch-page__status">{status}</div> : null}
          {actions ? <div className="ch-page__actions">{actions}</div> : null}
        </div>
      </div>
      {navigation ? <div className="ch-page__navigation">{navigation}</div> : null}
      <div className={mergeClassNames("ch-page__body", bodyClassName)}>{children}</div>
    </section>
  );
}
