import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, LockIcon, UsersIcon } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import { SeverityBadge, StatusBadge } from "@/components/case-badges";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/filter-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import {
  CASE_TYPES,
  type CaseType,
  caseRef,
  caseTypeLabel,
  casesKey,
  SEVERITIES,
  type Severity,
  severityLabel,
  STATUSES,
  type Status,
  statusLabel,
} from "@/lib/cases";
import { normaliseTag, tagLabel, tagsInUseQuery } from "@/lib/tags";
import { cn } from "@/lib/utils";
import { useJustChanged } from "@/lib/use-just-changed";
import { exactTime, when } from "@/lib/when";
import { OpenCaseDialog } from "@/routes/cases/open-case-dialog";

/**
 * Columns shown only once the list is wide enough; below that their facts sit under the Title. Their
 * cells stay in the row, emptied and without padding, so every column keeps its set width.
 */
const wide = "overflow-hidden px-0 @6xl:px-2";
/** The content of a `wide` cell, shown only when its column is. */
const wideContent = "hidden @6xl:inline";
export const CASE_VIEWS = ["mine", "unassigned", "open", "closed"] as const;
export type CaseListView = (typeof CASE_VIEWS)[number];
const ACCESS = ["restricted", "guests"] as const;
type Access = (typeof ACCESS)[number];
const SORTS = ["updated", "severity", "number"] as const;
type Sort = (typeof SORTS)[number];
type Order = "asc" | "desc";
export type CaseListSearch = {
  view?: CaseListView;
  status?: Status;
  severity?: Severity;
  caseType?: CaseType;
  tag?: string;
  access?: Access;
  sort?: Sort;
  order?: Order;
};

const pick = <T extends string>(list: readonly T[], value: unknown) => (list.includes(value as T) ? (value as T) : undefined);

/** Reads the list's view, filters and sort from the URL, ignoring anything unknown. */
export const validateCaseListSearch = (search: Record<string, unknown>): CaseListSearch => ({
  view: pick(CASE_VIEWS, search.view),
  status: pick(STATUSES, search.status),
  severity: pick(SEVERITIES, search.severity),
  caseType: pick(CASE_TYPES, search.caseType),
  tag: typeof search.tag === "string" ? (normaliseTag(search.tag) ?? undefined) : undefined,
  access: pick(ACCESS, search.access),
  sort: pick(SORTS, search.sort),
  order: pick(["asc", "desc"] as const, search.order),
});

const viewLabel: Record<CaseListView, string> = { mine: "My Cases", unassigned: "Unassigned", open: "All open", closed: "Closed" };
const accessLabel: Record<Access, string> = { restricted: "Restricted", guests: "With Guests" };
const sortLabel: Record<Sort, string> = { updated: "last change", severity: "Severity", number: "Case number" };
/** Statuses a Case in the open views can have; the Closed view has only one. */
const OPEN_STATUSES = STATUSES.filter((s) => s !== "closed");
const FILTERS = ["status", "severity", "caseType", "tag", "access"] as const;
const noFilters = { status: undefined, severity: undefined, caseType: undefined, tag: undefined, access: undefined };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** j and k move between the Cases in the list, Enter opens the one in focus. */
function useRowKeys(table: React.RefObject<HTMLTableElement | null>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || (e.key !== "j" && e.key !== "k")) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      const links = [...(table.current?.querySelectorAll<HTMLAnchorElement>("a[data-case-link]") ?? [])];
      if (links.length === 0) return;
      const at = links.indexOf(document.activeElement as HTMLAnchorElement);
      const next = at === -1 ? 0 : Math.min(Math.max(at + (e.key === "j" ? 1 : -1), 0), links.length - 1);
      e.preventDefault();
      links[next]?.focus();
      links[next]?.closest("tr")?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [table]);
}

export function CasesPage() {
  const search = useSearch({ from: "/_app/" });
  const navigate = useNavigate({ from: "/" });
  const view = search.view ?? "mine";
  const sort = search.sort ?? "updated";
  const order = search.order ?? "desc";
  const setSearch = (next: Partial<CaseListSearch>) => navigate({ search: (prev) => ({ ...prev, ...next }) });
  const filtered = FILTERS.some((f) => search[f] !== undefined);
  const table = useRef<HTMLTableElement>(null);
  useRowKeys(table);

  const cases = useQuery({
    queryKey: [...casesKey, { ...search, view }],
    queryFn: async () => {
      const res = await api.cases.$get({ query: { ...search, view } });
      if (!res.ok) throw new Error(`The server answered ${res.status}`);
      return res.json();
    },
  });
  const rows = cases.data?.cases;
  const counts = cases.data?.counts;
  const justChanged = useJustChanged(rows);
  const tagsInUse = useQuery(tagsInUseQuery);
  const tagOptions = [...new Set([...(tagsInUse.data?.map((t) => t.tag) ?? []), ...(search.tag ? [search.tag] : [])])].toSorted();
  const tagLabels = Object.fromEntries(tagOptions.map((t) => [t, tagLabel(t)]));

  /** Clicking a column sorts by it, newest or most severe first; clicking it again reverses. */
  const sortBy = (column: Sort) => {
    const nextOrder: Order = column === sort && order === "desc" ? "asc" : "desc";
    setSearch({ sort: column === "updated" ? undefined : column, order: nextOrder === "desc" ? undefined : nextOrder });
  };
  const sortable = (column: Sort, label: string) => {
    const active = sort === column;
    const Icon = !active ? ChevronsUpDownIcon : order === "desc" ? ArrowDownIcon : ArrowUpIcon;
    return {
      "aria-sort": active ? (order === "desc" ? "descending" : "ascending") : undefined,
      children: (
        <button
          type="button"
          onClick={() => sortBy(column)}
          className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {label}
          <Icon className={cn("size-3.5", !active && "text-muted-foreground")} aria-hidden />
        </button>
      ),
    } as const;
  };

  const openCase = (number: number) => navigate({ to: "/cases/$number", params: { number: String(number) } });
  const shown = rows?.length ?? 0;
  const total = counts?.[view] ?? 0;

  return (
    <div className="grid w-full grid-cols-1 max-w-page gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Cases</h1>
        <OpenCaseDialog />
      </div>
      <div className="grid gap-3">
        <Tabs value={view} activationMode="manual">
          <TabsList variant="line" aria-label="Case views" className="w-full justify-start overflow-x-auto overflow-y-hidden border-b">
            {CASE_VIEWS.map((v) => (
              <TabsTrigger key={v} value={v} className="flex-none" asChild>
                <Link to="/" search={{ ...search, view: v, status: v === "closed" || search.status === "closed" ? undefined : search.status }}>
                  {viewLabel[v]}
                  {counts && <span className="text-xs text-muted-foreground tabular-nums">{` ${counts[v]}`}</span>}
                </Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <FilterBar onClear={filtered ? () => setSearch(noFilters) : undefined}>
          {view !== "closed" && (
            <FilterSelect label="Status" id="filter-status" any="Any" value={search.status} options={search.status === "closed" ? STATUSES : OPEN_STATUSES} labels={statusLabel} onChange={(status) => setSearch({ status })} />
          )}
          <FilterSelect label="Severity" id="filter-severity" any="Any" value={search.severity} options={SEVERITIES} labels={severityLabel} onChange={(severity) => setSearch({ severity })} />
          <FilterSelect label="Case Type" id="filter-type" any="Any" value={search.caseType} options={CASE_TYPES} labels={caseTypeLabel} onChange={(caseType) => setSearch({ caseType })} />
          <FilterSelect label="Tag" id="filter-tag" any="Any" value={search.tag} options={tagOptions} labels={tagLabels} onChange={(tag) => setSearch({ tag })} />
          <FilterSelect label="Access" id="filter-access" any="Any" value={search.access} options={ACCESS} labels={accessLabel} onChange={(access) => setSearch({ access })} />
        </FilterBar>
      </div>

      {cases.isError && (
        <Alert variant="destructive">
          <AlertTitle>Cases couldn't be loaded</AlertTitle>
          <AlertDescription>
            {rows
              ? "The list below may be out of date. Try again, or reload the page."
              : "No Cases are shown because the list didn't load, not because there are none. Try again, or reload the page."}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" disabled={cases.isFetching} onClick={() => cases.refetch()}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      )}

      {!(cases.isError && !rows) && (
        // Wider lists give Case Type, Alerts and Opened columns of their own rather than stretching the Title.
        <Card className="@container py-0">
          <Table ref={table} className="@4xl:table-fixed">
            {/* Set widths, so the columns stay put from one view, filter or sort to the next; the Title takes the rest. */}
            <colgroup>
              <col className="@4xl:w-20" />
              <col className="@4xl:w-28" />
              <col />
              <col className="@4xl:w-0 @6xl:w-36" />
              <col className="@4xl:w-44" />
              <col className="@4xl:w-52" />
              <col className="@4xl:w-0 @6xl:w-20" />
              <col className="@4xl:w-0 @6xl:w-28" />
              <col className="@4xl:w-28" />
            </colgroup>
            <TableCaption className="sr-only">
              {`${viewLabel[view]}, ${filtered ? "filtered, " : ""}sorted by ${sortLabel[sort]}, ${order === "desc" ? "descending" : "ascending"}`}
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className="w-20 pl-4" {...sortable("number", "Case")} />
                <TableHead scope="col" className="w-28" {...sortable("severity", "Severity")} />
                <TableHead scope="col">Title</TableHead>
                <TableHead scope="col" className={wide}><span className={wideContent}>Case Type</span></TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Assignee</TableHead>
                <TableHead scope="col" className={cn(wide, "text-right")}><span className={wideContent}>Alerts</span></TableHead>
                <TableHead scope="col" className={wide}><span className={wideContent}>Opened</span></TableHead>
                <TableHead scope="col" className="pr-4" {...sortable("updated", "Updated")} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {cases.isPending &&
                Array.from({ length: 6 }, (_, i) => (
                  <TableRow key={i} className="hover:bg-transparent" aria-hidden>
                    <TableCell className="pl-4"><Skeleton className="h-4 w-10" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-64" /></TableCell>
                    <TableCell className={wide}><Skeleton className="hidden h-4 w-20 @6xl:block" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell className={wide}><Skeleton className="ml-auto hidden h-4 w-6 @6xl:block" /></TableCell>
                    <TableCell className={wide}><Skeleton className="hidden h-4 w-14 @6xl:block" /></TableCell>
                    <TableCell className="pr-4"><Skeleton className="h-4 w-14" /></TableCell>
                  </TableRow>
                ))}
              {cases.isPending && (
                <TableRow className="sr-only">
                  <TableCell colSpan={9} role="status">Loading Cases…</TableCell>
                </TableRow>
              )}
              {rows?.map((c) => (
                <TableRow
                  key={c.number}
                  className={cn(
                    "cursor-pointer [&>td]:align-baseline transition-colors duration-700 focus-within:bg-muted/50",
                    justChanged.has(c.number) && "bg-muted duration-0",
                  )}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a, button") || window.getSelection()?.toString()) return;
                    openCase(c.number);
                  }}
                >
                  <TableCell className="pl-4 font-mono text-xs text-muted-foreground">{caseRef(c.number)}</TableCell>
                  <TableCell>
                    <SeverityBadge severity={c.severity} />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <Link
                      to="/cases/$number"
                      params={{ number: String(c.number) }}
                      data-case-link
                      className="rounded-sm font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {c.title}
                    </Link>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      {c.restricted && (
                        <Badge variant="outline">
                          <LockIcon aria-hidden />
                          Restricted
                        </Badge>
                      )}
                      {c.guests !== null && c.guests > 0 && (
                        <Badge variant="outline" title="Guests from outside the Organization can see this Case">
                          <UsersIcon aria-hidden />
                          {plural(c.guests, "Guest", "Guests")}
                        </Badge>
                      )}
                      <span className="@6xl:hidden">{caseTypeLabel[c.caseType]}</span>
                      {c.alerts > 0 && <span className="@6xl:hidden">{plural(c.alerts, "Alert", "Alerts")}</span>}
                      {c.tags.map((t) => (
                        <Badge key={t} variant="secondary">
                          {tagLabel(t)}
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className={cn(wide, "truncate")}><span className={wideContent}>{caseTypeLabel[c.caseType]}</span></TableCell>
                  <TableCell>
                    <StatusBadge status={c.status} resolution={c.resolution} />
                  </TableCell>
                  <TableCell className={cn("truncate", !c.assignee && "text-muted-foreground")} title={c.assignee?.name}>
                    {c.assignee?.name ?? "Unassigned"}
                  </TableCell>
                  <TableCell className={cn(wide, "text-right tabular-nums", !c.alerts && "text-muted-foreground")}>
                    <span className={wideContent}>{c.alerts}</span>
                  </TableCell>
                  <TableCell className={cn(wide, "text-muted-foreground tabular-nums")} title={exactTime(c.openedAt)}>
                    <span className={wideContent}>{when(c.openedAt)}</span>
                  </TableCell>
                  <TableCell className="pr-4 text-muted-foreground tabular-nums" title={exactTime(c.updatedAt)}>
                    {when(c.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
              {rows?.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={9} className="py-10 text-center whitespace-normal">
                    <EmptyState view={view} filtered={filtered} unassigned={counts?.unassigned ?? 0} onClear={() => setSearch(noFilters)} />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      {rows && rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <p role="status">
            {total > shown
              ? `Showing the first ${shown} of ${total} Cases. Narrow the filters to see the rest.`
              : plural(shown, "Case", "Cases")}
          </p>
          <p>
            <kbd className="font-sans font-medium text-foreground">j</kbd> and <kbd className="font-sans font-medium text-foreground">k</kbd> move between
            Cases, <kbd className="font-sans font-medium text-foreground">Enter</kbd> opens one
          </p>
        </div>
      )}
    </div>
  );
}

/** What an empty list means here, and where to go next. */
function EmptyState({ view, filtered, unassigned, onClear }: { view: CaseListView; filtered: boolean; unassigned: number; onClear: () => void }) {
  if (filtered) {
    return (
      <div className="grid justify-items-center gap-2">
        <p className="font-medium">No Cases match these filters</p>
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      </div>
    );
  }
  const message: Record<CaseListView, { title: string; next?: React.ReactNode }> = {
    mine: {
      title: "No open Cases are assigned to you",
      next:
        unassigned > 0 ? (
          <Link to="/" search={{ view: "unassigned" }} className="underline underline-offset-4 hover:text-foreground">
            {`See ${plural(unassigned, "Unassigned Case", "Unassigned Cases")}`}
          </Link>
        ) : undefined,
    },
    unassigned: { title: "Every open Case has an Assignee" },
    open: {
      title: "No open Cases",
      next: (
        <Fragment>
          Open one with Open Case, or from the{" "}
          <Link to="/alerts" className="underline underline-offset-4 hover:text-foreground">
            Alert queue
          </Link>
          .
        </Fragment>
      ),
    },
    closed: { title: "No Cases have been Closed yet" },
  };
  const { title, next } = message[view];
  return (
    <div className="grid justify-items-center gap-1">
      <p className="font-medium">{title}</p>
      {next && <p className="text-muted-foreground">{next}</p>}
    </div>
  );
}
