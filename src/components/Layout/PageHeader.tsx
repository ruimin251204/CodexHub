import { useId, type ReactNode } from "react";
import { mergeClassNames } from "../UI/classNames";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
  className?: string;
  titleId?: string;
}

/** 页面标题只负责信息层级，页面容器继续负责宽度和滚动。 */
export function PageHeader({ title, description, icon, actions, status, className, titleId }: PageHeaderProps) {
  const generatedId = useId();
  const headingId = titleId ?? generatedId;
  return (
    <div className={mergeClassNames("ch-page__header", className)}>
      <div className="ch-page__heading">
        {icon ? <div className="ch-page__icon" aria-hidden="true">{icon}</div> : null}
        <div className="ch-page__heading-copy">
          <h1 id={headingId}>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
      </div>
      <div className="ch-page__controls">
        {status ? <div className="ch-page__status">{status}</div> : null}
        {actions ? <div className="ch-page__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
