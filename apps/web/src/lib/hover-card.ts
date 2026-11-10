import { useState } from "react";

/** Whether a right-click menu is open anywhere on the page. */
const menuOpen = () => !!document.querySelector('[data-slot="context-menu-content"][data-state="open"]');

/**
 * A context popup's open state that won't open over a right-click menu: right-clicking a value
 * starts the popup's hover delay, and a popup drawn over the menu would take the menu's Escape.
 */
export function useHoverCardOpen() {
  const [open, setOpen] = useState(false);
  return { open, onOpenChange: (next: boolean) => setOpen(next && !menuOpen()) };
}
