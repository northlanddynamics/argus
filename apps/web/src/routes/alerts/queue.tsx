import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/page-header";
import { AlertMenu } from "@/components/alert-menu";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CaseRef } from "@/components/case-ref";
import { Time } from "@/components/time";
import { SeverityBadge } from "@/components/case-badges";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FilterBar, FilterField, FilterSelect } from "@/components/filter-bar";
import { ItemContext } from "@/components/item-context";
import { ItemLink } from "@/components/item-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ALERT_STATUSES,
  type AlertKind,
  alertKindLabel,
  alertsKey,
  type AlertStatus,
  alertStatusLabel,
  dismissalReasonLabel,
  healthWord,
  integrationsQuery,
} from "@/lib/alerts";
import { endAlertDrag, startAlertDrag } from "@/lib/alert-drag";
import { api } from "@/lib/api";
import { type CaseType, caseRef, SEVERITIES, type Severity, severityLabel } from "@/lib/cases";
import { cn } from "@/lib/utils";
import { AttachAlertsDialog, attachAlerts, type BulkOutcome, DismissAlertsDialog, OpenCaseFromAlertsDialog } from "@/routes/alerts/alert-dialogs";
import { AlertDetails } from "@/routes/alerts/alert-details";

/**
 * `status` is New unless the URL says otherwise; "any" shows every Status. `falconComplete` shows the
 * Alerts tagged falcon_complete in Falcon, hidden unless it says "show" or "only". `page` is which page
 * of the queue, from 1. `alert` is the Alert shown in full. `case` keeps to the Alerts attached to
 * the Case with that number.
 */
export type AlertQueueSearch = {
  status?: AlertStatus | "any";
  severity?: Severity;
  integration?: string;
  case?: number;
  falconComplete?: "show" | "only";
  page?: number;
  alert?: string;
};

/** How the queue treats Alerts handled by Falcon Complete; hiding them is the default. */
const FALCON_COMPLETE_CHOICES = ["hide", "show", "only"] as const;
const falconCompleteLabel = { hide: "Hidden", show: "Shown", only: "Only these" } as const;

const pick = <T extends string>(list: readonly T[], value: unknown) => (list.includes(value as T) ? (value as T) : undefined);

/** Reads the queue's filters from the URL, ignoring anything unknown. */
export const validateAlertQueueSearch = (search: Record<string, unknown>): AlertQueueSearch => ({
  status: pick([...ALERT_STATUSES, "any"] as const, search.status),
  severity: pick(SEVERITIES, search.severity),
  integration: typeof search.integration === "string" && search.integration ? search.integration : undefined,
  case: caseNumberOf(search.case),
  falconComplete: pick(["show", "only"] as const, search.falconComplete),
  page: Number.isInteger(Number(search.page)) && Number(search.page) > 1 ? Number(search.page) : undefined,
  alert: typeof search.alert === "string" && search.alert ? search.alert : undefined,
});

/** The Case number in "C-1041", "c-1041" or "1041", if it is one. */
function caseNumberOf(value: unknown): number | undefined {
  const match = /^\s*(?:c-?)?(\d+)\s*$/i.exec(String(value ?? ""));
  const n = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Alerts on a page of the queue. */
const PAGE_SIZE = 50;

type BulkKind = "open" | "attach" | "dismiss";
/** An Alert as the Member saw it when they picked it for an action. */
type Picked = { version: number; severity: Severity; kind: AlertKind; externalId: string; title: string };
type AlertRow = { id: string } & Picked;
const pickedOf = (a: AlertRow): Picked => ({ version: a.version, severity: a.severity, kind: a.kind, externalId: a.externalId, title: a.title });
/** The Case Type a Case opened from an Alert of each kind most often is; the Member can change it. */
const caseTypeFor: Record<AlertKind, CaseType> = { epp: "malware", idp: "account_compromise", mobile: "malware" };
const shortcut = { o: "open", a: "attach", d: "dismiss" } as const;
const noFilters = { status: undefined, severity: undefined, integration: undefined, case: undefined, falconComplete: undefined };
/**
 * Host / user and Received give way when the queue is narrow (the Alert panel is open). Their cells
 * stay in the row, emptied and without padding, so the cells after them keep their columns.
 */
const narrowHidden = "overflow-hidden px-0 @3xl:px-2";

/**
 * Keyboard triage: j and k move between Alerts, x selects the one in focus, Escape closes the
 * Alert panel, and with Alerts selected o, a and d open a Case, attach or dismiss them.
 */
function useQueueKeys(
  table: React.RefObject<HTMLTableElement | null>,
  on: { toggle: (id: string) => void; act: (kind: BulkKind) => void; close: (() => void) | null },
) {
  const handlers = useRef(on);
  useEffect(() => {
    handlers.current = on;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input:not([type=checkbox]), textarea, select, [contenteditable=true], [role=dialog]")) return;
      const titles = [...(table.current?.querySelectorAll<HTMLButtonElement>("button[data-alert-title]") ?? [])];
      const row = target?.closest<HTMLElement>("tr[data-alert-id]");
      if (e.key === "j" || e.key === "k") {
        if (!titles.length) return;
        const at = row ? titles.findIndex((b) => b.closest("tr") === row) : -1;
        const next = at === -1 ? 0 : Math.min(Math.max(at + (e.key === "j" ? 1 : -1), 0), titles.length - 1);
        e.preventDefault();
        titles[next]?.focus();
        titles[next]?.closest("tr")?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "x" && row) {
        e.preventDefault();
        handlers.current.toggle(row.dataset.alertId!);
      } else if (e.key === "Escape" && handlers.current.close) {
        e.preventDefault();
        handlers.current.close();
      } else if (e.key in shortcut) {
        e.preventDefault();
        handlers.current.act(shortcut[e.key as keyof typeof shortcut]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [table]);
}

/** The Alert queue: Alerts from the Organization's Integrations, newest first, refreshing live. */
export function AlertQueuePage() {
  const search = useSearch({ from: "/_app/alerts" });
  const navigate = useNavigate({ from: "/alerts" });
  const status = search.status ?? "new";
  const page = search.page ?? 1;
  const setSearch = (next: Partial<AlertQueueSearch>) => navigate({ search: (prev) => ({ ...prev, ...next }) });

  const integrations = useQuery(integrationsQuery);
  /** The Integrations that bring in Alerts; others (Response Actions only) have no place in the queue. */
  const streams = integrations.data?.filter((i) => i.capabilities.receivesAlerts);
  const alerts = useQuery({
    // Not keyed on the Alert shown in the panel: opening one mustn't reload the queue.
    queryKey: [...alertsKey, { status, severity: search.severity, integration: search.integration, case: search.case, falconComplete: search.falconComplete, page }],
    queryFn: async () => {
      const res = await api.alerts.$get({
        query: {
          ...(status !== "any" && { status }),
          severity: search.severity,
          integration: search.integration,
          case: search.case === undefined ? undefined : String(search.case),
          falconComplete: search.falconComplete,
          page: String(page),
          pageSize: String(PAGE_SIZE),
        },
      });
      // A Case that doesn't exist, or that the Member can't see, has no Alerts to show.
      if (res.status === 404 && search.case !== undefined) return { alerts: [], total: 0, page, pageSize: PAGE_SIZE };
      if (!res.ok) throw new Error("Could not load Alerts");
      return res.json();
    },
    // Moving between pages keeps the last one in place until the next arrives.
    placeholderData: keepPreviousData,
  });
  const total = alerts.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const first = (page - 1) * PAGE_SIZE + 1;
  /** Row indexes are per page, so a shift-click range never starts from a row on another one. */
  const toPage = (p: number) => {
    anchor.current = null;
    void setSearch({ page: p > 1 ? p : undefined });
  };
  // Acting on the last page's Alerts can leave it empty: go back to the last page that has any.
  const pastTheEnd = !alerts.isPlaceholderData && !!alerts.data && alerts.data.alerts.length === 0 && page > 1;
  useEffect(() => {
    if (pastTheEnd) void navigate({ search: (prev) => ({ ...prev, page: pages > 1 ? pages : undefined }), replace: true });
  }, [pastTheEnd, pages, navigate]);

  /** Selected Alerts: id → the Alert as shown when it was selected, so changes since are caught. */
  const [selected, setSelected] = useState<Map<string, Picked>>(new Map());
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const showing = search.alert ?? null;
  const setShowing = (alert: string | null) => setSearch({ alert: alert ?? undefined });
  const filtered =
    status !== "new" || search.severity !== undefined || search.integration !== undefined || search.case !== undefined || search.falconComplete !== undefined;
  /**
   * Changes the filters, starting again from the first page; the last action's notice is about Alerts
   * that may no longer be shown, so it goes.
   */
  const filter = (next: Partial<AlertQueueSearch>) => {
    setOutcome(null);
    setSearch({ ...next, page: undefined });
  };
  /** The bulk action being confirmed, and the Alerts it acts on: the selection, or the one in the panel. */
  // Kept after the dialog closes (`open` false): its outcome arrives then, and is told about these Alerts.
  const [dialog, setDialog] = useState<{ kind: BulkKind; picked: Map<string, Picked>; open: boolean } | null>(null);
  const closeDialog = (open: boolean) => !open && setDialog((d) => d && { ...d, open: false });
  /** Set when an action has finished: its controls are gone, so focus goes to its notice rather than back to them. */
  const justDone = useRef(false);
  const afterDialog = (event: Event) => {
    if (!justDone.current) return;
    justDone.current = false;
    event.preventDefault();
    document.getElementById("alert-outcome")?.focus();
  };
  const table = useRef<HTMLTableElement>(null);
  /** The row last checked or unchecked, where a shift-click range starts. */
  const anchor = useRef<number | null>(null);

  const loaded = alerts.data?.alerts;
  const rows = loaded ?? [];
  /** Integrations that aren't bringing Alerts in: paused, disconnected or in error. */
  const unhealthy = streams?.filter((i) => i.paused || i.health === "error" || i.health === "disconnected") ?? [];
  const allSelected = rows.length > 0 && rows.every((a) => selected.has(a.id));
  /** Selected Alerts this page doesn't show: on other pages, or not matching the filters. */
  const hiddenSelected = [...selected.keys()].filter((id) => !rows.some((a) => a.id === id)).length;
  const setPicked = (list: readonly AlertRow[], on: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev);
      for (const a of list) {
        if (on) next.set(a.id, pickedOf(a));
        else next.delete(a.id);
      }
      return next;
    });
  /** Checks or unchecks the Alert in row `index`; with Shift, every row from the last one checked. */
  const check = (index: number, on: boolean, range: boolean) => {
    const from = range && anchor.current !== null ? Math.min(anchor.current, index) : index;
    const to = range && anchor.current !== null ? Math.max(anchor.current, index) : index;
    setPicked(rows.slice(from, to + 1), on);
    anchor.current = index;
  };
  const act = (kind: BulkKind, picked = selected) => {
    if (picked.size) setDialog({ kind, picked, open: true });
  };
  const dialogSelection = [...(dialog?.picked ?? [])].map(([id, p]) => ({ id, version: p.version }));
  const dialogPicked = [...(dialog?.picked.values() ?? [])];
  const highest = SEVERITIES.find((s) => dialogPicked.some((p) => p.severity === s)) ?? "medium";
  // The most serious Alert names the Case to start with.
  const lead = dialogPicked.find((p) => p.severity === highest);
  const suggested = {
    title: lead ? (dialogPicked.length > 1 ? `${lead.title} and ${dialogPicked.length - 1} more` : lead.title) : "",
    caseType: lead ? caseTypeFor[lead.kind] : ("malware" as const),
  };
  /** Reports what an action on the `known` Alerts did, and takes them out of the selection. */
  const finish = (known: Map<string, Picked>, result: BulkOutcome) => {
    // Name each refused Alert as the Member saw it, even one the server no longer shows them.
    const refused = result.refused.map((r) => ({ ...r, externalId: r.externalId ?? known.get(r.id)?.externalId ?? null, title: r.title ?? known.get(r.id)?.title ?? null }));
    setOutcome({ ...result, refused });
    justDone.current = true;
    setSelected((prev) => {
      const next = new Map(prev);
      for (const id of known.keys()) next.delete(id);
      return next;
    });
  };
  const done = (result: BulkOutcome) => finish(dialog?.picked ?? new Map(), result);

  const queryClient = useQueryClient();
  /** Alerts dropped on a Case in the work queue are attached to it straight away. */
  const dropAttach = useMutation({
    mutationFn: ({ number, picked }: { number: number; picked: Map<string, Picked> }) =>
      attachAlerts(number, [...picked].map(([id, p]) => ({ id, version: p.version }))),
    onSuccess: async (result, { number, picked }) => {
      await queryClient.invalidateQueries({ queryKey: alertsKey });
      const verb = `attached to ${caseRef(number)}`;
      if (result.refused.length) {
        // Some were refused: the notice says which and why, and offers to select them again.
        finish(picked, { ...result, verb });
        justDone.current = false;
        requestAnimationFrame(() => document.getElementById("alert-outcome")?.focus());
        return;
      }
      setOutcome(null);
      setSelected((prev) => new Map([...prev].filter(([id]) => !picked.has(id))));
      toast(`${alertCount(result.applied.length)} ${verb}`);
    },
    onError: (error) => toast.error(error.message),
  });
  /**
   * Dragging a row carries the selection when the row is in it, and only that Alert otherwise.
   * Dropping it on a Case in the work queue attaches them.
   */
  const dragStart = (event: React.DragEvent, a: AlertRow) => {
    const picked = selected.has(a.id) ? selected : new Map([[a.id, pickedOf(a)]]);
    startAlertDrag(event, { count: picked.size, drop: (number) => dropAttach.mutate({ number, picked }) });
  };
  /** Selects the refused Alerts again, as they are now. */
  const reselect = () => {
    if (!outcome) return;
    const refused = new Set(outcome.refused.map((r) => r.id));
    setSelected(new Map(rows.filter((a) => refused.has(a.id)).map((a) => [a.id, pickedOf(a)])));
    setOutcome(null);
  };
  const closePanel = () => {
    const id = showing;
    setShowing(null);
    // Back to the row it was opened from, so j and k carry on from there.
    requestAnimationFrame(() => table.current?.querySelector<HTMLButtonElement>(`button[data-alert-title="${id}"]`)?.focus());
  };
  useQueueKeys(table, {
    toggle: (id) => {
      const index = rows.findIndex((a) => a.id === id);
      if (index !== -1) check(index, !selected.has(id), false);
    },
    act: (kind) => act(kind),
    close: showing ? closePanel : null,
  });

  return (
    <div className="grid w-full grid-cols-1 gap-4">
      <PageHeader
        title="Alerts"
        description={
          <ul aria-label="Integrations">
            {streams?.map((i) => (
              <li key={i.id}>
                {i.name}: {healthWord(i)}, {i.lastEventAt ? <Time iso={i.lastEventAt} prefix="last event" /> : "no events yet"}
              </li>
            ))}
            {streams?.length === 0 && (
              <li>
                No Integrations yet: an Admin adds one in{" "}
                <Link to="/settings/integrations" className="underline underline-offset-4 hover:text-foreground">
                  Settings
                </Link>
                .
              </li>
            )}
          </ul>
        }
      />
      {unhealthy.length > 0 && (
        <Alert variant="notice">
          <AlertTitle>
            {unhealthy.length === 1 ? `${unhealthy[0]!.name} isn't bringing in Alerts` : `${unhealthy.length} Integrations aren't bringing in Alerts`}
          </AlertTitle>
          <AlertDescription>
            <ul>
              {unhealthy.map((i) => (
                <li key={i.id}>
                  {i.name}: {healthWord(i)}
                  {i.healthDetail && ` (${i.healthDetail})`}
                  {i.lastEventAt ? (
                    <>
                      , <Time iso={i.lastEventAt} prefix="last event" />
                    </>
                  ) : (
                    ", no events yet"
                  )}
                  .
                </li>
              ))}
            </ul>
            <p>
              New detections may be missing from the queue until it's running again. An Admin can check it in{" "}
              <Link to="/settings/integrations" className="underline underline-offset-4">
                Settings
              </Link>
              .
            </p>
          </AlertDescription>
        </Alert>
      )}
      <FilterBar onClear={filtered ? () => filter(noFilters) : undefined}>
        <FilterSelect
          label="Alert Status"
          id="alert-status"
          value={status}
          options={[...ALERT_STATUSES, "any"] as const}
          labels={{ ...alertStatusLabel, any: "Any" }}
          onChange={(next) => filter({ status: next === "new" ? undefined : next })}
        />
        <FilterSelect
          label="Severity"
          id="alert-severity"
          any="Any"
          value={search.severity}
          options={SEVERITIES}
          labels={severityLabel}
          onChange={(severity) => filter({ severity })}
        />
        {((streams?.length ?? 0) > 1 || search.integration) && (
          <FilterSelect
            label="Integration"
            id="alert-integration"
            any="Any"
            value={search.integration}
            options={streams?.map((i) => i.id) ?? []}
            labels={Object.fromEntries(streams?.map((i) => [i.id, i.name]) ?? [])}
            onChange={(integration) => filter({ integration })}
          />
        )}
        <CaseFilter
          value={search.case}
          // Only Attached Alerts are on a Case: the New ones the queue starts with would show nothing.
          onChange={(next) => filter({ case: next, ...(next !== undefined && status === "new" && { status: "attached" }) })}
        />
        <FilterSelect
          label="Falcon Complete"
          id="alert-falcon-complete"
          value={search.falconComplete ?? "hide"}
          options={FALCON_COMPLETE_CHOICES}
          labels={falconCompleteLabel}
          onChange={(next) => filter({ falconComplete: next === "hide" ? undefined : next })}
        />
      </FilterBar>
      {outcome && <OutcomeNotice outcome={outcome} onReselect={reselect} onDismiss={() => setOutcome(null)} />}
      <OpenCaseFromAlertsDialog
        open={dialog?.open === true && dialog.kind === "open"}
        onOpenChange={closeDialog}
        onCloseAutoFocus={afterDialog}
        selection={dialogSelection}
        highest={highest}
        suggested={suggested}
        onDone={done}
      />
      <AttachAlertsDialog open={dialog?.open === true && dialog.kind === "attach"} onOpenChange={closeDialog} onCloseAutoFocus={afterDialog} selection={dialogSelection} onDone={done} />
      <DismissAlertsDialog open={dialog?.open === true && dialog.kind === "dismiss"} onOpenChange={closeDialog} onCloseAutoFocus={afterDialog} selection={dialogSelection} onDone={done} />
      {alerts.isError && (
        <Alert variant="destructive">
          <AlertTitle>Alerts couldn't be loaded</AlertTitle>
          <AlertDescription>
            {loaded
              ? "The queue below may be out of date. Try again, or reload the page."
              : "Try again, or reload the page."}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" disabled={alerts.isFetching} onClick={() => alerts.refetch()}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      )}
      {/* The Alert panel takes two fifths of the page beside the queue, never less than 26rem. */}
      <div className={cn("grid items-start gap-4", showing && "@4xl:grid-cols-[minmax(0,3fr)_minmax(26rem,2fr)]")}>
      {!(alerts.isError && !loaded) && (
      <Card className="@container py-0">
          <Table ref={table} className="table-fixed" aria-busy={alerts.isPlaceholderData}>
            {/* Column widths live here, so the header row can turn into the selection toolbar without moving them. */}
            <colgroup>
              <col className="w-10" />
              <col className="w-28 @7xl:w-[8.75%]" />
              <col />
              <col className="w-0 @3xl:w-40 @7xl:w-[12.5%]" />
              <col className="w-0 @3xl:w-36 @7xl:w-[11.25%]" />
              <col className="w-32 @7xl:w-[10%]" />
            </colgroup>
            <TableHeader>
              <TableRow variant="static" data-state={selected.size > 0 ? "selected" : undefined}>
                <TableHead scope="col" className="pl-4">
                  <Checkbox
                    aria-label="Select all Alerts shown"
                    checked={allSelected}
                    onCheckedChange={() => setPicked(rows, !allSelected)}
                  />
                </TableHead>
                {selected.size > 0 ? (
                  // While Alerts are selected, the header row holds what can be done with them.
                  <TableHead colSpan={5} className="pr-4">
                    <div role="toolbar" aria-label="Selected Alerts" className="flex items-center gap-2">
                      <span className="mr-1 font-medium tabular-nums">
                        {selected.size} selected
                        {hiddenSelected > 0 && <span className="font-normal text-muted-foreground">{` · ${hiddenSelected} not shown here`}</span>}
                      </span>
                      <Button size="sm" onClick={() => act("open")}>
                        Open Case
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => act("attach")}>
                        Attach to Case…
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => act("dismiss")}>
                        Dismiss…
                      </Button>
                      <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Map())}>
                        Clear selection
                      </Button>
                    </div>
                  </TableHead>
                ) : (
                  <>
                    <TableHead scope="col">Severity</TableHead>
                    <TableHead scope="col">Alert</TableHead>
                    <TableHead scope="col" className={narrowHidden}><span className="hidden @3xl:inline">Host / user</span></TableHead>
                    <TableHead scope="col" className={narrowHidden}><span className="hidden @3xl:inline">Received</span></TableHead>
                    <TableHead scope="col" className="pr-4">Alert Status</TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {alerts.isPending &&
                Array.from({ length: 8 }, (_, i) => (
                  <TableRow key={i} variant="static" aria-hidden>
                    <TableCell className="pl-4"><Skeleton className="size-4" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-4/5" /></TableCell>
                    <TableCell className={narrowHidden}><Skeleton className="hidden h-4 w-24 @3xl:block" /></TableCell>
                    <TableCell className={narrowHidden}><Skeleton className="hidden h-4 w-16 @3xl:block" /></TableCell>
                    <TableCell className="pr-4"><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
                  </TableRow>
                ))}
              {alerts.isPending && (
                <TableRow className="sr-only">
                  <TableCell colSpan={6} role="status">Loading Alerts…</TableCell>
                </TableRow>
              )}
              {loaded?.map((a, index) => (
                <AlertMenu key={a.id} falconUrl={a.falconUrl}>
                <TableRow
                  key={a.id}
                  data-testid={`alert-${a.externalId}`}
                  data-alert-id={a.id}
                  data-state={selected.has(a.id) ? "selected" : undefined}
                  draggable
                  onDragStart={(e) => dragStart(e, a)}
                  onDragEnd={endAlertDrag}
                  aria-current={showing === a.id || undefined}
                >
                  <TableCell className="pl-4">
                    <Checkbox
                      aria-label={`Select ${a.externalId}`}
                      checked={selected.has(a.id)}
                      onClick={(e) => {
                        e.preventDefault();
                        check(index, !selected.has(a.id), e.shiftKey);
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <SeverityBadge severity={a.severity} />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      data-alert-title={a.id}
                      aria-current={showing === a.id ? "true" : undefined}
                      className="block max-w-full truncate rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                      title={a.title}
                      onClick={() => setShowing(a.id)}
                    >
                      {a.title}
                    </button>
                    <div className="truncate text-xs text-muted-foreground">
                      <span className="font-mono">{a.externalId}</span> · {alertKindLabel[a.kind]}
                      {(streams?.length ?? 0) > 1 && ` · ${a.integration.name}`}
                      <span className="@3xl:hidden">
                        {(a.host ?? a.userName) && " · "}
                        <span className="font-mono">{[a.host, a.userName].filter(Boolean).join(" / ")}</span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className={cn(narrowHidden, "font-mono text-xs")}>
                    <div className="hidden @3xl:block">
                    <div className="truncate" title={a.host ?? undefined}>
                      {a.host === null ? (
                        <span className="font-sans text-muted-foreground">No host</span>
                      ) : a.hostAsset ? (
                        <ItemContext item={{ kind: "asset", id: a.hostAsset.id, type: "host", value: a.host }}>
                          <ItemLink kind="asset" id={a.hostAsset.id} className="hover:underline" aria-label={`Host ${a.host}`}>
                            {a.host}
                          </ItemLink>
                        </ItemContext>
                      ) : (
                        a.host
                      )}
                    </div>
                    {a.userName && (
                      <div className="truncate text-muted-foreground" title={a.userName}>
                        {a.userAsset ? (
                          <ItemContext item={{ kind: "asset", id: a.userAsset.id, type: "account", value: a.userName }}>
                            <ItemLink kind="asset" id={a.userAsset.id} className="hover:underline" aria-label={`Account ${a.userName}`}>
                              {a.userName}
                            </ItemLink>
                          </ItemContext>
                        ) : (
                          a.userName
                        )}
                      </div>
                    )}
                    </div>
                  </TableCell>
                  <TableCell className={cn(narrowHidden, "truncate text-muted-foreground")}>
                    <span className="hidden @3xl:inline"><Time iso={a.receivedAt} /></span>
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant="outline">{alertStatusLabel[a.status]}</Badge>
                      {a.falconComplete && (
                        <Badge variant="secondary" title="Tagged falcon_complete in Falcon: handled by CrowdStrike's managed service">
                          Falcon Complete
                        </Badge>
                      )}
                      {a.case && (
                        <CaseRef number={a.case.number} title={a.case.title} />
                      )}
                    </div>
                    {a.correlation && (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        Related{" "}
                        <CaseRef number={a.correlation.case.number} title={a.correlation.case.title} />
                        {a.correlation.others > 0 && ` +${a.correlation.others} more`}
                      </div>
                    )}
                    {a.dismissalReason && (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">{dismissalReasonLabel[a.dismissalReason]}</div>
                    )}
                  </TableCell>
                </TableRow>
                </AlertMenu>
              ))}
              {loaded?.length === 0 && (
                <TableRow variant="static">
                  <TableCell colSpan={6} className="py-10 text-center whitespace-normal">
                    {filtered ? (
                      <div className="grid justify-items-center gap-2">
                        <p className="font-medium">No Alerts match these filters</p>
                        <Button variant="outline" size="sm" onClick={() => filter(noFilters)}>
                          Show New Alerts
                        </Button>
                      </div>
                    ) : (
                      <div className="grid justify-items-center gap-1">
                        <p className="font-medium">No New Alerts</p>
                        <p className="text-muted-foreground">
                          {streams?.length
                            ? "New detections appear here as they arrive."
                            : "Alerts arrive here once an Admin adds an Integration."}
                        </p>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
      </Card>
      )}
      {showing && <AlertPanel id={showing} onClose={closePanel} onAct={(kind, a) => act(kind, new Map([[a.id, pickedOf(a)]]))} />}
      </div>
      {loaded && loaded.length > 0 && pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => toPage(page - 1)}>
            <ChevronLeftIcon /> Newer
          </Button>
          <span className="text-sm text-muted-foreground tabular-nums">
            Page {page} of {pages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => toPage(page + 1)}>
            Older <ChevronRightIcon />
          </Button>
        </nav>
      )}
      {loaded && loaded.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <p role="status" className="tabular-nums">
          {pages > 1 ? `${first}–${first + loaded.length - 1} of ` : ""}
          {total} {status === "any" ? "" : `${alertStatusLabel[status]} `}
          {total === 1 ? "Alert" : "Alerts"}
          {search.case !== undefined && ` on ${caseRef(search.case)}`}
          {pages > 1 && ", newest first"}
        </p>
        <p>
          <Key>j</Key> <Key>k</Key> move · <Key>x</Key> selects · <Key>Enter</Key> opens · <Key>Esc</Key> closes · with Alerts selected,{" "}
          <Key>o</Key> opens a Case, <Key>a</Key> attaches, <Key>d</Key> dismisses · drag Alerts onto a Case in the work queue to attach them
        </p>
        </div>
      )}
    </div>
  );
}

/** The Case filter: a Case reference, applied on Enter or on leaving the field. */
function CaseFilter({ value, onChange }: { value: number | undefined; onChange: (value: number | undefined) => void }) {
  const shown = value === undefined ? "" : caseRef(value);
  const [draft, setDraft] = useState(shown);
  // Follows the URL when it changes elsewhere: Clear, Back, or a link from a Case.
  const [was, setWas] = useState(shown);
  if (was !== shown) {
    setWas(shown);
    setDraft(shown);
  }
  const invalid = draft.trim() !== "" && caseNumberOf(draft) === undefined;
  const apply = () => {
    if (invalid) return;
    const next = caseNumberOf(draft);
    setDraft(next === undefined ? "" : caseRef(next));
    if (next !== value) onChange(next);
  };
  return (
    <FilterField label="Attached to" htmlFor="alert-case">
      <Input
        id="alert-case"
        type="search"
        inputMode="text"
        autoComplete="off"
        placeholder="C-1041"
        aria-invalid={invalid || undefined}
        title={invalid ? "A Case reference, like C-1041" : undefined}
        className="h-7 w-24 font-mono text-xs md:text-xs"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
          else if (e.key === "Escape") setDraft(shown);
        }}
      />
    </FilterField>
  );
}

const alertCount = (n: number) => `${n} ${n === 1 ? "Alert" : "Alerts"}`;

const Key = ({ children }: { children: string }) => <kbd className="font-sans font-medium text-foreground">{children}</kbd>;

/** After a bulk action: how many Alerts it applied to, and each one it refused and why. */
function OutcomeNotice({ outcome, onReselect, onDismiss }: { outcome: BulkOutcome; onReselect: () => void; onDismiss: () => void }) {
  const total = outcome.applied.length + outcome.refused.length;
  if (!outcome.refused.length) {
    return (
      <Alert role="status" id="alert-outcome" tabIndex={-1}>
        <AlertTitle>
          {alertCount(outcome.applied.length)} {outcome.verb}
        </AlertTitle>
        <AlertAction>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Close
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return (
    <Alert
      role="status"
      id="alert-outcome"
      tabIndex={-1}
      variant="notice"
    >
      <AlertTitle>
        {outcome.refused.length} of {alertCount(total)} {outcome.refused.length === 1 ? "was" : "were"} not {outcome.verb}
      </AlertTitle>
      <AlertDescription className="grid gap-2">
        <ul className="text-sm">
          {outcome.refused.map((r) => (
            <li key={r.id}>
              {r.title && <span className="font-medium">{r.title} </span>}
              <span className="font-mono text-xs">({r.externalId ?? r.id})</span> {r.detail}
            </li>
          ))}
        </ul>
        {outcome.note && <p className="text-sm">{outcome.note}</p>}
        {outcome.applied.length > 0 && (
          <p className="text-sm">
            The other {outcome.applied.length} {outcome.applied.length === 1 ? "was" : "were"} {outcome.verb}.
          </p>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onReselect}>
            Select {outcome.refused.length === 1 ? "it" : `these ${outcome.refused.length}`} again
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Close
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** The Alert in full beside the queue, staying in view while the queue scrolls and scrolling on its own when it runs longer than the window. */
function AlertPanel({ id, onClose, onAct }: { id: string; onClose: () => void; onAct: (kind: BulkKind, alert: AlertRow) => void }) {
  return (
    <Card role="region" aria-label="Alert" className="self-start @4xl:sticky @4xl:top-18 @4xl:max-h-[calc(100svh-5.5rem)] @4xl:overflow-y-auto">
      <CardContent>
        <AlertDetails id={id} onClose={onClose} onAct={onAct} />
      </CardContent>
    </Card>
  );
}
