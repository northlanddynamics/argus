import { queryOptions } from "@tanstack/react-query";
import { integrationHealthLabel } from "api/alerts/vocabulary";
import { api } from "@/lib/api";

export {
  ALERT_KINDS,
  ALERT_STATUSES,
  alertKindLabel,
  alertStatusLabel,
  FALCON_CLOUDS,
  falconCloudLabel,
  integrationHealthLabel,
  type AlertKind,
  type AlertStatus,
  type FalconCloud,
  type IntegrationHealth,
} from "api/alerts/vocabulary";

/** Every query on the Alert queue starts with this key. */
export const alertsKey = ["alerts"] as const;
export const integrationsKey = ["integrations"] as const;

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
