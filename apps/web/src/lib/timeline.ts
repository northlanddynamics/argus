import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

export { describeOccurredAt, type OccurredAt, precisionLabel, utc } from "api/timeline/occurred-at";

/** Under the Case's key, so its live signal refreshes it. */
export const timelineKey = (number: number) => ["cases", number, "timeline"] as const;

export const timelineQuery = (number: number) =>
  queryOptions({
    queryKey: timelineKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"].timeline.$get({ param: { number: String(number) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the Timeline");
      return (await res.json()).entries;
    },
  });

export type TimelineEntryView = NonNullable<Awaited<ReturnType<ReturnType<typeof timelineQuery>["queryFn"] & {}>>>[number];
export type Citation = { kind: "task"; id: string };
export type PromotionSource = { kind: "discussion_message" | "audit_log_entry"; id: string };

/** The give-or-take choices for an approximate time, in minutes. */
export const PRECISIONS = [15, 60, 360, 1440, 10_080, 43_200] as const;

export const occurredKindLabel = { exact: "Exact", range: "Range", approximate: "Approximate" } as const;

/** An ISO instant as a `datetime-local` input shows it, in UTC: "2026-10-28T09:14". */
export const toUtcInput = (iso: string) => new Date(iso).toISOString().slice(0, 16);
/** A `datetime-local` value, read as UTC, back to an ISO instant. */
export const fromUtcInput = (value: string) => `${value}:00Z`;

/** The ids of what is on the Timeline now (not retracted), by source id. */
export const promotedSources = (entries: readonly TimelineEntryView[] | null | undefined) =>
  new Set((entries ?? []).filter((e) => e.source && !e.retracted).map((e) => e.source!.id));
