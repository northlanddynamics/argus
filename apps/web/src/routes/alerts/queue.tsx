import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IpHoverCard } from "@/components/ip-details";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CaseRef } from "@/components/case-ref";
import { Time } from "@/components/time";
import { SeverityBadge, StatusBadge } from "@/components/case-badges";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FilterBar, FilterSelect } from "@/components/filter-bar";
import { ItemLink } from "@/components/item-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ago,
  ALERT_STATUSES,
  type AlertKind,
  alertKindLabel,
  type AlertCorrelation,
  alertCorrelationsQuery,
  type AlertDetail,
  alertQuery,
  alertsKey,
  type AlertStatus,
  alertStatusLabel,
  dismissalReasonLabel,
  falconStatusLabel,
  healthWord,
  integrationsQuery,
} from "@/lib/alerts";
import { api } from "@/lib/api";
import { type CaseType, caseRef, SEVERITIES, type Severity, severityLabel } from "@/lib/cases";
import { assetTypeLabel, type ItemKind, observableTypeLabel, shownObservable } from "@/lib/observables";
import { cn } from "@/lib/utils";
import { exactTime } from "@/lib/when";
import {
  AttachAlertsDialog,
  type BulkOutcome,
  DismissAlertsDialog,
  MoveAlertDialog,
  OpenCaseFromAlertsDialog,
} from "@/routes/alerts/alert-dialogs";

/** `status` is New unless the URL says otherwise; "any" shows every Status. `alert` is the Alert shown in full. */
export type AlertQueueSearch = { status?: AlertStatus | "any"; severity?: Severity; integration?: string; alert?: string };

const pick = <T extends string>(list: readonly T[], value: unknown) => (list.includes(value as T) ? (value as T) : undefined);

/** Reads the queue's filters from the URL, ignoring anything unknown. */
export const validateAlertQueueSearch = (search: Record<string, unknown>): AlertQueueSearch => ({
  status: pick([...ALERT_STATUSES, "any"] as const, search.status),
  severity: pick(SEVERITIES, search.severity),
  integration: typeof search.integration === "string" && search.integration ? search.integration : undefined,
  alert: typeof search.alert === "string" && search.alert ? search.alert : undefined,
});

/** When an Alert arrived, compactly: "Nov 3, 14:02". */

type BulkKind = "open" | "attach" | "dismiss";
/** An Alert as the Member saw it when they picked it for an action. */
type Picked = { version: number; severity: Severity; kind: AlertKind; externalId: string; title: string };
type AlertRow = { id: string } & Picked;
const pickedOf = (a: AlertRow): Picked => ({ version: a.version, severity: a.severity, kind: a.kind, externalId: a.externalId, title: a.title });
/** The Case Type a Case opened from an Alert of each kind most often is; the Member can change it. */
const caseTypeFor: Record<AlertKind, CaseType> = { epp: "malware", idp: "account_compromise", mobile: "malware" };
const shortcut = { o: "open", a: "attach", d: "dismiss" } as const;
const noFilters = { status: undefined, severity: undefined, integration: undefined };
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
  const setSearch = (next: Partial<AlertQueueSearch>) => navigate({ search: (prev) => ({ ...prev, ...next }) });

  const integrations = useQuery(integrationsQuery);
  /** The Integrations that bring in Alerts; others (Response Actions only) have no place in the queue. */
  const streams = integrations.data?.filter((i) => i.capabilities.receivesAlerts);
  const alerts = useQuery({
    // Not keyed on the Alert shown in the panel: opening one mustn't reload the queue.
    queryKey: [...alertsKey, { status, severity: search.severity, integration: search.integration }],
    queryFn: async () => {
      const res = await api.alerts.$get({
        query: { ...(status !== "any" && { status }), severity: search.severity, integration: search.integration },
      });
      if (!res.ok) throw new Error("Could not load Alerts");
      return res.json();
    },
  });
  const limit = alerts.data?.limit ?? null;

  /** Selected Alerts: id → the Alert as shown when it was selected, so changes since are caught. */
  const [selected, setSelected] = useState<Map<string, Picked>>(new Map());
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const showing = search.alert ?? null;
  const setShowing = (alert: string | null) => setSearch({ alert: alert ?? undefined });
  const filtered = status !== "new" || search.severity !== undefined || search.integration !== undefined;
  /** Changes the filters; the last action's notice is about Alerts that may no longer be shown, so it goes. */
  const filter = (next: Partial<AlertQueueSearch>) => {
    setOutcome(null);
    setSearch(next);
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
  /** Selected Alerts the current filters don't show. */
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
  const done = (result: BulkOutcome) => {
    const known = dialog?.picked ?? new Map<string, Picked>();
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
    <div className="grid w-full grid-cols-1 max-w-page gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
        <ul className="text-sm text-muted-foreground" aria-label="Integrations">
          {streams?.map((i) => (
            <li key={i.id}>
              {i.name}: {healthWord(i)}, {i.lastEventAt ? `last event ${ago(i.lastEventAt)}` : "no events yet"}
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
      </div>
      {unhealthy.length > 0 && (
        <Alert className="border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80">
          <AlertTitle>
            {unhealthy.length === 1 ? `${unhealthy[0]!.name} isn't bringing in Alerts` : `${unhealthy.length} Integrations aren't bringing in Alerts`}
          </AlertTitle>
          <AlertDescription>
            <ul>
              {unhealthy.map((i) => (
                <li key={i.id}>
                  {i.name}: {healthWord(i)}
                  {i.healthDetail && ` (${i.healthDetail})`}
                  {i.lastEventAt ? `, last event ${ago(i.lastEventAt)}` : ", no events yet"}.
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
              : "No Alerts are shown because the queue didn't load, not because there are none. Try again, or reload the page."}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" disabled={alerts.isFetching} onClick={() => alerts.refetch()}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      )}
      <div className={cn("grid items-start gap-4", showing && "lg:grid-cols-[1fr_340px]")}>
      {!(alerts.isError && !loaded) && (
      <Card className="@container py-0">
          <Table ref={table} className="table-fixed">
            {/* Column widths live here, so the header row can turn into the selection toolbar without moving them. */}
            <colgroup>
              <col className="w-10" />
              <col className="w-28" />
              <col />
              <col className="w-0 @3xl:w-40" />
              <col className="w-0 @3xl:w-36" />
              <col className="w-32" />
            </colgroup>
            <TableHeader>
              <TableRow className={cn("hover:bg-transparent", selected.size > 0 && "bg-muted/50")}>
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
                        {hiddenSelected > 0 && <span className="font-normal text-muted-foreground">{` · ${hiddenSelected} not shown by these filters`}</span>}
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
                  <TableRow key={i} className="hover:bg-transparent" aria-hidden>
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
                <TableRow
                  key={a.id}
                  data-testid={`alert-${a.externalId}`}
                  data-alert-id={a.id}
                  data-state={selected.has(a.id) ? "selected" : undefined}
                  // A half-strength fill: muted text on the full grey wash falls short of 4.5:1.
                  className={cn("focus-within:bg-muted/50 data-[state=selected]:bg-muted/50", showing === a.id && "bg-muted/50")}
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
                        <ItemLink kind="asset" id={a.hostAsset.id} className="hover:underline" aria-label={`Host ${a.host}`}>
                          {a.host}
                        </ItemLink>
                      ) : (
                        a.host
                      )}
                    </div>
                    {a.userName && (
                      <div className="truncate text-muted-foreground" title={a.userName}>
                        {a.userAsset ? (
                          <ItemLink kind="asset" id={a.userAsset.id} className="hover:underline" aria-label={`Account ${a.userName}`}>
                            {a.userName}
                          </ItemLink>
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
              ))}
              {loaded?.length === 0 && (
                <TableRow className="hover:bg-transparent">
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
      {loaded && loaded.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <p role="status">
          {limit !== null && loaded.length >= limit
            ? `Showing the newest ${limit} Alerts. Narrow the filters to see older ones.`
            : `${loaded.length} ${status === "any" ? (loaded.length === 1 ? "Alert" : "Alerts") : `${alertStatusLabel[status]} ${loaded.length === 1 ? "Alert" : "Alerts"}`}`}
          {" · new Alerts appear live"}
        </p>
        <p>
          <Key>j</Key> <Key>k</Key> move · <Key>x</Key> selects · <Key>Enter</Key> opens · <Key>Esc</Key> closes · with Alerts selected,{" "}
          <Key>o</Key> opens a Case, <Key>a</Key> attaches, <Key>d</Key> dismisses
        </p>
        </div>
      )}
    </div>
  );
}

const alertCount = (n: number) => `${n} ${n === 1 ? "Alert" : "Alerts"}`;

const Key = ({ children }: { children: string }) => <kbd className="font-sans font-medium text-foreground">{children}</kbd>;

/** After a bulk action: how many Alerts it applied to, and each one it refused and why. */
function OutcomeNotice({ outcome, onReselect, onDismiss }: { outcome: BulkOutcome; onReselect: () => void; onDismiss: () => void }) {
  const total = outcome.applied.length + outcome.refused.length;
  if (!outcome.refused.length) {
    return (
      <Alert role="status" id="alert-outcome" tabIndex={-1} className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
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
      className="outline-none focus-visible:ring-3 focus-visible:ring-ring/50 border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80"
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

/** The Alert's comments in Falcon, as last fetched; opening the Alert asks the worker to fetch them again. */
function FalconComments({ comments: c }: { comments: AlertDetail["falconComments"] }) {
  /** Refreshing for longer than Falcon usually takes: the worker may be down or Falcon unreachable. */
  // The fetch it has been waiting on since, keyed by when comments were last fetched: a new refresh starts unflagged.
  const [slowSince, setSlowSince] = useState<string | null | false>(false);
  const slow = c.refreshing && slowSince === c.syncedAt;
  useEffect(() => {
    if (!c.refreshing) return;
    const timer = setTimeout(() => setSlowSince(c.syncedAt), 20_000);
    return () => clearTimeout(timer);
  }, [c.refreshing, c.syncedAt]);
  return (
    <section aria-label="Comments in Falcon" className="grid gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Comments in Falcon</h3>
        {c.refreshing ? (
          <span role="status" className="text-xs text-muted-foreground">
            {slow ? "Falcon hasn't answered yet; these may be out of date" : "Refreshing from Falcon…"}
          </span>
        ) : (
          c.syncedAt && (
            <span className="text-xs text-muted-foreground">
              Fetched <time dateTime={c.syncedAt}>{new Date(c.syncedAt).toLocaleTimeString()}</time>
            </span>
          )
        )}
      </div>
      {c.error && <p className="text-xs text-destructive">Couldn’t fetch comments: {c.error}</p>}
      {c.comments.length ? (
        <ul className="grid gap-2">
          {c.comments.map((comment) => (
            <li key={comment.id} className="rounded border p-2">
              <p className="text-xs text-muted-foreground">
                CrowdStrike: {comment.author ?? "unknown user"}
                {comment.createdAt && ` · ${new Date(comment.createdAt).toLocaleString()}`}
              </p>
              <p className="whitespace-pre-wrap">{comment.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        !c.refreshing && <p className="text-muted-foreground">None</p>
      )}
    </section>
  );
}

/** Observables or Assets an Alert names, as badges. */
function Extracted({ label, kind, items }: { label: string; kind: ItemKind; items: { id: string; text: string; title: string; ip?: boolean }[] }) {
  return (
    <section aria-label={label} className="grid gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      {items.length ? (
        <div className="flex flex-wrap gap-1">
          {items.map((item) => (
            <IpHoverCard key={item.id} ip={item.title} enabled={!!item.ip}>
              <Badge variant="outline" className="max-w-full truncate font-mono hover:bg-muted" title={item.ip ? undefined : item.title} asChild>
                <ItemLink kind={kind} id={item.id}>
                  {item.text}
                </ItemLink>
              </Badge>
            </IpHoverCard>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground">None</p>
      )}
    </section>
  );
}

/**
 * Correlation: the Cases this Alert may belong with, by the Observables and Assets they share (those
 * on the Ignored list aside), strongest first. Argus never attaches on its own: the Member attaches
 * from a suggestion, or for a Closed Case an Admin reopens it and attaches in one step; an Analyst
 * only gets the link.
 */
function RelatedCases({ alert }: { alert: AlertDetail }) {
  const related = useQuery(alertCorrelationsQuery(alert.id));
  const queryClient = useQueryClient();
  const attach = useMutation({
    mutationFn: async (c: AlertCorrelation) => {
      const res = await api.alerts.attach.$post({
        json: { case: c.case.number, alerts: [{ id: alert.id, version: alert.version }], reopen: c.attach === "reopen_and_attach" },
      });
      const body = (await res.json()) as { error?: string; refused?: { externalId: string | null; detail: string }[] };
      if (!res.ok) throw new Error(body.error ?? "Couldn't attach the Alert");
      const refused = body.refused?.[0];
      if (refused) throw new Error(`${refused.externalId ?? "The Alert"} ${refused.detail}`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: alertsKey }),
  });
  const list = related.data ?? [];
  return (
    <section aria-label="Related Cases" className="grid gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">Related Cases</h3>
      {related.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : related.isError ? (
        <p className="text-destructive">Couldn’t load the related Cases.</p>
      ) : list.length === 0 ? (
        <p className="text-muted-foreground">No other Case shares its Observables or Assets.</p>
      ) : (
        <ul className="grid gap-2">
          {list.map((c) => (
            <li key={c.case.number} className="grid gap-1.5 rounded border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to="/cases/$number"
                  params={{ number: String(c.case.number) }}
                  className="min-w-0 font-medium underline-offset-4 hover:underline"
                >
                  <span className="font-mono text-xs">{caseRef(c.case.number)}</span> {c.case.title}
                </Link>
                <StatusBadge status={c.case.status} />
                <span className="ml-auto text-xs text-muted-foreground">{c.sharedCount} shared</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {c.shared.map((s) => (
                  <Badge key={`${s.kind}-${s.id}`} variant="outline" className="max-w-full truncate font-mono hover:bg-muted" title={s.value} asChild>
                    <ItemLink kind={s.kind} id={s.id}>
                      {s.kind === "observable"
                        ? `${observableTypeLabel[s.type]} ${shownObservable(s.type, s.value)}`
                        : `${assetTypeLabel[s.type]} ${s.value}`}
                    </ItemLink>
                  </Badge>
                ))}
              </div>
              {c.attach ? (
                <div>
                  <Button size="sm" variant="outline" disabled={attach.isPending} onClick={() => attach.mutate(c)}>
                    {c.attach === "reopen_and_attach" ? `Reopen ${caseRef(c.case.number)} and attach` : `Attach to ${caseRef(c.case.number)}`}
                  </Button>
                </div>
              ) : (
                c.case.status === "closed" &&
                alert.attached?.case.status !== "closed" && <p className="text-xs text-muted-foreground">Closed: ask an Admin to reopen it to attach this Alert.</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {attach.error && <p className="text-xs text-destructive">{attach.error.message}</p>}
    </section>
  );
}

/**
 * One Alert in full, beside the queue: Open Case, Attach and Dismiss while it isn't on a Case, Move
 * and Detach while it is on an open one.
 */
function AlertPanel({ id, onClose, onAct }: { id: string; onClose: () => void; onAct: (kind: BulkKind, alert: AlertRow) => void }) {
  const alert = useQuery(alertQuery(id));
  const [moving, setMoving] = useState<"move" | "detach" | null>(null);
  const a = alert.data;
  if (alert.isPending) {
    return (
      <Card role="region" aria-label="Alert" aria-busy className="self-start">
        <CardContent className="grid gap-3">
          <span className="sr-only" role="status">
            Loading the Alert…
          </span>
          <div className="flex justify-between">
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (!a) {
    return (
      <Card role="region" aria-label="Alert" className="self-start">
        <CardContent className="grid gap-3 text-sm">
          {alert.isError ? (
            <>
              <p className="font-medium">This Alert couldn't be loaded</p>
              <p className="text-muted-foreground">Try again, or reload the page.</p>
            </>
          ) : (
            <>
              <p className="font-medium">This Alert isn't available</p>
              <p className="text-muted-foreground">It may have been removed from the queue, or the link may be wrong.</p>
            </>
          )}
          <div className="flex gap-2">
            {alert.isError && (
              <Button size="sm" variant="outline" disabled={alert.isFetching} onClick={() => alert.refetch()}>
                Try again
              </Button>
            )}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
              Close
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }
  const onCase = a.attached?.case ?? null;
  const editable = onCase !== null && onCase.status !== "closed";
  return (
    <Card role="region" aria-label="Alert" className="self-start">
      <CardContent className="grid gap-3 text-sm">
        <div className="flex items-center gap-2">
          <SeverityBadge severity={a.severity} />
          <Badge variant="outline">{alertStatusLabel[a.status]}</Badge>
          {onCase && (
            <Link
              to="/cases/$number"
              params={{ number: String(onCase.number) }}
              className="font-mono text-xs underline underline-offset-4"
              title={onCase.title}
            >
              {caseRef(onCase.number)}
            </Link>
          )}
          <Button size="icon-sm" variant="ghost" className="-my-1 ml-auto" aria-label="Close the Alert" onClick={onClose}>
            <XIcon aria-hidden />
          </Button>
        </div>
        <div>
          <h2 className="text-base font-semibold text-balance">{a.title}</h2>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{a.externalId}</span> · {alertKindLabel[a.kind]} · {a.integration.name}
          </p>
        </div>
        {a.description && <p>{a.description}</p>}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Host</dt>
          <dd className={cn("min-w-0 break-all", a.host ? "font-mono text-xs leading-5" : "text-muted-foreground")}>{a.host ?? "None"}</dd>
          <dt className="text-muted-foreground">User</dt>
          <dd className={cn("min-w-0 break-all", a.userName ? "font-mono text-xs leading-5" : "text-muted-foreground")}>{a.userName ?? "None"}</dd>
          <dt className="text-muted-foreground">Received</dt>
          <dd>{exactTime(a.receivedAt)}</dd>
          {a.attached && (
            <>
              <dt className="text-muted-foreground">Attached</dt>
              <dd>
                {onCase ? caseRef(onCase.number) : "to a Case you can’t see"}
                {a.attached.by && ` by ${a.attached.by.name}`}
              </dd>
            </>
          )}
          {a.dismissed && (
            <>
              <dt className="text-muted-foreground">Dismissed</dt>
              <dd>
                {dismissalReasonLabel[a.dismissed.reason]}
                {a.dismissed.by && ` by ${a.dismissed.by.name}`}
                {a.dismissed.comment && <span className="block text-muted-foreground">“{a.dismissed.comment}”</span>}
              </dd>
            </>
          )}
          {a.falcon.status && (
            <>
              <dt className="text-muted-foreground">In Falcon</dt>
              <dd>{falconStatusLabel[a.falcon.status] ?? a.falcon.status}</dd>
            </>
          )}
          {a.falcon.assignee && (
            <>
              <dt className="text-muted-foreground">Falcon assignee</dt>
              <dd>{a.falcon.assignee}</dd>
            </>
          )}
          {a.falcon.tags.length > 0 && (
            <>
              <dt className="text-muted-foreground">Falcon tags</dt>
              <dd className="flex flex-wrap gap-1">
                {a.falcon.tags.map((tag) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </dd>
            </>
          )}
        </dl>
        <Extracted
          label="Extracted Observables"
          kind="observable"
          items={a.indicators.observables.map((o) => ({ id: o.id, text: `${observableTypeLabel[o.type]} ${shownObservable(o.type, o.value)}`, title: o.value, ip: o.type === "ip" }))}
        />
        <Extracted
          label="Extracted Assets"
          kind="asset"
          items={a.indicators.assets.map((x) => ({ id: x.id, text: `${assetTypeLabel[x.type]} ${x.value}`, title: x.value }))}
        />
        {a.indicators.observables.length + a.indicators.assets.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {onCase ? `These are on ${caseRef(onCase.number)} too.` : "Attaching this Alert adds these to its Case."}
          </p>
        )}
        <RelatedCases alert={a} />
        <FalconComments comments={a.falconComments} />
        <details>
          <summary className="cursor-pointer text-muted-foreground">Raw payload</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(a.payload, null, 2)}</pre>
        </details>
        {(a.status !== "attached" || editable) && (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {a.status !== "attached" && (
              <>
                <Button size="sm" onClick={() => onAct("open", a)}>
                  Open Case
                </Button>
                <Button size="sm" variant="outline" onClick={() => onAct("attach", a)}>
                  Attach to Case…
                </Button>
                {a.status === "new" && (
                  <Button size="sm" variant="outline" onClick={() => onAct("dismiss", a)}>
                    Dismiss…
                  </Button>
                )}
              </>
            )}
            {editable && (
              <>
                <Button size="sm" variant="outline" onClick={() => setMoving("move")}>
                  Move to another Case…
                </Button>
                <Button size="sm" variant="outline" onClick={() => setMoving("detach")}>
                  Detach
                </Button>
              </>
            )}
          </div>
        )}
        <MoveAlertDialog
          open={moving !== null}
          onOpenChange={(o) => setMoving(o ? moving : null)}
          alert={a}
          detachOnly={moving === "detach"}
        />
      </CardContent>
    </Card>
  );
}
