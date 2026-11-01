import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { SeverityBadge } from "@/components/case-badges";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ago,
  ALERT_STATUSES,
  alertKindLabel,
  alertQuery,
  alertsKey,
  type AlertStatus,
  alertStatusLabel,
  dismissalReasonLabel,
  healthWord,
  integrationsQuery,
} from "@/lib/alerts";
import { api } from "@/lib/api";
import { caseRef, SEVERITIES, type Severity, severityLabel } from "@/lib/cases";
import { cn } from "@/lib/utils";
import {
  AttachAlertsDialog,
  type BulkOutcome,
  DismissAlertsDialog,
  MoveAlertDialog,
  OpenCaseFromAlertsDialog,
} from "@/routes/alerts/alert-dialogs";

/** `status` is New unless the URL says otherwise; "any" shows every Status. */
export type AlertQueueSearch = { status?: AlertStatus | "any"; severity?: Severity; integration?: string };

const pick = <T extends string>(list: readonly T[], value: unknown) => (list.includes(value as T) ? (value as T) : undefined);

/** Reads the queue's filters from the URL, ignoring anything unknown. */
export const validateAlertQueueSearch = (search: Record<string, unknown>): AlertQueueSearch => ({
  status: pick([...ALERT_STATUSES, "any"] as const, search.status),
  severity: pick(SEVERITIES, search.severity),
  integration: typeof search.integration === "string" && search.integration ? search.integration : undefined,
});

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

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
      return (await res.json()).alerts;
    },
  });

  /** Selected Alerts: id → the version shown when it was selected, so changes since are caught. */
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [showing, setShowing] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"open" | "attach" | "dismiss" | null>(null);

  const rows = alerts.data ?? [];
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
          {integrations.data?.length === 0 && <li>No Integrations yet: an Admin adds one in Settings.</li>}
        </ul>
      </div>
      <Card>
        <CardContent className="grid items-end gap-4 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto]">
          <div className="grid gap-2">
            <Label htmlFor="alert-status">Alert Status</Label>
            <NativeSelect id="alert-status" value={status} onChange={(e) => setSearch({ status: e.target.value as AlertStatus | "any" })}>
              <NativeSelectOption value="any">Any</NativeSelectOption>
              {ALERT_STATUSES.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {alertStatusLabel[s]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="alert-severity">Severity</Label>
            <NativeSelect
              id="alert-severity"
              value={search.severity ?? ""}
              onChange={(e) => setSearch({ severity: (e.target.value || undefined) as Severity | undefined })}
            >
              <NativeSelectOption value="">Any</NativeSelectOption>
              {SEVERITIES.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {severityLabel[s]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="alert-integration">Integration</Label>
            <NativeSelect
              id="alert-integration"
              value={search.integration ?? ""}
              onChange={(e) => setSearch({ integration: e.target.value || undefined })}
            >
              <NativeSelectOption value="">Any</NativeSelectOption>
              {integrations.data?.map((i) => (
                <NativeSelectOption key={i.id} value={i.id}>
                  {i.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <p className="text-sm text-muted-foreground">
            {alerts.data && `${alerts.data.length} ${status === "any" ? "Alerts" : alertStatusLabel[status]} · new Alerts appear live`}
          </p>
        </CardContent>
      </Card>
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
      <div className={cn("grid items-start gap-4", showing && "lg:grid-cols-[1fr_340px]")}>
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    aria-label="Select all Alerts shown"
                    checked={allSelected}
                    onCheckedChange={(on) => {
                      for (const a of rows) toggle(a, on === true);
                    }}
                  />
                </TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Detection</TableHead>
                <TableHead>Host / user</TableHead>
                <TableHead>Integration</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {alerts.data?.map((a) => (
                <TableRow
                  key={a.id}
                  data-testid={`alert-${a.externalId}`}
                  data-state={selected.has(a.id) ? "selected" : undefined}
                  className={cn(showing === a.id && "bg-muted")}
                >
                  <TableCell>
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
                    <button type="button" className="text-left font-medium hover:underline" onClick={() => setShowing(a.id)}>
                      {a.title}
                    </button>
                    <div className="font-mono text-xs text-muted-foreground">
                      {a.externalId} · {alertKindLabel[a.kind]}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{a.host ?? "—"}</div>
                    {a.userName && <div className="text-xs text-muted-foreground">{a.userName}</div>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{a.integration.name}</TableCell>
                  <TableCell className="text-muted-foreground" title={new Date(a.receivedAt).toLocaleString()}>
                    {time(a.receivedAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{alertStatusLabel[a.status]}</Badge>
                    {a.case && (
                      <Link
                        to="/cases/$number"
                        params={{ number: String(a.case.number) }}
                        className="ml-1 font-mono text-xs text-primary underline"
                        title={a.case.title}
                      >
                        {caseRef(a.case.number)}
                      </Link>
                    )}
                    {a.dismissalReason && (
                      <div className="text-xs text-muted-foreground">{dismissalReasonLabel[a.dismissalReason]}</div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {alerts.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground">
                    No Alerts here.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {showing && <AlertPanel id={showing} onClose={() => setShowing(null)} />}
      </div>
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
    <Alert role="status" className="border-amber-300 bg-amber-50 text-amber-950">
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
function AlertPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const alert = useQuery(alertQuery(id));
  const [moving, setMoving] = useState<"move" | "detach" | null>(null);
  const a = alert.data;
  if (!a) return null;
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
          <h2 className="text-lg font-semibold">{a.title}</h2>
          <p className="font-mono text-xs text-muted-foreground">
            {a.externalId} · {alertKindLabel[a.kind]} · {a.integration.name}
          </p>
        </div>
        {a.description && <p>{a.description}</p>}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Host</dt>
          <dd>{a.host ?? "—"}</dd>
          <dt className="text-muted-foreground">User</dt>
          <dd>{a.userName ?? "—"}</dd>
          <dt className="text-muted-foreground">Received</dt>
          <dd>{new Date(a.receivedAt).toLocaleString()}</dd>
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
        </dl>
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
