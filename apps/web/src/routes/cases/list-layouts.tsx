import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, ListChecksIcon, LockIcon, SirenIcon, UsersIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { SeverityBadge, StatusBadge } from "@/components/case-badges";
import { PersonAvatar } from "@/components/presence-avatars";
import { Time } from "@/components/time";
import { InternalBadge } from "@/components/visibility";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { api } from "@/lib/api";
import { caseAlertsQuery } from "@/lib/alerts";
import { caseQuery, caseRef, caseTypeLabel, SEVERITIES, severityLabel, type Status, statusLabel, summaryText } from "@/lib/cases";
import { discussionQuery, messageParts } from "@/lib/discussion";
import { type TaskView, tasksQuery } from "@/lib/tasks";
import { tagLabel } from "@/lib/tags";
import { cn } from "@/lib/utils";

type ListBody = Awaited<ReturnType<Awaited<ReturnType<typeof api.cases.$get>>["json"]>>;
/** One Case as the Cases list returns it. */
export type CaseRow = Extract<ListBody, { cases: unknown }>["cases"][number];

export const CASE_LAYOUTS = ["table", "cards", "board", "split"] as const;
export type CaseLayout = (typeof CASE_LAYOUTS)[number];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A flat card: a hairline ring on the page, no shadow (DESIGN.md, Elevation). */
const cardClass =
  "group/case flex min-w-0 flex-col rounded-xl bg-card text-sm ring-1 ring-foreground/10 outline-none transition-colors duration-700 hover:bg-muted/40 hover:ring-foreground/20 focus-visible:ring-2 focus-visible:ring-ring";

function OverdueBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <Badge variant="outline" className="border-overdue-border text-overdue">
      {count} overdue
    </Badge>
  );
}

function AccessBadges({ c }: { c: CaseRow }) {
  return (
    <>
      {c.restricted && (
        <Badge variant="outline" className="text-muted-foreground">
          <LockIcon aria-hidden />
          Restricted
        </Badge>
      )}
      {c.guests !== null && c.guests > 0 && (
        <Badge variant="outline" className="text-muted-foreground" title="Guests from outside the Organization can see this Case">
          <UsersIcon aria-hidden />
          {plural(c.guests, "Guest", "Guests")}
        </Badge>
      )}
    </>
  );
}

function Assignee({ c }: { c: CaseRow }) {
  if (!c.assignee) return <span className="text-muted-foreground">Unassigned</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={c.assignee.name}>
      <PersonAvatar person={c.assignee} />
      <span className="truncate">{c.assignee.name}</span>
    </span>
  );
}

function Counts({ c }: { c: CaseRow }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-3 text-xs text-muted-foreground tabular-nums">
      {c.alerts > 0 && (
        <span className="flex items-center gap-1" title={plural(c.alerts, "Alert", "Alerts")}>
          <SirenIcon className="size-3.5" aria-hidden />
          <span className="sr-only">Alerts: </span>
          {c.alerts}
        </span>
      )}
      {c.tasks.total > 0 && (
        <span className="flex items-center gap-1" title={`${c.tasks.done} of ${plural(c.tasks.total, "Task", "Tasks")} done`}>
          <ListChecksIcon className="size-3.5" aria-hidden />
          <span className="sr-only">Tasks done: </span>
          {c.tasks.done}/{c.tasks.total}
        </span>
      )}
    </span>
  );
}

/**
 * One Case as a card: what it is and how urgent at the top, the title, then who has it and how far
 * along it is. `compact` cards (Board, Split) leave out the Case Type and Tags.
 */
function CaseCard({
  c,
  compact = false,
  severity = true,
  status = true,
  changed,
  selected,
  onSelect,
  onOpen,
}: {
  c: CaseRow;
  compact?: boolean;
  severity?: boolean;
  status?: boolean;
  changed: boolean;
  /** Split only: picking the card shows it in the preview rather than opening it. */
  selected?: boolean;
  onSelect?: () => void;
  onOpen?: () => void;
}) {
  const pad = compact ? "px-3" : "px-4";
  const body = (
    <>
      <span className={cn("flex min-h-5 flex-wrap items-center gap-1.5 pt-3", pad)}>
        <span className="font-mono text-xs text-muted-foreground">{caseRef(c.number)}</span>
        {severity && <SeverityBadge severity={c.severity} short={compact} />}
        <OverdueBadge count={c.overdueTasks} />
        {!compact && <AccessBadges c={c} />}
        <Time iso={c.updatedAt} className="ml-auto text-xs whitespace-nowrap text-muted-foreground" />
      </span>
      <span className={cn("mt-1.5 line-clamp-2 font-medium group-hover/case:underline", pad)}>{c.title}</span>
      {compact ? (
        (c.restricted || (c.guests ?? 0) > 0) && (
          <span className={cn("mt-1.5 flex flex-wrap gap-1.5", pad)}>
            <AccessBadges c={c} />
          </span>
        )
      ) : (
        <span className={cn("mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground", pad)}>
          {caseTypeLabel[c.caseType]}
          {c.tags.map((t) => (
            <Badge key={t} variant="secondary">
              {tagLabel(t)}
            </Badge>
          ))}
        </span>
      )}
      <span className={cn("mt-auto flex items-center gap-2 border-t pt-2.5 pb-3 text-xs", compact ? "mt-3" : "mt-4", pad)}>
        {status && <StatusBadge status={c.status} resolution={c.resolution} />}
        <Assignee c={c} />
        <Counts c={c} />
      </span>
    </>
  );
  const className = cn(cardClass, changed && "bg-muted duration-0", selected && "ring-2 ring-foreground hover:bg-card hover:ring-foreground");
  if (onSelect) {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onOpen?.();
      }
    };
    return (
      <Link
        to="."
        search={(prev) => ({ ...prev, preview: c.number })}
        replace
        resetScroll={false}
        data-case-link
        aria-current={selected ? "true" : undefined}
        className={className}
        onFocus={onSelect}
        onKeyDown={onKeyDown}
      >
        {body}
      </Link>
    );
  }
  return (
    <Link to="/cases/$number" params={{ number: String(c.number) }} data-case-link className={className}>
      {body}
    </Link>
  );
}

function CardSkeletons({ count, className }: { count: number; className?: string }) {
  return (
    <div className={className} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="grid gap-2 rounded-xl p-4 ring-1 ring-foreground/10">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/** Cards: every Case as a card, grouped by Severity, most severe first. */
export function CaseCards({ rows, justChanged }: { rows: CaseRow[] | undefined; justChanged: Set<number> }) {
  const grid = "grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-3";
  if (!rows) return <CardSkeletons count={6} className={grid} />;
  return (
    <div className="grid gap-7">
      {SEVERITIES.map((s) => {
        const group = rows.filter((c) => c.severity === s);
        if (!group.length) return null;
        return (
          <section key={s} aria-label={`${severityLabel[s]} Severity`} className="grid gap-2.5">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <SeverityBadge severity={s} />
              <span className="font-normal text-muted-foreground tabular-nums">{group.length}</span>
            </h2>
            <div className={grid}>
              {group.map((c) => (
                <CaseCard key={c.number} c={c} severity={false} changed={justChanged.has(c.number)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Board: a column for each Status, the Cases in it as compact cards. */
export function CaseBoard({ rows, statuses, justChanged }: { rows: CaseRow[] | undefined; statuses: readonly Status[]; justChanged: Set<number> }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-2">
      <div className="grid auto-cols-[minmax(13rem,1fr)] grid-flow-col items-start gap-3">
        {statuses.map((s) => {
          const column = rows?.filter((c) => c.status === s);
          return (
            <section key={s} aria-label={statusLabel[s]} className="grid content-start gap-2">
              <h2 className="flex items-center gap-2 border-b px-0.5 pb-2 text-sm font-medium">
                {statusLabel[s]}
                {column && <span className="font-normal text-muted-foreground tabular-nums">{column.length}</span>}
              </h2>
              {!column ? (
                <CardSkeletons count={2} className="grid gap-2" />
              ) : column.length ? (
                column.map((c) => <CaseCard key={c.number} c={c} compact status={false} changed={justChanged.has(c.number)} />)
              ) : (
                <p className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">No Cases</p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Split: the Cases as a list of compact cards beside a preview of the one picked. */
export function CaseSplit({
  rows,
  preview,
  onPreview,
  onOpen,
  justChanged,
}: {
  rows: CaseRow[] | undefined;
  preview: number | undefined;
  onPreview: (number: number) => void;
  onOpen: (number: number) => void;
  justChanged: Set<number>;
}) {
  if (!rows) return <CardSkeletons count={4} className="grid gap-2 lg:w-96" />;
  const shown = rows.find((c) => c.number === preview) ?? rows[0];
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
      <div className="grid gap-2" role="list" aria-label="Cases">
        {rows.map((c) => (
          <div role="listitem" key={c.number} className="grid">
            <CaseCard
              c={c}
              compact
              changed={justChanged.has(c.number)}
              selected={c.number === shown?.number}
              onSelect={() => onPreview(c.number)}
              onOpen={() => onOpen(c.number)}
            />
          </div>
        ))}
      </div>
      {shown && <CasePreview key={shown.number} row={shown} />}
    </div>
  );
}

const byUrgency = (a: TaskView, b: TaskView) =>
  Number(b.overdue) - Number(a.overdue) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");

function PreviewSection({ title, count, action, children }: { title: string; count?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid content-start gap-2">
      <h3 className="flex items-center gap-2 font-medium">
        {title}
        {count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
        {action && <span className="ml-auto">{action}</span>}
      </h3>
      {children}
    </section>
  );
}

const sectionLink = (to: "/cases/$number/tasks" | "/cases/$number/timeline", number: number, label: string) => (
  <Button variant="link" size="xs" className="h-auto px-0" asChild>
    <Link to={to} params={{ number: String(number) }}>
      {label}
    </Link>
  </Button>
);

/** The picked Case at a glance: its details, Case Summary, open Tasks, Alerts and the latest of its Discussion. */
function CasePreview({ row }: { row: CaseRow }) {
  const number = row.number;
  const c = useQuery(caseQuery(number));
  const tasks = useQuery(tasksQuery(number));
  const alerts = useQuery(caseAlertsQuery(number));
  const discussion = useQuery(discussionQuery(number));
  const open = (tasks.data ?? []).filter((t) => !t.done).toSorted(byUrgency);
  const summary = c.data ? summaryText(c.data.summary.content).trim() : "";
  const latest = (discussion.data ?? []).filter((m) => m.body !== null).slice(-2).toReversed();
  return (
    <article aria-label={`Preview of ${caseRef(number)}`} className="@container sticky top-20 grid gap-5 rounded-xl p-5 ring-1 ring-foreground/10">
      <header className="flex flex-wrap items-start gap-3">
        <div className="grid min-w-0 flex-1 gap-1.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs text-muted-foreground">{caseRef(number)}</span>
            <SeverityBadge severity={row.severity} />
            <OverdueBadge count={row.overdueTasks} />
            <AccessBadges c={row} />
          </span>
          <h2 className="text-xl font-semibold tracking-tight">{row.title}</h2>
        </div>
        <Button variant="outline" asChild>
          <Link to="/cases/$number" params={{ number: String(number) }}>
            Open Case
            <ArrowUpRightIcon aria-hidden />
          </Link>
        </Button>
      </header>
      <dl className="grid grid-cols-2 gap-4 border-y py-4 sm:grid-cols-4">
        <div className="grid gap-1">
          <dt className="text-xs text-muted-foreground">Status</dt>
          <dd>
            <StatusBadge status={row.status} resolution={row.resolution} />
          </dd>
        </div>
        <div className="grid gap-1">
          <dt className="text-xs text-muted-foreground">Case Type</dt>
          <dd>{caseTypeLabel[row.caseType]}</dd>
        </div>
        <div className="grid min-w-0 gap-1">
          <dt className="text-xs text-muted-foreground">Assignee</dt>
          <dd className="flex min-w-0">
            <Assignee c={row} />
          </dd>
        </div>
        <div className="grid gap-1">
          <dt className="text-xs text-muted-foreground">Updated</dt>
          <dd className="text-muted-foreground">
            <Time iso={row.updatedAt} />
          </dd>
        </div>
      </dl>
      <div className="grid gap-6 @4xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          <PreviewSection title="Case Summary">
            {c.isPending ? (
              <Skeleton className="h-12 w-full" />
            ) : summary ? (
              <p className="line-clamp-6 max-w-[75ch] whitespace-pre-line">{summary}</p>
            ) : (
              <p className="text-muted-foreground">Nothing written yet.</p>
            )}
          </PreviewSection>
          <PreviewSection title="Open Tasks" count={`${row.tasks.done}/${row.tasks.total} done`} action={sectionLink("/cases/$number/tasks", number, "All Tasks")}>
            {tasks.isPending ? (
              <Skeleton className="h-16 w-full" />
            ) : open.length ? (
              <ul className="divide-y border-y" aria-label="Open Tasks">
                {open.slice(0, 5).map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="flex min-w-40 flex-1 items-center gap-2">
                      <span>{t.title}</span>
                      {t.internal && <InternalBadge />}
                    </span>
                    <span className="text-xs text-muted-foreground">{t.owner.name}</span>
                    {t.overdue ? (
                      <Badge variant="outline" className="border-overdue-border text-overdue tabular-nums">
                        Overdue · {t.dueDate}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground tabular-nums">{t.dueDate ? `Due ${t.dueDate}` : "No due date"}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No open Tasks.</p>
            )}
          </PreviewSection>
        </div>
        <div className="grid content-start gap-6">
          <PreviewSection title="Alerts" count={alerts.data?.length}>
            {alerts.isPending ? (
              <Skeleton className="h-10 w-full" />
            ) : alerts.data?.length ? (
              <ul className="divide-y border-y" aria-label="Attached Alerts">
                {alerts.data.slice(0, 5).map((a) => (
                  <li key={a.id} className="flex items-center gap-2 py-2">
                    <SeverityBadge severity={a.severity} short />
                    <span className="min-w-0 flex-1 truncate" title={a.title}>
                      {a.title}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{a.externalId}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No Alerts attached.</p>
            )}
          </PreviewSection>
          <PreviewSection title="Latest in the Discussion" action={sectionLink("/cases/$number/timeline", number, "Timeline & Discussion")}>
            {discussion.isPending ? (
              <Skeleton className="h-12 w-full" />
            ) : latest.length ? (
              <ul className="grid gap-3" aria-label="Latest messages">
                {latest.map((m) => (
                  <li key={m.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
                    <PersonAvatar person={m.author} />
                    <div className="grid gap-0.5">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{m.author.name}</span>
                        <Time iso={m.postedAt} className="text-xs text-muted-foreground" />
                        {m.internal && <InternalBadge />}
                      </span>
                      <p className="line-clamp-3 whitespace-pre-wrap">
                        {messageParts(m.body ?? "", m.mentions).map((part, i) =>
                          typeof part === "string" ? (
                            part
                          ) : (
                            <span key={i} className="rounded bg-mention px-0.5 font-medium text-mention-foreground">
                              @{part.name}
                            </span>
                          ),
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No messages yet.</p>
            )}
          </PreviewSection>
        </div>
      </div>
    </article>
  );
}
