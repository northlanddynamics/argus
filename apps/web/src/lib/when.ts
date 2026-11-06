import { ago } from "@/lib/alerts";

/**
 * "4 min ago" today, "Nov 3" before that, "Nov 3, 2025" in another year: how the Case list and the
 * sidebar say when a Case changed.
 */
export const when = (iso: string) => {
  if (Date.now() - Date.parse(iso) < 86_400_000) return ago(iso);
  const date = new Date(iso);
  const otherYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(otherYear ? { year: "numeric" } : {}) });
};

/** The exact local time, shown on hover over a `when`. */
export const exactTime = (iso: string) => new Date(iso).toLocaleString();
