import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { DASHBOARD_PERIODS, type DashboardPeriod, DEFAULT_DASHBOARD_PERIOD } from "api/metrics/vocabulary";
import { api } from "@/lib/api";

export { DASHBOARD_PERIODS, type DashboardPeriod, DEFAULT_DASHBOARD_PERIOD, OPEN_STATUSES, type OpenStatus } from "api/metrics/vocabulary";

/** Every Metrics query; live signals about Cases and Alerts invalidate them all. */
export const metricsKey = ["metrics"] as const;

export const dashboardQuery = (days: DashboardPeriod) =>
  queryOptions({
    queryKey: [...metricsKey, "dashboard", days],
    queryFn: async () => {
      const res = await api.metrics.dashboard.$get({ query: { days: String(days) as `${DashboardPeriod}` } });
      if (!res.ok) throw new Error("Could not load the dashboard");
      return (await res.json()).metrics;
    },
    placeholderData: keepPreviousData,
  });

export type DashboardMetrics = Awaited<ReturnType<ReturnType<typeof dashboardQuery>["queryFn"] & {}>>;

export type DashboardSearch = { days?: DashboardPeriod };

/** Reads the period from the URL (`/dashboard?days=7`), ignoring anything unknown. */
export const validateDashboardSearch = (search: Record<string, unknown>): DashboardSearch => {
  const days = Number(search.days);
  return DASHBOARD_PERIODS.includes(days as DashboardPeriod) && days !== DEFAULT_DASHBOARD_PERIOD ? { days: days as DashboardPeriod } : {};
};

/** "38 min", "5.2 h", "3.4 d"; "—" when there is nothing to show. */
export function formatDuration(ms: number | null) {
  if (ms === null) return "—";
  const minutes = ms / 60_000;
  if (minutes < 1) return `${Math.round(ms / 1000)} s`;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

/** "Oct 18", for a UTC date or instant. */
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
