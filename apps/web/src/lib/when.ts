import { utc } from "api/timeline/occurred-at";
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

/**
 * An instant on the Case record: "2026-11-08 00:51 UTC". Every time on a Case is shown this way,
 * as the Timeline and Case Reports show it, so one moment never reads two ways on two tabs.
 */
export const instant = (iso: string) => utc(new Date(iso).toISOString());

/** The exact time, shown on hover over a `when`. */
export const exactTime = instant;
