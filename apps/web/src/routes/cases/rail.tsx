import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The Overview's side rail: short sections stacked in one card, divided by hairlines, so an empty
 * one costs a line rather than a card of its own.
 */
export function RailSection({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("grid gap-2 px-4 py-3", className)} {...props} />;
}

/** A section's heading, with its action (if any) at the end of the line. */
export function RailHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex min-h-7 items-center justify-between gap-2", className)} {...props} />;
}

export function RailTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-sm font-medium", className)} {...props} />;
}

export function RailBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("grid gap-3 text-sm text-pretty", className)} {...props} />;
}

/**
 * A row's own actions (Edit, Retract, Promote): ghost buttons in muted ink that strengthen when the
 * row is pointed at, so a list of entries reads as a record rather than a wall of buttons. The row
 * carries `group/row`.
 */
export const QUIET_ACTION = "text-muted-foreground group-hover/row:text-foreground";
