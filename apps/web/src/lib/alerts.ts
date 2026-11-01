import { queryOptions } from "@tanstack/react-query";
import { integrationHealthLabel } from "api/alerts/vocabulary";
import { api } from "@/lib/api";

export {
  ALERT_KINDS,
  ALERT_STATUSES,
  alertKindLabel,
  alertStatusLabel,
  DISMISSAL_REASONS,
  dismissalReasonLabel,
  FALCON_CLOUDS,
  falconCloudLabel,
  integrationHealthLabel,
  type AlertKind,
  type AlertStatus,
  type DismissalReason,
  type FalconCloud,
  type IntegrationHealth,
} from "api/alerts/vocabulary";

/** Every query on the Alert queue starts with this key. */
export const alertsKey = ["alerts"] as const;
export const integrationsKey = ["integrations"] as const;

/** One Alert in full; under `alertsKey`, so the queue's live signal refreshes it. */
export const alertQuery = (id: string) =>
  queryOptions({
    queryKey: [...alertsKey, "detail", id],
    queryFn: async () => {
      const res = await api.alerts[":id"].$get({ param: { id } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the Alert");
      return (await res.json()).alert;
    },
  });

export type AlertDetail = NonNullable<Awaited<ReturnType<ReturnType<typeof alertQuery>["queryFn"] & {}>>>;

/** The Alerts attached to Case `number`. */
/** The Alerts attached to a Case that the viewer can see (Guests: those that aren't Internal). */
export const caseAlertsQuery = (number: number) =>
  queryOptions({
    // Under the Case's key, so its live signal refreshes them (Guests hear no Alert queue signals).
    queryKey: ["cases", number, "alerts"],
    queryFn: async () => {
      const res = await api.cases[":number"].alerts.$get({ param: { number: String(number) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the Case's Alerts");
      return (await res.json()).alerts;
    },
  });

/** Selected Alerts: each id with the version shown when it was selected. */
export type AlertSelection = { id: string; version: number }[];

/** An Alert a bulk action left as it was: `detail` completes "<externalId> …". */
export type Refusal = { id: string; externalId: string | null; title: string | null; reason: string; detail: string };
/** What a bulk action did. */
export type BulkResult = { applied: string[]; refused: Refusal[] };

export const integrationsQuery = queryOptions({
  queryKey: integrationsKey,
  queryFn: async () => {
    const res = await api.integrations.$get();
    if (!res.ok) throw new Error("Could not load Integrations");
    return (await res.json()).integrations;
  },
});

export type IntegrationView = Awaited<ReturnType<typeof integrationsQuery.queryFn & {}>>[number];

/** "12 s ago", "4 min ago", or the date. */
export function ago(iso: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}

/** How the Integration is doing, in a word or two: "Paused", "Connected", "Error". */
export const healthWord = (i: Pick<IntegrationView, "paused" | "health">) =>
  i.paused ? "Paused" : integrationHealthLabel[i.health];
