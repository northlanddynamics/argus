import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SeverityBadge } from "@/components/case-badges";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ago,
  ALERT_STATUSES,
  alertKindLabel,
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
import { caseRef, SEVERITIES, type Severity, severityLabel } from "@/lib/cases";
import { assetTypeLabel, observableTypeLabel, shownObservable } from "@/lib/observables";
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
const received = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The Alert queue: Alerts from the Organization's Integrations, newest first, refreshing live. */
export function AlertQueuePage() {
  const search = useSearch({ from: "/_app/alerts" });
  const navigate = useNavigate({ from: "/alerts" });
  const status = search.status ?? "new";
  const setSearch = (next: Partial<AlertQueueSearch>) => navigate({ search: (prev) => ({ ...prev, ...next }) });

  const integrations = useQuery(integrationsQuery);
  const alerts = useQuery({
    queryKey: [...alertsKey, { ...search, status }],
    queryFn: async () => {
      const res = await api.alerts.$get({
        query: { ...(status !== "any" && { status }), severity: search.severity, integration: search.integration },
      });
      if (!res.ok) throw new Error("Could not load Alerts");
      return res.json();
    },
  });
  const limit = alerts.data?.limit ?? null;

  /** Selected Alerts: id → the version shown when it was selected, so changes since are caught. */
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const showing = search.alert ?? null;
  const setShowing = (alert: string | null) => setSearch({ alert: alert ?? undefined });
  const [dialog, setDialog] = useState<"open" | "attach" | "dismiss" | null>(null);

  const loaded = alerts.data?.alerts;
  const rows = loaded ?? [];
  /** Integrations that aren't bringing Alerts in: paused, disconnected or in error. */
  const unhealthy = integrations.data?.filter((i) => i.paused || i.health === "error" || i.health === "disconnected") ?? [];
  const selection = [...selected].map(([id, version]) => ({ id, version }));
  const allSelected = rows.length > 0 && rows.every((a) => selected.has(a.id));
  const toggle = (a: { id: string; version: number }, on: boolean) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (on) next.set(a.id, a.version);
      else next.delete(a.id);
      return next;
    });
  const severities = rows.filter((a) => selected.has(a.id)).map((a) => a.severity);
  const highest = SEVERITIES.find((s) => severities.includes(s)) ?? "medium";
  const done = (result: BulkOutcome) => {
    setOutcome(result);
    setSelected(new Map());
  };
  /** Selects the refused Alerts again, as they are now. */
  const reselect = () => {
    if (!outcome) return;
    const refused = new Set(outcome.refused.map((r) => r.id));
    setSelected(new Map(rows.filter((a) => refused.has(a.id)).map((a) => [a.id, a.version])));
    setOutcome(null);
  };

  return (
    <div className="mx-auto grid w-full grid-cols-1 max-w-6xl gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
        <ul className="text-sm text-muted-foreground" aria-label="Integrations">
          {integrations.data?.map((i) => (
            <li key={i.id}>
              {i.name} · {healthWord(i).toLowerCase()} · {i.lastEventAt ? `last event ${ago(i.lastEventAt)}` : "no events yet"}
            </li>
          ))}
          {integrations.data?.length === 0 && (
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
              New detections may be missing from the queue until it reconnects. An Admin can check it in{" "}
              <Link to="/settings/integrations" className="underline underline-offset-4">
                Settings
              </Link>
              .
            </p>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <Filter
          label="Alert Status"
          id="alert-status"
          value={status}
          options={[...ALERT_STATUSES, "any"] as const}
          labels={{ ...alertStatusLabel, any: "Any" }}
          onChange={(next) => setSearch({ status: next === "new" ? undefined : next })}
        />
        <Filter
          label="Severity"
          id="alert-severity"
          value={search.severity ?? ""}
          options={["", ...SEVERITIES] as const}
          labels={{ "": "Any", ...severityLabel }}
          onChange={(next) => setSearch({ severity: next || undefined })}
        />
        {((integrations.data?.length ?? 0) > 1 || search.integration) && (
          <Filter
            label="Integration"
            id="alert-integration"
            value={search.integration ?? ""}
            options={["", ...(integrations.data?.map((i) => i.id) ?? [])]}
            labels={{ "": "Any", ...Object.fromEntries(integrations.data?.map((i) => [i.id, i.name]) ?? []) }}
            onChange={(next) => setSearch({ integration: next || undefined })}
          />
        )}
      </div>
      {outcome && <OutcomeNotice outcome={outcome} onReselect={reselect} onDismiss={() => setOutcome(null)} />}
      {selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg bg-foreground px-4 py-3 text-background"
          role="toolbar"
          aria-label="Selected Alerts"
        >
          <span className="mr-2 font-semibold">{selected.size} selected</span>
          <Button size="sm" onClick={() => setDialog("open")}>
            Open Case
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDialog("attach")}>
            Attach to Case…
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDialog("dismiss")}>
            Dismiss…
          </Button>
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setSelected(new Map())}>
            Clear selection
          </Button>
        </div>
      )}
      <OpenCaseFromAlertsDialog
        open={dialog === "open"}
        onOpenChange={(o) => setDialog(o ? "open" : null)}
        selection={selection}
        highest={highest}
        onDone={done}
      />
      <AttachAlertsDialog open={dialog === "attach"} onOpenChange={(o) => setDialog(o ? "attach" : null)} selection={selection} onDone={done} />
      <DismissAlertsDialog
        open={dialog === "dismiss"}
        onOpenChange={(o) => setDialog(o ? "dismiss" : null)}
        selection={selection}
        onDone={done}
      />
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
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="w-10 pl-4">
                  <Checkbox
                    aria-label="Select all Alerts shown"
                    checked={allSelected}
                    onCheckedChange={(on) => {
                      for (const a of rows) toggle(a, on === true);
                    }}
                  />
                </TableHead>
                <TableHead scope="col" className="w-28">Severity</TableHead>
                <TableHead scope="col">Detection</TableHead>
                <TableHead scope="col" className="hidden w-40 @3xl:table-cell">Host / user</TableHead>
                <TableHead scope="col" className="hidden w-36 @3xl:table-cell">Received</TableHead>
                <TableHead scope="col" className="w-32 pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {alerts.isPending &&
                Array.from({ length: 8 }, (_, i) => (
                  <TableRow key={i} className="hover:bg-transparent" aria-hidden>
                    <TableCell className="pl-4"><Skeleton className="size-4" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-4/5" /></TableCell>
                    <TableCell className="hidden @3xl:table-cell"><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell className="hidden @3xl:table-cell"><Skeleton className="h-4 w-16" /></TableCell>
                    <TableCell className="pr-4"><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
                  </TableRow>
                ))}
              {alerts.isPending && (
                <TableRow className="sr-only">
                  <TableCell colSpan={6} role="status">Loading Alerts…</TableCell>
                </TableRow>
              )}
              {loaded?.map((a) => (
                <TableRow
                  key={a.id}
                  data-testid={`alert-${a.externalId}`}
                  data-state={selected.has(a.id) ? "selected" : undefined}
                  className={cn(showing === a.id && "bg-muted")}
                >
                  <TableCell className="pl-4">
                    <Checkbox
                      aria-label={`Select ${a.externalId}`}
                      checked={selected.has(a.id)}
                      onCheckedChange={(on) => toggle(a, on === true)}
                    />
                  </TableCell>
                  <TableCell>
                    <SeverityBadge severity={a.severity} />
                  </TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="block max-w-full truncate text-left font-medium hover:underline"
                      title={a.title}
                      onClick={() => setShowing(a.id)}
                    >
                      {a.title}
                    </button>
                    <div className="truncate text-xs text-muted-foreground">
                      <span className="font-mono">{a.externalId}</span> · {alertKindLabel[a.kind]}
                      {(integrations.data?.length ?? 0) > 1 && ` · ${a.integration.name}`}
                      <span className="@3xl:hidden">
                        {(a.host ?? a.userName) && " · "}
                        <span className="font-mono">{[a.host, a.userName].filter(Boolean).join(" / ")}</span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs @3xl:table-cell">
                    <div className="truncate" title={a.host ?? undefined}>
                      {a.host ?? <span className="font-sans text-muted-foreground">No host</span>}
                    </div>
                    {a.userName && (
                      <div className="truncate text-muted-foreground" title={a.userName}>
                        {a.userName}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground tabular-nums @3xl:table-cell" title={exactTime(a.receivedAt)}>
                    {received(a.receivedAt)}
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant="outline">{alertStatusLabel[a.status]}</Badge>
                      {a.case && (
                        <Link
                          to="/cases/$number"
                          params={{ number: String(a.case.number) }}
                          className="font-mono text-xs underline underline-offset-4"
                          title={a.case.title}
                        >
                          {caseRef(a.case.number)}
                        </Link>
                      )}
                    </div>
                    {a.dismissalReason && (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">{dismissalReasonLabel[a.dismissalReason]}</div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {loaded?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    No Alerts here.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
      </Card>
      )}
      {showing && <AlertPanel id={showing} onClose={() => setShowing(null)} />}
      </div>
      {loaded && loaded.length > 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {limit !== null && loaded.length >= limit
            ? `Showing the newest ${limit} Alerts. Narrow the filters to see older ones.`
            : `${loaded.length} ${status === "any" ? (loaded.length === 1 ? "Alert" : "Alerts") : `${alertStatusLabel[status]} ${loaded.length === 1 ? "Alert" : "Alerts"}`}`}
          {" · new Alerts appear live"}
        </p>
      )}
    </div>
  );
}

/** After a bulk action: how many Alerts it applied to, and each one it refused and why. */
function OutcomeNotice({ outcome, onReselect, onDismiss }: { outcome: BulkOutcome; onReselect: () => void; onDismiss: () => void }) {
  const total = outcome.applied.length + outcome.refused.length;
  if (!outcome.refused.length) {
    return (
      <Alert role="status">
        <AlertTitle>
          {outcome.applied.length} {outcome.applied.length === 1 ? "Alert" : "Alerts"} {outcome.verb}
        </AlertTitle>
        <AlertDescription>
          <Button size="sm" variant="outline" onClick={onDismiss}>
            Dismiss notice
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert role="status" className="border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80">
      <AlertTitle>
        {outcome.refused.length} of {total} {total === 1 ? "Alert was" : "Alerts were"} not {outcome.verb.split(";")[0]}
      </AlertTitle>
      <AlertDescription className="grid gap-2">
        <ul className="text-sm">
          {outcome.refused.map((r) => (
            <li key={r.id}>
              <span className="font-mono">{r.externalId ?? r.id}</span> {r.detail}
            </li>
          ))}
        </ul>
        {outcome.applied.length > 0 && (
          <p className="text-sm">
            The other {outcome.applied.length} {outcome.applied.length === 1 ? "was" : "were"} {outcome.verb}.
          </p>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onReselect}>
            Select the {outcome.refused.length} again
          </Button>
          <Button size="sm" variant="outline" onClick={onDismiss}>
            Dismiss notice
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** One Alert in full, beside the queue, with Move and Detach while it is on a Case. */
/** Observables or Assets an Alert names, as badges. */
/** The Alert's comments in Falcon, as last fetched; opening the Alert asks the worker to fetch them again. */
function FalconComments({ comments: c, attached }: { comments: AlertDetail["falconComments"]; attached: boolean }) {
  /** Refreshing for longer than Falcon usually takes: the worker may be down or Falcon unreachable. */
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!c.refreshing) return;
    const timer = setTimeout(() => setSlow(true), 20_000);
    return () => clearTimeout(timer);
  }, [c.refreshing]);
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
      {attached && c.comments.length > 0 && (
        <p className="text-xs text-muted-foreground">These are in the Case’s Discussion too, as Internal messages.</p>
      )}
    </section>
  );
}

function Extracted({ label, items }: { label: string; items: { id: string; text: string; title: string }[] }) {
  return (
    <section aria-label={label} className="grid gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      {items.length ? (
        <div className="flex flex-wrap gap-1">
          {items.map((item) => (
            <Badge key={item.id} variant="outline" className="max-w-full truncate font-mono" title={item.title}>
              {item.text}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground">None</p>
      )}
    </section>
  );
}

function AlertPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const alert = useQuery(alertQuery(id));
  const [moving, setMoving] = useState<"move" | "detach" | null>(null);
  const a = alert.data;
  if (alert.isPending) {
    return (
      <Card aria-label="Alert" aria-busy className="self-start">
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
      <Card aria-label="Alert" className="self-start">
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
    <Card aria-label="Alert" className="self-start">
      <CardContent className="grid gap-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <SeverityBadge severity={a.severity} />
          <Badge variant="outline">
            {alertStatusLabel[a.status]}
            {onCase && (
              <Link to="/cases/$number" params={{ number: String(onCase.number) }} className="ml-1 text-primary underline">
                {caseRef(onCase.number)}
              </Link>
            )}
          </Badge>
        </div>
        <div>
          <h2 className="text-base font-semibold">{a.title}</h2>
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
          items={a.indicators.observables.map((o) => ({ id: o.id, text: `${observableTypeLabel[o.type]} ${shownObservable(o.type, o.value)}`, title: o.value }))}
        />
        <Extracted
          label="Extracted Assets"
          items={a.indicators.assets.map((x) => ({ id: x.id, text: `${assetTypeLabel[x.type]} ${x.value}`, title: x.value }))}
        />
        {a.indicators.observables.length + a.indicators.assets.length > 0 && (
          <p className="text-xs text-muted-foreground">Attaching this Alert adds these to the Case.</p>
        )}
        <FalconComments comments={a.falconComments} attached={a.attached !== null} />
        <details>
          <summary className="cursor-pointer text-muted-foreground">Raw payload</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(a.payload, null, 2)}</pre>
        </details>
        <div className="flex flex-wrap gap-2 border-t pt-3">
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
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
            Close
          </Button>
        </div>
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

function Filter<T extends string>({
  label,
  id,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  id: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      <NativeSelect size="sm" id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <NativeSelectOption key={o} value={o}>
            {labels[o]}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
