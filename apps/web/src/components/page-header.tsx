import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A page's `h1`. Use it directly only to wrap the heading itself, as `PageHeader`'s `heading`. */
export function PageTitle({ className, ...props }: ComponentProps<"h1">) {
  return <h1 className={cn("text-2xl font-semibold tracking-tight", className)} {...props} />;
}

/**
 * Every page's header: the title first, any further information on the line under it, and the
 * page's actions on the right (wrapping under the title when there's no room).
 */
export function PageHeader({
  title,
  heading,
  description,
  actions,
  className,
}: {
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
} & (
  | { title: ReactNode; heading?: never }
  /** A `PageTitle` the page has wrapped itself, such as in a context menu. */
  | { title?: never; heading: ReactElement }
)) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="grid min-w-0 flex-1 basis-80 gap-1">
        {heading ?? <PageTitle>{title}</PageTitle>}
        {description && <div className="max-w-prose text-sm text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
