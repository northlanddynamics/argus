export { cn } from "cn"

/**
 * Hidden until its row (`group/row`) is pointed at or holds focus, for what a row says only when it
 * is acted on: Edit, Retract, Promote to Timeline, "Visible to Guests". Always shown on a touch
 * screen, which has no pointing.
 */
export const REVEAL =
  "opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100";
