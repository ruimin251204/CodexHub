import { useId } from "react";
import type { ReactNode } from "react";
import { mergeClassNames } from "../UI/classNames";
import { PageHeader } from "./PageHeader";

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
      <PageHeader title={title} titleId={titleId} description={description} icon={icon} actions={actions} status={status} />
      {navigation ? <div className="ch-page__navigation">{navigation}</div> : null}
      <div className={mergeClassNames("ch-page__body", bodyClassName)}>{children}</div>
    </section>
  );
}
