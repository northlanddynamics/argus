import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { visibleCases } from "../access/policy";
import { DISMISSAL_REASONS, type DismissalReason } from "../alerts/vocabulary";
import type { Clock } from "../clock";
import { SEVERITIES, type Severity } from "../cases/vocabulary";
import type { Db } from "../db/client";
import { alerts, caseAuditLog, cases } from "../db/schema";
import type { Membership } from "../members/membership";
import { type DashboardPeriod, OPEN_STATUSES, type OpenStatus } from "./vocabulary";

/**
 * The Metrics dashboard: open Cases by Severity and Status, mean time to acknowledge and to close,
 * Alert volume and the Dismissal rate by Dismissal Reason, over the last 7, 30 or 90 days.
 *
 * - The period runs from the start (UTC) of the day `days - 1` days ago until now, so Alert volume
 *   is one bar per whole day, today last.
 * - Open Cases are counted as they stand now, whatever the period.
 * - Mean time to acknowledge: from a Case being opened to its first Status change out of New
 *   (closing it straight from New counts), over the Cases acknowledged within the period.
 * - Mean time to close: from a Case being opened to it being Closed, over the Cases closed within the
 *   period (and not reopened since).
 * - Alert volume: the Alerts received within the period. The Dismissal rate is the share of those
 *   that have been decided (attached to a Case or dismissed) that were dismissed.
 *
 * Case figures count only the Cases `visibleCases` lets the actor see, so Restricted Cases count
 * only for those who can see them. Members see the whole Alert queue, so Alert figures are the
 * Organization's.
 */

/** Mean times over one stretch of the period. `null` when nothing was acknowledged (or closed) then. */
export type MetricsTrendPoint = {
  /** When the stretch starts (ISO). */
  from: string;
  meanTimeToAcknowledgeMs: number | null;
  meanTimeToCloseMs: number | null;
};

export type DashboardMetrics = {
  days: DashboardPeriod;
  /** The start of the period (ISO): midnight UTC, `days - 1` days ago. */
  from: string;
  /** The end of the period: now (ISO). */
  to: string;
  openCases: {
    total: number;
    unassigned: number;
    bySeverity: Record<Severity, Record<OpenStatus, number>>;
  };
  meanTimeToAcknowledge: { ms: number | null; cases: number };
  meanTimeToClose: { ms: number | null; cases: number };
  alerts: {
    received: number;
    /** Alerts received each day (UTC) of the period, oldest first. */
    perDay: { date: string; count: number }[];
    attached: number;
    dismissed: number;
    /** `dismissed / (attached + dismissed)`, or null when none have been decided. */
    dismissalRate: number | null;
    dismissalsByReason: Record<DismissalReason, number>;
  };
  /** Mean times per day (7 days) or per week (30 and 90 days), oldest first. */
  trend: MetricsTrendPoint[];
};

const DAY_MS = 86_400_000;

/** Midnight UTC at the start of `date`'s day. */
const startOfUtcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** Weighted mean over stretches of `{ n, mean }`; null when there is nothing to average. */
const overall = (rows: { n: number; mean: number | null }[]) => {
  const n = rows.reduce((sum, r) => sum + r.n, 0);
  if (!n) return { ms: null, cases: 0 };
  return { ms: rows.reduce((sum, r) => sum + r.n * (r.mean ?? 0), 0) / n, cases: n };
};

export function metricsStore({ db, clock }: { db: Db; clock: Clock }) {
  return {
    /** The dashboard for the last `days` days, as `me` may see it. */
    async dashboard(me: Membership, days: DashboardPeriod): Promise<DashboardMetrics> {
      const to = clock.now();
      const from = new Date(startOfUtcDay(to).getTime() - (days - 1) * DAY_MS);
      const stretchMs = (days === 7 ? 1 : 7) * DAY_MS;
      const stretches = Math.ceil((to.getTime() - from.getTime() + 1) / stretchMs);
      const fromParam = sql`${from.toISOString()}::timestamptz`;
      /** Which stretch of the period `at` falls in, from 0. */
      const stretchOf = (at: unknown) => sql`floor(extract(epoch from (${at} - ${fromParam})) * 1000 / ${stretchMs})::int`;

      const openRows = await db
        .select({
          severity: cases.severity,
          status: cases.status,
          n: sql<number>`count(*)::int`,
          unassigned: sql<number>`(count(*) filter (where ${isNull(cases.assigneeId)}))::int`,
        })
        .from(cases)
        .where(and(visibleCases(me), ne(cases.status, "closed")))
        .groupBy(cases.severity, cases.status);
      const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, zeros(OPEN_STATUSES)])) as Record<Severity, Record<OpenStatus, number>>;
      for (const r of openRows) bySeverity[r.severity][r.status as OpenStatus] += Number(r.n);
      const openCases = {
        total: openRows.reduce((sum, r) => sum + Number(r.n), 0),
        unassigned: openRows.reduce((sum, r) => sum + Number(r.unassigned), 0),
        bySeverity,
      };

      // A Case is acknowledged at its first Audit Log entry moving it out of New, by a Status change or by closing it.
      const acknowledgedAt = sql`(select min(${caseAuditLog.occurredAt}) from ${caseAuditLog}
        where ${caseAuditLog.caseId} = ${cases.id}
          and ${caseAuditLog.action} in ('case.status_changed', 'case.closed')
          and ${caseAuditLog.before} = 'new')`;
      /** Mean time from opening to `at` per stretch, over the visible Cases whose `at` falls in the period. */
      const meanTimes = async (at: unknown) => {
        const rows = await db.execute<{ stretch: number; n: number; mean: number | null }>(
          sql`select ${stretchOf(sql`at`)} as stretch, count(*)::int as n,
              avg(extract(epoch from (at - opened_at)) * 1000)::float8 as mean
            from (select ${at} as at, ${cases.openedAt} as opened_at from ${cases} where ${visibleCases(me)}) as timed
            where at >= ${fromParam} and at <= ${to.toISOString()}::timestamptz
            group by stretch`,
        );
        return rows.map((r) => ({ stretch: Number(r.stretch), n: Number(r.n), mean: r.mean === null ? null : Number(r.mean) }));
      };
      const [acknowledged, closed] = await Promise.all([meanTimes(acknowledgedAt), meanTimes(cases.closedAt)]);
      const meanIn = (rows: typeof acknowledged, stretch: number) => rows.find((r) => r.stretch === stretch)?.mean ?? null;
      const trend = Array.from({ length: stretches }, (_, i) => ({
        from: new Date(from.getTime() + i * stretchMs).toISOString(),
        meanTimeToAcknowledgeMs: meanIn(acknowledged, i),
        meanTimeToCloseMs: meanIn(closed, i),
      }));

      const inPeriod = and(eq(alerts.organizationId, me.organizationId), gte(alerts.receivedAt, from));
      const day = sql<string>`to_char(${alerts.receivedAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const [dayRows, statusRows] = await Promise.all([
        db.select({ day, n: sql<number>`count(*)::int` }).from(alerts).where(inPeriod).groupBy(day),
        db
          .select({ status: alerts.status, reason: alerts.dismissalReason, n: sql<number>`count(*)::int` })
          .from(alerts)
          .where(inPeriod)
          .groupBy(alerts.status, alerts.dismissalReason),
      ]);
      const perDayCount = new Map(dayRows.map((r) => [r.day, Number(r.n)]));
      const perDay = Array.from({ length: days }, (_, i) => {
        const date = new Date(from.getTime() + i * DAY_MS).toISOString().slice(0, 10);
        return { date, count: perDayCount.get(date) ?? 0 };
      });
      const dismissalsByReason = zeros(DISMISSAL_REASONS);
      let attached = 0;
      let dismissed = 0;
      for (const r of statusRows) {
        if (r.status === "attached") attached += Number(r.n);
        if (r.status === "dismissed") {
          dismissed += Number(r.n);
          if (r.reason) dismissalsByReason[r.reason] += Number(r.n);
        }
      }

      return {
        days,
        from: from.toISOString(),
        to: to.toISOString(),
        openCases,
        meanTimeToAcknowledge: overall(acknowledged),
        meanTimeToClose: overall(closed),
        alerts: {
          received: perDay.reduce((sum, d) => sum + d.count, 0),
          perDay,
          attached,
          dismissed,
          dismissalRate: attached + dismissed ? dismissed / (attached + dismissed) : null,
          dismissalsByReason,
        },
        trend,
      };
    },
  };
}
