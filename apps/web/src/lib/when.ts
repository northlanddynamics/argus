import { ago } from "@/lib/alerts";

/** "4 min ago" today, "Nov 3" before that: how the Case list and the sidebar say when a Case changed. */
export const when = (iso: string) =>
  Date.now() - Date.parse(iso) < 86_400_000 ? ago(iso) : new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The exact local time, shown on hover over a `when`. */
export const exactTime = (iso: string) => new Date(iso).toLocaleString();
