import { useSyncExternalStore } from "react";

/** Marks a drag as Alerts from the Alert queue, so other drags (links, text, files) are left alone. */
export const ALERTS_MIME = "application/x-argus-alerts";

/** Alerts being dragged from the Alert queue: how many, and what dropping them on a Case does. */
export type AlertDrag = { count: number; drop: (caseNumber: number) => void };

let current: AlertDrag | null = null;
const listeners = new Set<() => void>();
const set = (next: AlertDrag | null) => {
  current = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** "1 Alert", "3 Alerts". */
export const alertCount = (n: number) => `${n} ${n === 1 ? "Alert" : "Alerts"}`;

/** Starts dragging Alerts: the pointer carries a label saying how many. */
export function startAlertDrag(event: DragEvent | React.DragEvent, drag: AlertDrag) {
  const transfer = event.dataTransfer;
  if (!transfer) return;
  transfer.effectAllowed = "move";
  // Some browsers start no drag without data.
  transfer.setData(ALERTS_MIME, String(drag.count));
  const label = document.createElement("div");
  label.textContent = alertCount(drag.count);
  label.className = "fixed -top-96 left-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-md";
  document.body.append(label);
  transfer.setDragImage(label, -12, -12);
  requestAnimationFrame(() => label.remove());
  set(drag);
}

/** Ends the drag, dropped or not. */
export const endAlertDrag = () => set(null);

/** The Alerts being dragged right now, if any. */
export const useAlertDrag = () => useSyncExternalStore(subscribe, () => current, () => null);
