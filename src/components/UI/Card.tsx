import type { HTMLAttributes } from "react";
import { mergeClassNames } from "./classNames";

export type CardVariant = "default" | "subtle" | "elevated" | "interactive";
export type CardPadding = "none" | "sm" | "md" | "lg";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  padding?: CardPadding;
}

export function Card({
  variant = "default",
  padding = "md",
  className,
  ...props
}: CardProps) {
  return (
    <div
      {...props}
      className={mergeClassNames("ch-card", className)}
      data-variant={variant}
      data-padding={padding}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={mergeClassNames("ch-card__header", className)} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 {...props} className={mergeClassNames("ch-card__title", className)} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...props} className={mergeClassNames("ch-card__description", className)} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={mergeClassNames("ch-card__content", className)} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={mergeClassNames("ch-card__footer", className)} />;
}
