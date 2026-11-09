import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { SeverityBadge } from "@/components/case-badges";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DISMISSAL_REASONS, dismissalReasonLabel } from "@/lib/alerts";
import { type Severity, SEVERITIES, severityLabel, statusLabel } from "@/lib/cases";
import {
  DASHBOARD_PERIODS,
  type DashboardMetrics,
  type DashboardPeriod,
  dashboardQuery,
  DEFAULT_DASHBOARD_PERIOD,
  formatDuration,
  OPEN_STATUSES,
  type OpenStatus,
  shortDate,
} from "@/lib/metrics";
import { cn } from "@/lib/utils";
import { when } from "@/lib/when";

const count = (n: number) => n.toLocaleString();
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
/** The focus ring every control in the app draws, for links and focusable charts drawn here. */
const focusRing = "rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * The Metrics dashboard, for Members, in two groups. Cases: open Cases by Severity and Status, mean time
 * to acknowledge and to close, and their trend. Alerts: those awaiting a decision, the Dismissal rate,
 * volume per day and dismissals by Dismissal Reason. Counts only the Cases the Member can see, and
 * refreshes live: signals about Cases and Alerts invalidate it (`lib/live.ts`).
 */
export function DashboardPage() {
  const search = useSearch({ from: "/_app/dashboard" });
  const navigate = useNavigate({ from: "/dashboard" });
  const days = search.days ?? DEFAULT_DASHBOARD_PERIOD;
  const metrics = useQuery(dashboardQuery(days));
  const data = metrics.data;
  // While another period loads, the previous one stays on screen, faded, so the page doesn't jump.
  const switching = metrics.isPlaceholderData;

  return (
    <div className="grid w-full grid-cols-1 gap-6">
      <PageHeader
        title="Dashboard"
        description={data && !switching && <>Updated {clock(metrics.dataUpdatedAt)}</>}
        actions={
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
        }
      />

      {metrics.isError && (
        <Alert variant="destructive">
          <AlertTitle>The dashboard couldn't be loaded</AlertTitle>
          <AlertDescription>
            {data
              ? "The figures below may be out of date. Try again, or reload the page."
              : "No figures are shown because the dashboard didn't load. Try again, or reload the page."}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" disabled={metrics.isFetching} onClick={() => metrics.refetch()}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      )}
      {metrics.isPending && <DashboardSkeleton />}
      {data && (
        <div aria-busy={switching} className={cn("grid gap-8 transition-opacity", switching && "opacity-60")}>
          <Dashboard metrics={data} />
        </div>
      )}
    </div>
  );
}

function SkeletonGroup({ figures, className }: { figures: number; className: string }) {
  return (
    <div className="grid gap-3">
      <Skeleton className="h-6 w-24" />
      <div className={cn("grid grid-cols-1 gap-3", className)}>
        {Array.from({ length: figures }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 @4xl:grid-cols-2">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-8">
      <SkeletonGroup figures={3} className="@2xl:grid-cols-3" />
      <SkeletonGroup figures={2} className="@xl:grid-cols-2" />
    </div>
  );
}

function Dashboard({ metrics }: { metrics: DashboardMetrics }) {
  const { openCases, meanTimeToAcknowledge, meanTimeToClose, alerts } = metrics;
  const critical = OPEN_STATUSES.reduce((sum, s) => sum + openCases.bySeverity.critical[s], 0);
  const { awaitingDecision } = alerts;
  return (
    <>
      <Group title="Cases">
        <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-3">
          <Figure label="Open Cases" value={count(openCases.total)}>
            {count(critical)} Critical ·{" "}
            {openCases.unassigned ? (
              <Link to="/" search={{ view: "unassigned" }} className={cn(focusRing, "underline underline-offset-4 hover:text-foreground")}>
                {count(openCases.unassigned)} unassigned
              </Link>
            ) : (
              "0 unassigned"
            )}
          </Figure>
          <Figure label="Mean time to acknowledge" value={formatDuration(meanTimeToAcknowledge.ms)}>
            Opened → first move out of New · {plural(meanTimeToAcknowledge.cases, "Case", "Cases")}
          </Figure>
          <Figure label="Mean time to close" value={formatDuration(meanTimeToClose.ms)}>
            Opened → Closed · {plural(meanTimeToClose.cases, "Case", "Cases")}
          </Figure>
        </div>
        <div className="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-2">
          <OpenCasesTable openCases={openCases} />
          <Trend metrics={metrics} />
        </div>
      </Group>

      <Group title="Alerts">
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
          <Figure
            label="Alerts awaiting a decision"
            value={
              awaitingDecision.count ? (
                <Link to="/alerts" className={cn(focusRing, "underline-offset-4 hover:underline")}>
                  {count(awaitingDecision.count)}
                </Link>
              ) : (
                "0"
              )
            }
          >
            {awaitingDecision.oldestReceivedAt ? `Still New · oldest received ${when(awaitingDecision.oldestReceivedAt)}` : "None in the Alert queue"}
          </Figure>
          <Figure
            label="Dismissal rate"
            value={alerts.dismissalRate === null ? "—" : `${Math.round(alerts.dismissalRate * 100)}%`}
          >
            {count(alerts.dismissed)} dismissed · {count(alerts.attached)} attached to Cases, of {count(alerts.received)} received in the last {metrics.days} days
          </Figure>
        </div>
        <div className="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-2">
          <AlertVolume perDay={alerts.perDay} />
          <Dismissals alerts={alerts} />
        </div>
      </Group>
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`group-${title}`} className="grid gap-3">
      <h2 id={`group-${title}`} className="text-base font-medium">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Figure({ label, value, children }: { label: string; value: ReactNode; children: ReactNode }) {
  return (
    <Card size="sm" role="group" aria-label={label}>
      <CardContent className="grid gap-1">
        <h3 className="text-sm text-muted-foreground">{label}</h3>
        <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{children}</p>
      </CardContent>
    </Card>
  );
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="min-w-0 gap-4">
      <CardHeader>
        <CardTitle>
          <h3>{title}</h3>
        </CardTitle>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}

/** A chart with a button that shows its values as a table instead. */
function useTableToggle() {
  const [asTable, setAsTable] = useState(false);
  const toggle = (
    <Button variant="ghost" size="xs" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
      {asTable ? "Show chart" : "Show table"}
    </Button>
  );
  return { asTable, toggle };
}

/**
 * Which point of a chart is being read: hovered with the pointer, or stepped through with the arrow
 * keys (Home and End jump to the ends) once the chart has focus.
 */
function useReading(length: number) {
  const [reading, setReading] = useState<number | null>(null);
  const keys = (e: KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    const at = reading ?? length - 1;
    if (step) setReading(Math.min(length - 1, Math.max(0, at + step)));
    else if (e.key === "Home") setReading(0);
    else if (e.key === "End") setReading(length - 1);
    else if (e.key === "Escape") setReading(null);
    else return;
    e.preventDefault();
  };
  const props = {
    tabIndex: 0,
    role: "group",
    onKeyDown: keys,
    onFocus: () => setReading((r) => r ?? length - 1),
    onBlur: () => setReading(null),
    onMouseLeave: () => setReading(null),
  };
  return { reading, setReading, props };
}

/** The rendered width of an element, so a chart can be drawn at its real size and its text stays 12px. */
function useWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width] as const;
}

const cases = (n: number) => (n === 1 ? "Case" : "Cases");

/** A count that opens the Case list filtered to it; a zero opens nothing, so it isn't a link. */
function CountLink({ n, label, search }: { n: number; label: string; search: { severity?: Severity; status?: OpenStatus } }) {
  if (n === 0) return <span className="block px-1 text-muted-foreground">0</span>;
  return (
    <Link to="/" search={{ view: "open", ...search }} className={cn(focusRing, "block px-1 underline-offset-4 hover:underline")} aria-label={label}>
      {count(n)}
    </Link>
  );
}

/**
 * Each count links to the Case list filtered to it. Unassigned Critical Cases still in New are the one
 * thing here that needs someone now, so that cell says so in the overdue treatment.
 */
function OpenCasesTable({ openCases }: { openCases: DashboardMetrics["openCases"] }) {
  const cell = "text-center tabular-nums";
  const statusTotal = (status: OpenStatus) => SEVERITIES.reduce((sum, s) => sum + openCases.bySeverity[s][status], 0);
  const waiting = openCases.unassignedBySeverity.critical.new;
  return (
    <Panel title="Open Cases by Severity and Status">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
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
                  <TableHead scope="row" aria-label={severityLabel[severity]}>
                    <SeverityBadge severity={severity} />
                  </TableHead>
                  {OPEN_STATUSES.map((status) => {
                    const alarm = severity === "critical" && status === "new" && waiting > 0;
                    return (
                      <TableCell key={status} className={cell}>
                        <CountLink
                          n={row[status]}
                          search={{ severity, status }}
                          label={`${count(row[status])} ${severityLabel[severity]} ${cases(row[status])}, ${statusLabel[status]}`}
                        />
                        {alarm && (
                          <Badge asChild variant="outline" className="mt-1 border-overdue-border text-overdue">
                            <Link
                              to="/"
                              search={{ view: "unassigned", severity: "critical", status: "new" }}
                              className={focusRing}
                              aria-label={`${count(waiting)} Critical ${cases(waiting)} in New with no Assignee`}
                            >
                              {count(waiting)} unassigned
                            </Link>
                          </Badge>
                        )}
                      </TableCell>
                    );
                  })}
                  <TableCell className={cn(cell, "font-semibold")}>
                    <CountLink n={total} search={{ severity }} label={`${count(total)} open ${severityLabel[severity]} ${cases(total)}`} />
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
                  <CountLink
                    n={statusTotal(status)}
                    search={{ status }}
                    label={`${count(statusTotal(status))} open ${cases(statusTotal(status))}, ${statusLabel[status]}`}
                  />
                </TableCell>
              ))}
              <TableCell className={cn(cell, "font-semibold")}>
                <CountLink n={openCases.total} search={{}} label={`${count(openCases.total)} open ${cases(openCases.total)}`} />
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </Panel>
  );
}

/** A small table of a chart's values: visible when asked for, otherwise for screen readers only. */
function ValuesTable({ caption, head, rows, visible }: { caption: string; head: string[]; rows: string[][]; visible: boolean }) {
  if (visible)
    return (
      <div className="max-h-72 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {head.map((h, i) => (
                <TableHead key={h} className={cn(i > 0 && "text-right")}>
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(([first, ...rest]) => (
              <TableRow key={first}>
                <TableHead scope="row" className="font-normal text-foreground">
                  {first}
                </TableHead>
                {rest.map((v, i) => (
                  <TableCell key={i} className="text-right tabular-nums">
                    {v}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([first, ...rest]) => (
          <tr key={first}>
            <th scope="row">{first}</th>
            {rest.map((v, i) => (
              <td key={i}>{v}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One bar per day, today last; zero days keep a stub so they read as zero, not missing. */
function AlertVolume({ perDay }: { perDay: DashboardMetrics["alerts"]["perDay"] }) {
  const { asTable, toggle } = useTableToggle();
  const { reading, setReading, props } = useReading(perDay.length);
  const max = Math.max(1, ...perDay.map((d) => d.count));
  const shown = reading === null ? null : perDay[reading]!;
  const isToday = (i: number) => i === perDay.length - 1;
  const dayLabel = (i: number) => (isToday(i) ? "Today" : shortDate(perDay[i]!.date));
  if (perDay.every((d) => d.count === 0))
    return (
      <Panel title="Alerts received per day">
        <p className="text-sm text-muted-foreground">No Alerts received in this period.</p>
      </Panel>
    );
  return (
    <Panel title="Alerts received per day" action={toggle}>
      {!asTable && (
        <div
          {...props}
          aria-label="Alerts received per day. Use the arrow keys to read each day."
          aria-describedby="alert-volume-reading"
          className={cn(focusRing, "relative")}
        >
          <p id="alert-volume-reading" className="h-5 text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {shown
              ? `${dayLabel(reading!)}${isToday(reading!) ? " so far" : ""}: ${plural(shown.count, "Alert", "Alerts")}`
              : `Most in a day: ${count(max)}`}
          </p>
          <div className={cn("flex h-44 items-end border-b border-border", perDay.length > 30 ? "gap-px" : "gap-0.5")} aria-hidden>
            {perDay.map((d, i) => (
              <div key={d.date} className="flex h-full min-w-0 flex-1 items-end" onMouseEnter={() => setReading(i)} data-testid="alert-volume-bar">
                <div
                  className={cn(
                    "w-full rounded-t-sm",
                    d.count ? "bg-(--series-1)" : "bg-muted-foreground/40",
                    reading !== null && reading !== i && "opacity-60",
                  )}
                  style={{ height: d.count ? `max(2px, ${(d.count / max) * 100}%)` : 2 }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-muted-foreground" aria-hidden>
            <span>{shortDate(perDay[0]!.date)}</span>
            <span>Today</span>
          </div>
        </div>
      )}
      <ValuesTable
        visible={asTable}
        caption="Alerts received per day"
        head={["Day", "Alerts"]}
        rows={perDay.map((d, i) => [dayLabel(i), count(d.count)])}
      />
    </Panel>
  );
}

/** Whole percentages that add up to 100 (largest remainder), so the rows never read 99% or 101%. */
function wholeShares(counts: number[]) {
  const total = counts.reduce((sum, n) => sum + n, 0);
  const exact = counts.map((n) => (n / total) * 100);
  const shares = exact.map(Math.floor);
  const order = exact.map((v, i) => [v - Math.floor(v), i] as const).toSorted((a, b) => b[0] - a[0]);
  for (let left = 100 - shares.reduce((sum, n) => sum + n, 0), k = 0; left > 0; left--, k++) shares[order[k]![1]]! += 1;
  return shares;
}

function Dismissals({ alerts }: { alerts: DashboardMetrics["alerts"] }) {
  const counts = DISMISSAL_REASONS.map((reason) => alerts.dismissalsByReason[reason]);
  const shares = alerts.dismissed ? wholeShares(counts) : [];
  return (
    <Panel title="Dismissals by Dismissal Reason">
      {alerts.dismissed === 0 ? (
        <p className="text-sm text-muted-foreground">No Alerts received in this period have been dismissed.</p>
      ) : (
        <dl className="grid gap-3">
          {DISMISSAL_REASONS.map((reason, i) => (
            <div key={reason} className="grid grid-cols-[7rem_1fr_5.5rem] items-center gap-3 text-sm">
              <dt>{dismissalReasonLabel[reason]}</dt>
              <div className="h-3.5 rounded-sm bg-muted" aria-hidden>
                <div className="h-full rounded-sm bg-(--series-1)" style={{ width: `${(counts[i]! / alerts.dismissed) * 100}%` }} />
              </div>
              <dd className="text-right tabular-nums">
                {count(counts[i]!)} <span className="text-muted-foreground">({shares[i]}%)</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Panel>
  );
}

const TREND_H = 224;
const PAD = { top: 12, right: 12, bottom: 24, left: 48 };
const DAY_MS = 86_400_000;

/**
 * Mean times per day or week as two lines on a time axis from the start of the period to now, so the
 * current, partial stretch sits where it falls. Drawn at its real width, so its text stays 12px.
 */
function Trend({ metrics }: { metrics: DashboardMetrics }) {
  const { asTable, toggle } = useTableToggle();
  const [box, width] = useWidth<HTMLDivElement>();
  const points = metrics.trend;
  const { reading, setReading, props } = useReading(points.length);
  const stretch = metrics.days === 7 ? "day" : "week";
  const title = `Mean time to acknowledge and close, per ${stretch}`;
  const values = points.flatMap((p) => [p.meanTimeToAcknowledgeMs, p.meanTimeToCloseMs]).filter((v): v is number => v !== null);
  const series = [
    { key: "meanTimeToAcknowledgeMs", label: "Time to acknowledge", color: "var(--series-1)", dash: undefined },
    { key: "meanTimeToCloseMs", label: "Time to close", color: "var(--series-2)", dash: "6 4" },
  ] as const;

  const fromMs = Date.parse(metrics.from);
  const toMs = Date.parse(metrics.to);
  const stretchMs = (stretch === "day" ? 1 : 7) * DAY_MS;
  const startOf = (i: number) => Date.parse(points[i]!.from);
  const endOf = (i: number) => Math.min(startOf(i) + stretchMs, toMs);
  const partial = (i: number) => startOf(i) + stretchMs > toMs;
  const pointLabel = (i: number) =>
    `${stretch === "day" ? (i === points.length - 1 ? "Today" : shortDate(points[i]!.from)) : `Week of ${shortDate(points[i]!.from)}`}${partial(i) ? " so far" : ""}`;
  const rows = points.map((p, i) => [pointLabel(i), formatDuration(p.meanTimeToAcknowledgeMs), formatDuration(p.meanTimeToCloseMs)]);
  const table = (
    <ValuesTable visible={asTable} caption={title} head={[stretch === "day" ? "Day" : "Week", "Time to acknowledge", "Time to close"]} rows={rows} />
  );

  if (!values.length)
    return (
      <Panel title={title}>
        <p className="text-sm text-muted-foreground">No Cases were acknowledged or closed in this period.</p>
      </Panel>
    );

  const W = Math.max(width, 240);
  const axis = niceAxis(Math.max(...values));
  const plotW = W - PAD.left - PAD.right;
  const plotH = TREND_H - PAD.top - PAD.bottom;
  const x = (ms: number) => PAD.left + ((ms - fromMs) / Math.max(1, toMs - fromMs)) * plotW;
  const mid = (i: number) => x((startOf(i) + endOf(i)) / 2);
  const y = (v: number) => PAD.top + plotH - (v / axis.max) * plotH;
  const ticks = [0, axis.max / 2, axis.max];
  const tickLabel = (t: number) => (t === 0 ? "0" : `${t / axis.unit} ${axis.unitLabel}`);
  const shown = reading === null ? null : points[reading]!;
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
      d += `${pen ? "L" : "M"}${mid(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  return (
    <Panel title={title} action={toggle}>
      {!asTable && (
        <div className="grid gap-2">
          <ul className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <svg width="20" height="4" aria-hidden>
                  <line x1="0" x2="20" y1="2" y2="2" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} />
                </svg>
                {s.label}
              </li>
            ))}
          </ul>
          <div
            {...props}
            ref={box}
            aria-label={`${title}. Use the arrow keys to read each ${stretch}.`}
            aria-describedby="trend-reading"
            className={focusRing}
          >
            <p id="trend-reading" className="h-5 text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {shown
                ? `${pointLabel(reading!)}: acknowledge ${formatDuration(shown.meanTimeToAcknowledgeMs)} · close ${formatDuration(shown.meanTimeToCloseMs)}`
                : `Mean per ${stretch}`}
            </p>
            {width > 0 && (
              <svg width={W} height={TREND_H} className="block" aria-hidden>
                {ticks.map((t) => (
                  <g key={t}>
                    <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
                    <text x={PAD.left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-xs">
                      {tickLabel(t)}
                    </text>
                  </g>
                ))}
                <text x={PAD.left} y={TREND_H - 6} className="fill-muted-foreground text-xs">
                  {shortDate(metrics.from)}
                </text>
                <text x={W - PAD.right} y={TREND_H - 6} textAnchor="end" className="fill-muted-foreground text-xs">
                  Today
                </text>
                {reading !== null && (
                  <line x1={mid(reading)} x2={mid(reading)} y1={PAD.top} y2={PAD.top + plotH} className="stroke-muted-foreground" strokeWidth={1} />
                )}
                {series.map((s) => (
                  <g key={s.key}>
                    <path
                      d={path(s.key)}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={2}
                      strokeDasharray={s.dash}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                    {points.map((p, i) => {
                      const v = p[s.key];
                      return v === null ? null : (
                        <circle key={i} cx={mid(i)} cy={y(v)} r={reading === i ? 5 : 3.5} fill={s.color} className="stroke-card" strokeWidth={2} />
                      );
                    })}
                  </g>
                ))}
                {points.map((p, i) => (
                  <rect
                    key={p.from}
                    x={x(startOf(i))}
                    y={PAD.top}
                    width={Math.max(0, x(endOf(i)) - x(startOf(i)))}
                    height={plotH}
                    fill="transparent"
                    onMouseEnter={() => setReading(i)}
                  />
                ))}
              </svg>
            )}
            {width === 0 && <div style={{ height: TREND_H }} />}
          </div>
        </div>
      )}
      {table}
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
