import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { MoreHorizontalIcon } from "lucide-react";
import { type ReactNode, useDeferredValue, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { ObservableType } from "api/observables/vocabulary";
import { ActionLogo } from "@/components/action-logo";
import { CaseRef } from "@/components/case-ref";
import { EnrichmentButton } from "@/components/observable-details";
import { AccountHoverCard } from "@/components/account-details";
import { ItemLink } from "@/components/item-link";
import { PageHeader } from "@/components/page-header";
import { Time } from "@/components/time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  actionCenterKey,
  actionLogQuery,
  type CatalogueCard,
  catalogueQuery,
  type CenterGroup,
  dismissRun,
  IgnoredInRun,
  isCenterLookup,
  isCenterResponseAction,
  linkRun,
  type LogEntry,
  type LogFilter,
  logOutcomeLabel,
  logSeenAt,
  logSourceLabel,
  markLogSeen,
  REASON_MAX_LENGTH,
  type Relying,
  removeRun,
  retryRun,
  runAction,
  type RunRequest,
  type RunResult,
} from "@/lib/action-center";
import { extractObservables } from "@/lib/bulk-lookup";
import { caseRef } from "@/lib/cases";
import { observableTypeLabel, shownObservable } from "@/lib/observables";
import { responseActionsQuery, responseActionStateLabel } from "@/lib/response-actions";
import { cn } from "@/lib/utils";
import { workflowRunStateLabel } from "@/lib/workflows";
import { CaseChoice, WorkflowRunDialog, WorkflowsSection } from "@/routes/action-center-workflows";
import { CasePicker } from "@/routes/alerts/alert-dialogs";
import { ContainHostDialog } from "@/routes/cases/contain-host-dialog";

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

const groups: { group: CenterGroup; title: string; description: string }[] = [
  { group: "respond", title: "Respond", description: "Writes to an external tool; removable" },
  { group: "lookup", title: "Look up", description: "Reads only; changes nothing anywhere" },
  { group: "mark", title: "Mark", description: "Changes how Argus treats the value" },
];

const typeLabel = (t: string) => (t === "host" ? "Host" : t === "account" ? "Account" : (observableTypeLabel[t as ObservableType] ?? t));

/** A value as lists show it: hashes shortened, the rest defanged. Hosts and accounts as they are. */
const shown = (type: string, value: string) => (type in observableTypeLabel ? shownObservable(type as ObservableType, value) : value);

/**
 * The Action Center (ADR 0016): the Actions tab lists every action Argus can take on an Observable and
 * runs any of them on pasted values, with or without a Case; the Action Log tab lists every run. Both
 * have their own URL. Members only.
 */
export function ActionCenterLayout() {
  const matchRoute = useMatchRoute();
  const onLog = !!matchRoute({ to: "/actions/log" });
  const log = useQuery(actionLogQuery());
  const newest = log.data?.entries[0]?.at;
  useEffect(() => {
    // Opening the log marks everything in it seen, in this browser.
    if (onLog && newest) markLogSeen(newest);
  }, [onLog, newest]);
  // Read afresh each render: leaving the log tab re-renders this layout after the effect stored it.
  const seenAt = onLog ? newest : logSeenAt();
  const unseen = onLog ? 0 : (log.data?.entries.filter((e) => !seenAt || e.at > seenAt).length ?? 0);

  return (
    <div className="grid w-full grid-cols-1 gap-4">
      <PageHeader title="Action Center" description="Look up, respond to and mark any value, and run Falcon workflows, with or without a Case." />
      <Tabs value={onLog ? "log" : "actions"} activationMode="manual">
        <TabsList variant="line" aria-label="Action Center" className="w-full justify-start">
          <TabsTrigger value="actions" className="h-8 flex-none" asChild>
            <Link to="/actions">Actions</Link>
          </TabsTrigger>
          <TabsTrigger value="log" className="h-8 flex-none" asChild>
            <Link to="/actions/log">
              Action Log
              {unseen > 0 ? (
                <Badge className="tabular-nums">{unseen} new</Badge>
              ) : (
                log.data && log.data.entries.length > 0 && <Badge variant="secondary" className="tabular-nums">{log.data.more ? `${log.data.entries.length}+` : log.data.entries.length}</Badge>
              )}
            </Link>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Outlet />
    </div>
  );
}

/** The Actions tab: a value box that picks out the actions that take it, and a card per action. */
export function ActionsTab() {
  const catalogue = useQuery(catalogueQuery);
  const [value, setValue] = useState("");
  const deferred = useDeferredValue(value);
  const pasted = useMemo(() => {
    if (!deferred.trim()) return null;
    const found = extractObservables(deferred);
    return found.ok ? found.observables : [];
  }, [deferred]);
  const types = new Set(pasted?.map((o) => o.type) ?? []);
  const [running, setRunning] = useState<{ card: CatalogueCard; text: string } | null>(null);

  const takes = (card: CatalogueCard) => card.accepts.some((t) => types.has(t as ObservableType));
  const firstTaking = catalogue.data?.find((c) => c.status === "ready" && takes(c) && c.action !== "contain" && c.action !== "lift_containment");

  return (
    <div className="grid gap-5">
      <form
        className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (firstTaking) setRunning({ card: firstTaking, text: value });
        }}
      >
        <Label htmlFor="action-value" variant="meta">
          Value
        </Label>
        <Input
          id="action-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste a value to see which actions take it: IP, hash, domain, URL, email address"
          className="min-w-0 flex-1 basis-64 bg-background font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {pasted === null
            ? "Shows every action"
            : pasted.length === 0
              ? "No value Argus knows"
              : `${pasted.length === 1 ? typeLabel(pasted[0]!.type) : plural(pasted.length, "value")} · ${plural(catalogue.data?.filter(takes).length ?? 0, "action")} take ${pasted.length === 1 ? "it" : "them"}`}
        </span>
      </form>

      {catalogue.isPending && <Skeleton className="h-64" />}
      {catalogue.isError && (
        <Alert variant="destructive">
          <AlertDescription>{catalogue.error.message}</AlertDescription>
        </Alert>
      )}
      {catalogue.data &&
        groups.map(({ group, title, description }) => (
          <section key={group} aria-labelledby={`group-${group}`} className="grid gap-2">
            <h2 id={`group-${group}`} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {title} <span className="font-normal tracking-normal normal-case">· {description}</span>
            </h2>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
              {catalogue.data
                .filter((c) => c.group === group)
                .map((card) => {
                  const hit = pasted !== null && takes(card);
                  return (
                    <li
                      key={`${card.action}:${card.integration?.id ?? ""}`}
                      className={cn("grid min-w-0 grid-cols-1 content-start gap-1.5 rounded-lg border p-3", hit && "border-ring ring-1 ring-ring", pasted !== null && !hit && "opacity-55")}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <ActionLogo action={card.action} />
                          <div className="min-w-0">
                            <p className="font-medium wrap-anywhere">{card.label}</p>
                            <p className="truncate text-xs text-muted-foreground">{card.through}</p>
                          </div>
                        </div>
                        {card.adminOnly && (
                          <Badge variant="outline-dashed">
                            Admin
                          </Badge>
                        )}
                      </div>
                      <div className="flex min-w-0 flex-wrap gap-1">
                        {card.accepts.map((t) => (
                          <Badge key={t} variant={types.has(t as ObservableType) ? "outline" : "outline-muted"} className="font-normal">
                            {typeLabel(t)}
                          </Badge>
                        ))}
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground" title={card.statusText}>
                          <span aria-hidden className={cn("size-1.5 flex-none rounded-full", card.status === "ready" ? "bg-live" : "bg-muted-foreground/40")} />
                          <span className="truncate">{card.statusText}</span>
                        </span>
                        <Button size="sm" variant="outline" className="flex-none" onClick={() => setRunning({ card, text: hit ? value : "" })} aria-label={`Run ${card.label} through ${card.through}`}>
                          Run…
                        </Button>
                      </div>
                    </li>
                  );
                })}
            </ul>
          </section>
        ))}
      <WorkflowsSection />
      {running &&
        (running.card.action === "contain" || running.card.action === "lift_containment" ? (
          <ContainFromCenter card={running.card} onClose={() => setRunning(null)} />
        ) : (
          <RunDialog card={running.card} initialText={running.text} onClose={() => setRunning(null)} />
        ))}
    </div>
  );
}

/** What the dialog shows of a value it will (or won't) run on. */
function ParsedValues({ card, text }: { card: CatalogueCard; text: string }) {
  const found = useMemo(() => (text.trim() ? extractObservables(text) : null), [text]);
  if (!found) return null;
  if (!found.ok) return <p className="text-xs text-destructive">{found.reason}</p>;
  if (!found.observables.length) return <p className="text-xs text-muted-foreground">No value Argus knows is in that text.</p>;
  return (
    <ul className="max-h-40 overflow-auto rounded-md border text-xs" aria-label="Values found">
      {found.observables.map((o) => {
        const ok = card.accepts.includes(o.type);
        return (
          <li key={`${o.type}:${o.value}`} className="flex items-center justify-between gap-2 border-b px-2 py-1 last:border-b-0">
            <span className={cn("min-w-0 font-mono break-all", !ok && "text-muted-foreground line-through")}>{shownObservable(o.type, o.value)}</span>
            {ok ? (
              <Badge variant="outline">{typeLabel(o.type)}</Badge>
            ) : (
              <span className="flex-none text-muted-foreground">
                {card.label} takes no {typeLabel(o.type)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Runs one action on whatever is pasted: one value per line, or any text. Shows what each value
 * will do, the action's settings, an optional Case, and a reason when a Response Action has no Case.
 */
function RunDialog({ card, initialText, onClose }: { card: CatalogueCard; initialText: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [text, setText] = useState(initialText);
  // null: no Case; undefined: a Case, not picked yet.
  const [caseNumber, setCaseNumber] = useState<number | null | undefined>(null);
  const [reason, setReason] = useState("");
  const [internal, setInternal] = useState(false);
  const [ignored, setIgnored] = useState<IgnoredInRun | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const respond = isCenterResponseAction(card.action);
  const blocked = card.status !== "ready";

  const found = useMemo(() => (text.trim() ? extractObservables(text) : null), [text]);
  const runnable = found?.ok ? found.observables.filter((o) => card.accepts.includes(o.type)).length : 0;
  const needsReason = respond && caseNumber === null && !reason.trim();
  const needsCase = caseNumber === undefined;

  const run = useMutation({
    mutationFn: (confirmIgnored: boolean) =>
      runAction({
        action: card.action as RunRequest["action"],
        text,
        integrationIds: respond && card.integration ? [card.integration.id] : undefined,
        caseNumber: caseNumber ?? null,
        reason: respond && caseNumber === null ? reason.trim() : null,
        internal: respond && caseNumber ? internal : undefined,
        confirmIgnored,
      }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: actionCenterKey });
      if (isCenterLookup(card.action)) {
        setResult(r);
        return;
      }
      const done = r.values.filter((v) => v.outcome !== "skipped").length;
      toast.success(`${card.label}: ${plural(done, "value")} ${respond ? "queued" : "done"}${r.case ? ` on ${caseRef(r.case.number)}` : ", no Case"}`, {
        action: { label: "View in Action Log", onClick: () => void navigate({ to: "/actions/log" }) },
      });
      onClose();
    },
    onError: (e) => {
      if (e instanceof IgnoredInRun) setIgnored(e);
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {card.label}
            {card.adminOnly && (
              <Badge variant="outline-dashed">
                Admin
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {card.through} · takes {card.accepts.map(typeLabel).join(", ")}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <LookupResults result={result} />
        ) : (
          <form
            id="run-form"
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate(false);
            }}
          >
            {blocked && (
              <Alert variant="notice">
                <AlertDescription>This action can't run now: {card.statusText}.</AlertDescription>
              </Alert>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="run-values">Values · one per line, or paste any text</Label>
              <Textarea id="run-values" value={text} onChange={(e) => setText(e.target.value)} className="min-h-24 font-mono text-xs" spellCheck={false} autoFocus />
            </div>
            <ParsedValues card={card} text={text} />
            {card.settings.length > 0 && (
              <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border bg-muted/50 px-3 py-2 text-sm">
                {card.settings.map((s) => (
                  <div key={s.label} className="contents">
                    <dt className="text-muted-foreground">{s.label}</dt>
                    <dd>{s.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <CaseChoice value={caseNumber} onChange={setCaseNumber} />
            {respond && caseNumber === null && (
              <div className="grid gap-1.5">
                <Label htmlFor="run-reason">Reason · sent to {card.through.split(" · ")[0]} in place of a Case's reference</Label>
                <Input
                  id="run-reason"
                  value={reason}
                  maxLength={REASON_MAX_LENGTH}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why this is being blocked, for whoever finds it in the tool"
                />
              </div>
            )}
            {respond && caseNumber != null && (
              <Label variant="option">
                <Checkbox checked={internal} onCheckedChange={(c) => setInternal(!!c)} />
                Internal: hide it from the Case's Guests
              </Label>
            )}
            {ignored && (
              <Alert variant="notice">
                <AlertDescription>
                  {ignored.message}.{" "}
                  <Button type="button" variant="link" onClick={() => run.mutate(true)}>
                    Send anyway
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {run.error && !(run.error instanceof IgnoredInRun) && (
              <Alert variant="destructive">
                <AlertDescription>{run.error.message}</AlertDescription>
              </Alert>
            )}
          </form>
        )}
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">Recorded in the Action Log{respond ? " and an Audit Log" : ""}</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {result ? "Done" : "Cancel"}
            </Button>
            {!result && (
              <Button
                type="submit"
                form="run-form"
                disabled={blocked || runnable === 0 || needsReason || needsCase || run.isPending}
                title={needsReason ? "Give a reason, or link to a Case" : needsCase ? "Pick a Case" : undefined}
              >
                {run.isPending ? "Running…" : `${card.label}${runnable > 1 ? ` (${runnable})` : ""}`}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A lookup's results, each value opening its Enrichment. */
function LookupResults({ result }: { result: RunResult }) {
  return (
    <ul className="grid gap-1 rounded-md border p-2 text-sm" aria-label="Results">
      {result.values.map((v) => (
        <li key={`${v.type}:${v.value}`} className="flex items-center justify-between gap-2">
          <span className="min-w-0">
            <span className={cn("font-mono text-xs break-all", v.outcome === "skipped" && "text-muted-foreground line-through")}>{v.type ? shownObservable(v.type, v.value) : v.value}</span>
            {v.detail && <span className="block text-xs text-muted-foreground">{v.detail}</span>}
          </span>
          <span className="flex flex-none items-center gap-1">
            <StateBadge state={v.outcome === "skipped" ? "skipped" : v.outcome} />
            {v.type && v.outcome !== "skipped" && <EnrichmentButton type={v.type} value={v.value} />}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Contain host or Lift containment from the Action Center: containment is always taken from a Case,
 * through its confirmation (ADR 0009). The Member names the host and a Case; the host is linked to
 * the Case, and the Case's confirmation takes over.
 */
function ContainFromCenter({ card, onClose }: { card: CatalogueCard; onClose: () => void }) {
  const [host, setHost] = useState("");
  const [caseNumber, setCaseNumber] = useState<number | null | undefined>(undefined);
  const [linked, setLinked] = useState<{ number: number; asset: { id: string; value: string } } | null>(null);
  const integrations = useQuery({ ...responseActionsQuery(linked?.number ?? 0), enabled: !!linked });
  const lift = card.action === "lift_containment";
  const blocked = card.status !== "ready";

  const link = useMutation({
    mutationFn: async () => {
      const { api, errorMessage } = await import("@/lib/api");
      const number = caseNumber!;
      const res = await api.cases[":number"].assets.$post({ param: { number: String(number) }, json: { type: "host", value: host.trim() } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not link the host to that Case"));
      const body = await res.json();
      if (!("asset" in body)) throw new Error("Unexpected response");
      return { number, asset: { id: body.asset.id, value: body.asset.value } };
    },
    onSuccess: setLinked,
  });

  if (linked && integrations.data) {
    const offered = integrations.data.containment.filter((i) => !card.integration || i.id === card.integration.id);
    return <ContainHostDialog number={linked.number} asset={linked.asset} integrations={offered} lift={lift} onClose={onClose} />;
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{card.label}</DialogTitle>
          <DialogDescription>
            {card.through} · Containment is always taken from a Case. Name the host and the Case: the host is linked to it, then Falcon is asked for the host afresh for you to confirm.
          </DialogDescription>
        </DialogHeader>
        <form
          id="contain-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            link.mutate();
          }}
        >
          {blocked && (
            <Alert variant="notice">
              <AlertDescription>This action can't run now: {card.statusText}.</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="contain-host">Host</Label>
            <Input id="contain-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="FIN-LT-0142" className="font-mono text-xs" autoFocus />
          </div>
          <CaseChoice value={caseNumber} onChange={setCaseNumber} required />
          {link.error && (
            <Alert variant="destructive">
              <AlertDescription>{link.error.message}</AlertDescription>
            </Alert>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="contain-form" disabled={blocked || !host.trim() || !caseNumber || link.isPending || (!!linked && integrations.isPending)}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const outcomeLabel: Record<string, string> = { ...workflowRunStateLabel, ...logOutcomeLabel, ...responseActionStateLabel, taken: "Queued", skipped: "Skipped" };

function StateBadge({ state }: { state: string }) {
  const tone =
    state === "failed"
      ? "bg-destructive"
      : state === "pending" || state === "removing" || state === "taken" || state === "running"
        ? "bg-reconnecting"
        : state === "removed" || state === "skipped" || state === "unchanged" || state === "cancelled" || state === "timed_out"
          ? "bg-muted-foreground/40"
          : "bg-live";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
      <span aria-hidden className={cn("size-1.5 rounded-full", tone)} />
      {outcomeLabel[state] ?? state}
    </span>
  );
}

/** The Action Log tab: every run, newest first, filtered by Case link and kind. */
export function ActionLogTab() {
  const [link, setLink] = useState<"all" | "linked" | "unlinked">("all");
  const [group, setGroup] = useState<"all" | CenterGroup>("all");
  const filter: LogFilter = { ...(link !== "all" && { link }), ...(group !== "all" && { group }) };
  const log = useQuery(actionLogQuery(filter));
  const [linking, setLinking] = useState<LogEntry | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ entry: LogEntry; relying: Relying } | null>(null);
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: actionCenterKey });

  const act = useMutation({
    mutationFn: async ({ entry, op, confirm = false }: { entry: LogEntry; op: "retry" | "remove" | "dismiss"; confirm?: boolean }) => {
      if (op === "retry") return retryRun(entry.id);
      if (op === "dismiss") return dismissRun(entry.id);
      const relying = await removeRun(entry.id, confirm);
      if (relying) setRemoving({ entry, relying });
    },
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" variant="outline" size="sm" value={link} onValueChange={(v) => v && setLink(v as typeof link)} aria-label="Filter by Case">
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="linked">Linked to a Case</ToggleGroupItem>
          <ToggleGroupItem value="unlinked">No Case</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup type="single" variant="outline" size="sm" value={group} onValueChange={(v) => v && setGroup(v as typeof group)} aria-label="Filter by kind">
          <ToggleGroupItem value="all">All kinds</ToggleGroupItem>
          <ToggleGroupItem value="respond">Respond</ToggleGroupItem>
          <ToggleGroupItem value="lookup">Look up</ToggleGroupItem>
          <ToggleGroupItem value="mark">Mark</ToggleGroupItem>
          <ToggleGroupItem value="workflow">Workflows</ToggleGroupItem>
        </ToggleGroup>
        {log.data && <span className="text-xs text-muted-foreground tabular-nums">{plural(log.data.entries.length, "run")}{log.data.more ? ", newest shown" : ""}</span>}
      </div>
      {log.isPending && <Skeleton className="h-64" />}
      {log.isError && (
        <Alert variant="destructive">
          <AlertDescription>{log.error.message}</AlertDescription>
        </Alert>
      )}
      {log.data && log.data.entries.length === 0 && (
        <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
          Nothing has been run{filter.link || filter.group ? " that matches" : " yet"}. Runs from the Actions tab, every Workflow run, and every Response Action and mark taken anywhere in Argus, show here.
        </p>
      )}
      {log.data && log.data.entries.length > 0 && (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Through</TableHead>
                <TableHead>Case</TableHead>
                <TableHead>By</TableHead>
                <TableHead>From</TableHead>
                <TableHead>State</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.data.entries.map((e) => (
                <LogRow key={e.id} entry={e} onLink={() => setLinking(e)} onAct={(op) => act.mutate({ entry: e, op })} onView={() => e.workflowRun && setViewing(e.workflowRun.id)} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {linking && <LinkRunDialog entry={linking} onClose={() => setLinking(null)} />}
      {viewing && <WorkflowRunDialog id={viewing} onClose={() => setViewing(null)} />}
      {removing && (
        <Dialog open onOpenChange={(open) => !open && setRemoving(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove it anyway?</DialogTitle>
              <DialogDescription>
                {removing.relying.cases.map((c) => caseRef(c.number)).join(", ")}
                {removing.relying.otherCases > 0 && `${removing.relying.cases.length ? " and " : ""}${plural(removing.relying.otherCases, "Case")} you can't see`} record it as present. Removing it ends
                those records too.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  act.mutate({ entry: removing.entry, op: "remove", confirm: true });
                  setRemoving(null);
                }}
              >
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function LogRow({
  entry: e,
  onLink,
  onAct,
  onView,
}: {
  entry: LogEntry;
  onLink: () => void;
  onAct: (op: "retry" | "remove" | "dismiss") => void;
  /** Opens a Workflow Run's details. */
  onView: () => void;
}) {
  const ra = e.responseAction;
  const wr = e.workflowRun;
  const menu: { label: string; run: () => void }[] = [
    ...(wr ? [{ label: "View run…", run: onView }] : []),
    ...(ra?.retryable || wr?.retryable ? [{ label: "Retry", run: () => onAct("retry") }] : []),
    ...(ra?.removable ? [{ label: "Remove…", run: () => onAct("remove") }] : []),
    ...(ra?.dismissable ? [{ label: "Dismiss record", run: () => onAct("dismiss") }] : []),
    ...(!e.case ? [{ label: "Link to Case…", run: onLink }] : []),
  ];
  const valueText: ReactNode = shown(e.value.type, e.value.value);
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        <Time iso={e.at} />
      </TableCell>
      <TableCell>
        {e.label}
        {ra?.reason && !e.case && <span className="block text-xs text-muted-foreground">“{ra.reason}”</span>}
        {wr && !e.case && e.detail && e.state !== "failed" && <span className="block text-xs text-muted-foreground">“{e.detail}”</span>}
      </TableCell>
      <TableCell className="font-mono text-xs whitespace-nowrap">
        {e.observableId ? (
          <ItemLink kind="observable" id={e.observableId}>
            {valueText}
          </ItemLink>
        ) : e.assetId ? (
          <AccountHoverCard assetId={e.assetId} account={e.value.value} enabled={e.value.type === "account"}>
            <ItemLink kind="asset" id={e.assetId}>
              {valueText}
            </ItemLink>
          </AccountHoverCard>
        ) : wr ? (
          <Button variant="link" onClick={onView}>
            <span className="font-sans">{e.value.value}</span>
          </Button>
        ) : (
          valueText
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap">{e.integration?.name ?? (e.group === "mark" ? "Argus" : "—")}</TableCell>
      <TableCell className="whitespace-nowrap">
        {e.case ? (
          <CaseRef number={e.case.number} title={e.case.title} />
        ) : (
          <span className="text-xs text-muted-foreground">
            No Case ·{" "}
            <Button variant="link" size="xs" onClick={onLink}>
              Link to Case…
            </Button>
          </span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap">{e.by.name}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">{logSourceLabel[e.source]}</TableCell>
      <TableCell>
        <StateBadge state={e.state} />
        {e.state === "failed" && e.detail && <span className="block max-w-64 text-xs text-muted-foreground">{e.detail}</span>}
        {e.group === "lookup" && e.state !== "failed" && e.detail && <span className="block max-w-64 text-xs text-muted-foreground">{e.detail}</span>}
      </TableCell>
      <TableCell>
        {menu.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={`Actions for ${e.label} on ${e.value.value}`}>
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {menu.map((m) => (
                <DropdownMenuItem key={m.label} onSelect={m.run}>
                  {m.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Links a run with no Case to one: a Response Action moves to it for good. */
function LinkRunDialog({ entry, onClose }: { entry: LogEntry; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [number, setNumber] = useState<number | null>(null);
  const link = useMutation({
    mutationFn: () => linkRun(entry.id, number!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: actionCenterKey });
      toast.success(`Linked to ${caseRef(number!)}`);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link to a Case</DialogTitle>
          <DialogDescription>
            {entry.label} on <span className="font-mono">{shown(entry.value.type, entry.value.value)}</span>.{" "}
            {entry.responseAction
              ? "The Response Action moves to the Case for good: it shows on its Timeline and is removed from there."
              : entry.workflowRun
                ? "The Workflow run moves to the Case for good, and is recorded in its Audit Log."
                : "The value is linked to the Case, and the run names it."}
          </DialogDescription>
        </DialogHeader>
        <CasePicker enabled value={number ? String(number) : null} onChange={(v) => setNumber(Number(v))} />
        {link.error && (
          <Alert variant="destructive">
            <AlertDescription>{link.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!number || link.isPending} onClick={() => link.mutate()}>
            Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
