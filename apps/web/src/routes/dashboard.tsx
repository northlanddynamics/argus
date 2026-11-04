import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DISMISSAL_REASONS, dismissalReasonLabel } from "@/lib/alerts";
import { SEVERITIES, severityLabel, statusLabel } from "@/lib/cases";
import {
  DASHBOARD_PERIODS,
  type DashboardMetrics,
  type DashboardPeriod,
  dashboardQuery,
  DEFAULT_DASHBOARD_PERIOD,
  formatDuration,
  OPEN_STATUSES,
  shortDate,
} from "@/lib/metrics";
import { cn } from "@/lib/utils";

const count = (n: number) => n.toLocaleString();
const percent = (share: number) => `${Math.round(share * 100)}%`;

/**
 * The Metrics dashboard, for Members: open Cases by Severity and Status, mean time to acknowledge
 * and to close, Alert volume and dismissals by Dismissal Reason. Counts only the Cases the Member
 * can see, and refreshes live: signals about Cases and Alerts invalidate it (`lib/live.ts`).
 */
export function DashboardPage() {
  const search = useSearch({ from: "/_app/dashboard" });
  const navigate = useNavigate({ from: "/dashboard" });
  const days = search.days ?? DEFAULT_DASHBOARD_PERIOD;
  const metrics = useQuery(dashboardQuery(days));
  const data = metrics.data;

  return (
    <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Refreshes live · counts only the Cases you can see · days in UTC</p>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          aria-label="Period"
          value={String(days)}
          // Choosing the current period again would clear it; there is always one.
          onValueChange={(value) => {
            if (!value) return;
            const next = Number(value) as DashboardPeriod;
            void navigate({ search: { days: next === DEFAULT_DASHBOARD_PERIOD ? undefined : next }, replace: true });
          }}
        >
          {DASHBOARD_PERIODS.map((d) => (
            <ToggleGroupItem key={d} value={String(d)} className="px-3">
              {d} days
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {metrics.isError && <p className="py-8 text-center text-sm text-destructive">Could not load the dashboard. Try again.</p>}
      {metrics.isPending && <DashboardSkeleton />}
      {data && <Dashboard metrics={data} />}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-72" />
        ))}
      </div>
    </>
  );
}

function Dashboard({ metrics }: { metrics: DashboardMetrics }) {
  const { openCases, meanTimeToAcknowledge, meanTimeToClose, alerts } = metrics;
  const casesWord = (n: number) => `${count(n)} ${n === 1 ? "Case" : "Cases"}`;
  const critical = Object.values(openCases.bySeverity.critical).reduce((sum, n) => sum + n, 0);
  return (
    <>
      <section aria-label="Headline figures" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        <Figure label="Open Cases" value={count(openCases.total)}>
          {count(critical)} Critical · {count(openCases.unassigned)} unassigned
        </Figure>
        <Figure label="Mean time to acknowledge" value={formatDuration(meanTimeToAcknowledge.ms)}>
          Opened → first move out of New · {casesWord(meanTimeToAcknowledge.cases)}
        </Figure>
        <Figure label="Mean time to close" value={formatDuration(meanTimeToClose.ms)}>
          Opened → Closed · {casesWord(meanTimeToClose.cases)}
        </Figure>
        <Figure label="Alerts received" value={count(alerts.received)}>
          All Integrations, last {metrics.days} days
        </Figure>
        <Figure label="Dismissal rate" value={alerts.dismissalRate === null ? "—" : percent(alerts.dismissalRate)}>
          of {count(alerts.attached + alerts.dismissed)} decided Alerts dismissed, not attached
        </Figure>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <OpenCasesTable openCases={openCases} className="lg:col-span-2" />
        <AlertVolume perDay={alerts.perDay} />
        <Dismissals alerts={alerts} />
        <Trend metrics={metrics} className="lg:col-span-2" />
      </div>
    </>
  );
}

function Figure({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <Card className="gap-1 py-4" role="group" aria-label={label}>
      <CardContent className="grid gap-1 px-4">
        <h2 className="text-sm text-muted-foreground">{label}</h2>
        <p className="text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{children}</p>
      </CardContent>
    </Card>
  );
}

function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <Card className={cn("min-w-0 gap-4", className)}>
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}

/** Each count links to the Case list filtered to it. */
function OpenCasesTable({ openCases, className }: { openCases: DashboardMetrics["openCases"]; className?: string }) {
  const cell = "text-center tabular-nums";
  const linkClass = "block rounded px-1 underline-offset-4 hover:underline focus-visible:underline";
  const statusTotal = (status: (typeof OPEN_STATUSES)[number]) => SEVERITIES.reduce((sum, s) => sum + openCases.bySeverity[s][status], 0);
  return (
    <Panel title="Open Cases by Severity and Status" className={className}>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Severity</TableHead>
              {OPEN_STATUSES.map((status) => (
                <TableHead key={status} className="text-center whitespace-normal">
                  {statusLabel[status]}
                </TableHead>
              ))}
              <TableHead className="text-center">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SEVERITIES.map((severity) => {
              const row = openCases.bySeverity[severity];
              const total = OPEN_STATUSES.reduce((sum, s) => sum + row[s], 0);
              return (
                <TableRow key={severity}>
                  <TableHead scope="row" className="font-medium text-foreground">
                    {severityLabel[severity]}
                  </TableHead>
                  {OPEN_STATUSES.map((status) => (
                    <TableCell key={status} className={cn(cell, row[status] === 0 && "text-muted-foreground")}>
                      <Link
                        to="/"
                        search={{ view: "open", severity, status }}
                        className={linkClass}
                        aria-label={`${row[status]} ${severityLabel[severity]} ${statusLabel[status]}`}
                      >
                        {row[status]}
                      </Link>
                    </TableCell>
                  ))}
                  <TableCell className={cn(cell, "font-semibold")}>
                    <Link to="/" search={{ view: "open", severity }} className={linkClass} aria-label={`${total} ${severityLabel[severity]} open`}>
                      {total}
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableHead scope="row" className="font-medium text-foreground">
                Total
              </TableHead>
              {OPEN_STATUSES.map((status) => (
                <TableCell key={status} className={cn(cell, "font-semibold")}>
                  <Link to="/" search={{ view: "open", status }} className={linkClass} aria-label={`${statusTotal(status)} ${statusLabel[status]}`}>
                    {statusTotal(status)}
                  </Link>
                </TableCell>
              ))}
              <TableCell className={cn(cell, "font-semibold")}>
                <Link to="/" search={{ view: "open" }} className={linkClass} aria-label={`${openCases.total} open`}>
                  {openCases.total}
                </Link>
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Each count opens the Case list with those filters.</p>
    </Panel>
  );
}

/** One bar per day, today last, with the count on hover; a table for screen readers. */
function AlertVolume({ perDay }: { perDay: DashboardMetrics["alerts"]["perDay"] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...perDay.map((d) => d.count));
  const shown = hovered === null ? null : perDay[hovered];
  if (perDay.every((d) => d.count === 0))
    return (
      <Panel title="Alert volume per day">
        <p className="text-sm text-muted-foreground">No Alerts received in this period.</p>
      </Panel>
    );
  return (
    <Panel title="Alert volume per day">
      <div className="relative" onMouseLeave={() => setHovered(null)}>
        <p className="h-5 text-xs text-muted-foreground tabular-nums" aria-hidden>
          {shown ? `${shortDate(shown.date)}: ${count(shown.count)} ${shown.count === 1 ? "Alert" : "Alerts"}` : `Most in a day: ${count(max)}`}
        </p>
        <div className={cn("flex h-44 items-end border-b border-border", perDay.length > 30 ? "gap-px" : "gap-0.5")} aria-hidden>
          {perDay.map((d, i) => (
            <div key={d.date} className="flex h-full min-w-0 flex-1 items-end" onMouseEnter={() => setHovered(i)} data-testid="alert-volume-bar">
              <div
                className={cn("w-full rounded-t-sm bg-(--series-1)", hovered !== null && hovered !== i && "opacity-60")}
                style={{ height: d.count ? `max(2px, ${(d.count / max) * 100}%)` : 0 }}
                title={`${shortDate(d.date)}: ${d.count}`}
              />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-xs text-muted-foreground" aria-hidden>
          <span>{shortDate(perDay[0]!.date)}</span>
          <span>{shortDate(perDay.at(-1)!.date)}</span>
        </div>
        <table className="sr-only">
          <caption>Alerts received per day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Alerts</th>
            </tr>
          </thead>
          <tbody>
            {perDay.map((d) => (
              <tr key={d.date}>
                <th scope="row">{shortDate(d.date)}</th>
                <td>{d.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Dismissals({ alerts }: { alerts: DashboardMetrics["alerts"] }) {
  return (
    <Panel title="Dismissals by Dismissal Reason">
      {alerts.dismissed === 0 ? (
        <p className="text-sm text-muted-foreground">No Alerts received in this period have been dismissed.</p>
      ) : (
        <dl className="grid gap-3">
          {DISMISSAL_REASONS.map((reason) => {
            const n = alerts.dismissalsByReason[reason];
            const share = n / alerts.dismissed;
            return (
              <div key={reason} className="grid grid-cols-[7rem_1fr_5.5rem] items-center gap-3 text-sm">
                <dt>{dismissalReasonLabel[reason]}</dt>
                <div className="h-3.5 rounded-sm bg-muted" aria-hidden>
                  <div className="h-full rounded-sm bg-(--series-1)" style={{ width: `${share * 100}%` }} />
                </div>
                <dd className="text-right tabular-nums">
                  {percent(share)} <span className="text-muted-foreground">({count(n)})</span>
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </Panel>
  );
}

const TREND_W = 720;
const TREND_H = 220;
const PAD = { top: 12, right: 12, bottom: 24, left: 44 };

/** Mean times per day or week, as two lines on one time axis; a table for screen readers. */
function Trend({ metrics, className }: { metrics: DashboardMetrics; className?: string }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const points = metrics.trend;
  const stretch = metrics.days === 7 ? "day" : "week";
  const values = points.flatMap((p) => [p.meanTimeToAcknowledgeMs, p.meanTimeToCloseMs]).filter((v): v is number => v !== null);
  const series = [
    { key: "meanTimeToAcknowledgeMs", label: "Time to acknowledge", color: "var(--series-1)" },
    { key: "meanTimeToCloseMs", label: "Time to close", color: "var(--series-2)" },
  ] as const;
  const legend = (
    <ul className="flex flex-wrap gap-4 text-xs text-muted-foreground">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} aria-hidden />
          {s.label}
        </li>
      ))}
    </ul>
  );
  if (!values.length)
    return (
      <Panel title="Time to acknowledge and close — trend" className={className}>
        <p className="text-sm text-muted-foreground">No Cases were acknowledged or closed in this period.</p>
      </Panel>
    );

  const axis = niceAxis(Math.max(...values));
  const max = axis.max;
  const plotW = TREND_W - PAD.left - PAD.right;
  const plotH = TREND_H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const tickLabel = (t: number) => (t === 0 ? "0" : `${t / axis.unit} ${axis.unitLabel}`);
  const shown = hovered === null ? null : points[hovered]!;
  /** A line through the stretches that have a value, broken where one has none. */
  const path = (key: (typeof series)[number]["key"]) => {
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = p[key];
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  return (
    <Panel title="Time to acknowledge and close — trend" className={className}>
      <div className="grid gap-2">
        {legend}
        <p className="h-4 text-xs text-muted-foreground tabular-nums" aria-hidden>
          {shown
            ? `${stretch === "day" ? "" : "Week of "}${shortDate(shown.from)}: acknowledge ${formatDuration(shown.meanTimeToAcknowledgeMs)} · close ${formatDuration(shown.meanTimeToCloseMs)}`
            : `Mean per ${stretch}; hover for values`}
        </p>
        <svg viewBox={`0 0 ${TREND_W} ${TREND_H}`} className="h-auto w-full" aria-hidden onMouseLeave={() => setHovered(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={TREND_W - PAD.right} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-[11px]">
                {tickLabel(t)}
              </text>
            </g>
          ))}
          <text x={PAD.left} y={TREND_H - 6} className="fill-muted-foreground text-[11px]">
            {shortDate(points[0]!.from)}
          </text>
          <text x={TREND_W - PAD.right} y={TREND_H - 6} textAnchor="end" className="fill-muted-foreground text-[11px]">
            {shortDate(points.at(-1)!.from)}
          </text>
          {hovered !== null && <line x1={x(hovered)} x2={x(hovered)} y1={PAD.top} y2={PAD.top + plotH} className="stroke-muted-foreground" strokeWidth={1} />}
          {series.map((s) => (
            <g key={s.key}>
              <path d={path(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {points.map((p, i) => {
                const v = p[s.key];
                return v === null ? null : (
                  <circle key={i} cx={x(i)} cy={y(v)} r={hovered === i ? 5 : 3.5} fill={s.color} className="stroke-card" strokeWidth={2} />
                );
              })}
            </g>
          ))}
          {points.map((_, i) => {
            const half = points.length === 1 ? plotW / 2 : plotW / (points.length - 1) / 2;
            return (
              <rect key={i} x={x(i) - half} y={PAD.top} width={half * 2} height={plotH} fill="transparent" onMouseEnter={() => setHovered(i)} />
            );
          })}
        </svg>
        <table className="sr-only">
          <caption>Mean time to acknowledge and to close per {stretch}</caption>
          <thead>
            <tr>
              <th scope="col">{stretch === "day" ? "Day" : "Week of"}</th>
              <th scope="col">Time to acknowledge</th>
              <th scope="col">Time to close</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.from}>
                <th scope="row">{shortDate(p.from)}</th>
                <td>{formatDuration(p.meanTimeToAcknowledgeMs)}</td>
                <td>{formatDuration(p.meanTimeToCloseMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** A round axis maximum at or above `ms`, in whole minutes, hours or days, halving evenly. */
function niceAxis(ms: number) {
  const units = [
    { unit: 86_400_000, unitLabel: "d" },
    { unit: 3_600_000, unitLabel: "h" },
    { unit: 60_000, unitLabel: "min" },
  ];
  const { unit, unitLabel } = units.find((u) => ms >= 2 * u.unit) ?? units.at(-1)!;
  const n = Math.max(2, Math.ceil(ms / unit));
  const steps = [2, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 48, 60, 80, 90, 100, 120];
  return { max: (steps.find((s) => s >= n) ?? Math.ceil(n / 2) * 2) * unit, unit, unitLabel };
}
