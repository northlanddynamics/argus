/** What the Metrics dashboard is described with, shared by the API and the SPA. */

/** How many days back the dashboard can look, counting today. */
export const DASHBOARD_PERIODS = [7, 30, 90] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = 30;

/** The Statuses an open Case can have: every one but Closed, in workflow order. */
export const OPEN_STATUSES = ["new", "triage", "in_progress", "awaiting_info", "resolved"] as const;
export type OpenStatus = (typeof OPEN_STATUSES)[number];
