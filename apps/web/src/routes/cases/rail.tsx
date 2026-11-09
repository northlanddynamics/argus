import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The Overview's properties rail: short sections stacked in one card, divided by hairlines, so an
 * empty one costs a line rather than a card of its own. Record-keeping, so it reads quietly: a 12px
 * label over each value rather than a heading.
 */
export function RailSection({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("grid min-w-0 gap-1.5 px-4 py-3", className)} {...props} />;
}

/** A section's heading, with its action (if any) at the end of the line. */
export function RailHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex min-h-6 items-center justify-between gap-2", className)} {...props} />;
}

export function RailTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-xs font-medium text-muted-foreground", className)} {...props} />;
}

export function RailBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid min-w-0 gap-2 text-sm text-pretty", className)} {...props} />;
}

/**
 * A row's own actions (Edit, Retract, Promote): ghost buttons in muted ink that strengthen when the
 * row is pointed at, so a list of entries reads as a record rather than a wall of buttons. The row
 * carries `group/row`.
 */
export const QUIET_ACTION = "text-muted-foreground group-hover/row:text-foreground";

