/**
 * When a Timeline Entry happened in the real world: exact, a range, or approximate (an instant give
 * or take a precision). Shared with the SPA, which writes and shows times the same way (UTC).
 */
export type OccurredAt =
  | { kind: "exact"; at: string }
  | { kind: "range"; start: string; end: string }
  | { kind: "approximate"; at: string; precisionMinutes: number };

/** "2026-10-28 09:14 UTC". */
export const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** "± 6 h": a precision as people read it. */
export function precisionLabel(minutes: number) {
  if (minutes % 1440 === 0) return `± ${minutes / 1440} d`;
  if (minutes % 60 === 0) return `± ${minutes / 60} h`;
  return `± ${minutes} min`;
}

/** "2026-10-28 09:20 → 09:47 UTC", "≈ 2026-10-27 18:00 UTC ± 6 h". */
export function describeOccurredAt(o: OccurredAt) {
  switch (o.kind) {
    case "exact":
      return utc(o.at);
    case "range":
      return o.start.slice(0, 10) === o.end.slice(0, 10)
        ? `${o.start.slice(0, 10)} ${o.start.slice(11, 16)} → ${o.end.slice(11, 16)} UTC`
        : `${utc(o.start)} → ${utc(o.end)}`;
    case "approximate":
      return `≈ ${utc(o.at)} ${precisionLabel(o.precisionMinutes)}`;
  }
}
