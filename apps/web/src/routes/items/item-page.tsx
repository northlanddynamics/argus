import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useRouteContext } from "@tanstack/react-router";
import { BellOffIcon, CheckIcon, CopyIcon, ExternalLinkIcon, FingerprintIcon, LockIcon, MonitorIcon, SearchIcon, UserIcon } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { SeverityBadge, StatusBadge } from "@/components/case-badges";
import { observableIcon } from "@/components/search/search-hit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useMe } from "@/lib/api";
import { alertStatusLabel } from "@/lib/alerts";
import { caseRef } from "@/lib/cases";
import { canManage } from "@/lib/roles";
import {
  type AssetType,
  assetTypeLabel,
  defang,
  type ItemKind,
  type ItemPage,
  itemPageQuery,
  itemPagesKey,
  type ObservableType,
  observableTypeLabel,
  setIgnored,
} from "@/lib/observables";
import { falconIocActionLabel, responseActionKindLabel, responseActionStateLabel } from "@/lib/response-actions";
import { exactTime, when } from "@/lib/when";
import { ObservableActions } from "@/routes/cases/observable-actions";

/** `/observables/$id`: everything Argus knows about one Observable that the viewer may see. */
export function ObservablePage() {
  const { id } = useParams({ from: "/_app/observables/$id" });
  return <ItemPageView kind="observable" id={id} />;
}

/** `/assets/$id`: the same for a host or account. */
export function AssetPage() {
  const { id } = useParams({ from: "/_app/assets/$id" });
  return <ItemPageView kind="asset" id={id} />;
}

const noun: Record<ItemKind, string> = { observable: "Observable", asset: "Asset" };

/** Its value as it is safe to show and copy: Observables defanged, Assets as they are. */
const shown = (kind: ItemKind, item: ItemPage) => (kind === "observable" ? defang(item.type as ObservableType, item.value) : item.value);
const typeLabel = (kind: ItemKind, item: ItemPage) =>
  kind === "observable" ? observableTypeLabel[item.type as ObservableType] : assetTypeLabel[item.type as AssetType];

/** A long value with places it may wrap: after each / ? & = and dot, never inside an escape like %2F. */
function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[/?&=.])/);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

function TypeIcon({ kind, item }: { kind: ItemKind; item: ItemPage }) {
  const className = "size-4 text-muted-foreground";
  if (kind === "asset") return item.type === "host" ? <MonitorIcon className={className} aria-hidden /> : <UserIcon className={className} aria-hidden />;
  const Icon = observableIcon[item.type as ObservableType] ?? FingerprintIcon;
  return <Icon className={className} aria-hidden />;
}

/**
 * The pivot for one indicator: its value (defanged), when it was first and last seen, the Cases it
 * is linked to and the Alerts that name it, all limited by the API to what the viewer may see. Guests
 * get no Alerts. Any Case or Alert signal refetches it (`lib/live.ts`).
 */
function ItemPageView({ kind, id }: { kind: ItemKind; id: string }) {
  const me = useMe(useRouteContext({ from: "/_app" }).me);
  const guest = !!me.guest;
  const page = useQuery(itemPageQuery(kind, id));
  const item = page.data;

  if (page.isPending) {
    return (
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4">
        <Skeleton className="h-16" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (page.isError) return <p className="py-8 text-center text-sm text-destructive">{page.error.message}. Try again.</p>;
  if (!item) {
    return (
      <div className="mx-auto grid w-full max-w-6xl gap-2 py-8 text-center">
        <h1 className="text-lg font-semibold">{noun[kind]} not found</h1>
        <p className="text-sm text-muted-foreground">It doesn't exist, or it isn't on any Case you can see.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4">
      <section aria-label={noun[kind]} className="grid gap-1">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <TypeIcon kind={kind} item={item} />
          {noun[kind]} · {typeLabel(kind, item)}
        </p>
        <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
          <h1 className="min-w-0 flex-1 basis-80 font-mono text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]" title={item.value}>
            <Breakable text={shown(kind, item)} />
          </h1>
          <div className="flex shrink-0 items-center gap-1">
            <CopyButton text={shown(kind, item)} />
            <Button variant="outline" size="sm" asChild>
              <Link to="/search" search={{ q: item.value }}>
                <SearchIcon />
                Search for this
              </Link>
            </Button>
            {canManage(me.organization?.role) && <IgnoreButton kind={kind} item={item} />}
          </div>
        </div>
        {item.ignored && (
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <Badge variant="outline">
              <BellOffIcon aria-hidden />
              Ignored
            </Badge>
            <span>
              Added to the Ignored list by {item.ignored.by.name}{" "}
              <span title={exactTime(item.ignored.at)}>{when(item.ignored.at)}</span>. It never suggests which Case an Alert belongs with.
            </span>
          </p>
        )}
        <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">First seen</dt>
            <dd title={exactTime(item.firstSeen)}>{when(item.firstSeen)}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Last seen</dt>
            <dd title={exactTime(item.lastSeen)}>{when(item.lastSeen)}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Cases</dt>
            <dd className="tabular-nums">{item.cases.length}</dd>
          </div>
          {!guest && (
            <div className="flex gap-1.5">
              <dt className="text-muted-foreground">Alerts</dt>
              <dd className="tabular-nums">{item.alerts.length}</dd>
            </div>
          )}
        </dl>
      </section>

      {kind === "asset" && item.type === "host" && !guest && <FalconDevicesCard item={item} />}
      <CasesCard item={item} actions={kind === "observable" && !guest} />
      {!guest && <AlertsCard item={item} />}
      {kind === "observable" && <ResponseActionsCard item={item} actions={!guest} />}
      <p className="max-w-prose text-xs text-muted-foreground">
        {guest
          ? "Only the Cases you've been given access to are shown."
          : "Only Cases and Alerts you can see are shown or counted. First and last seen come from when it was linked to those Cases and when those Alerts were raised."}
      </p>
    </div>
  );
}

/**
 * Admins put it on the Organization's Ignored list, or take it off. Ignoring reaches every Case in
 * the Organization, so it asks first; taking it off doesn't.
 */
function IgnoreButton({ kind, item }: { kind: ItemKind; item: ItemPage }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const toggle = useMutation({
    mutationFn: () => setIgnored(kind, item.id, !item.ignored),
    onSuccess: () => setConfirming(false),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [...itemPagesKey] }),
  });
  const error = toggle.isError && <p className="text-xs text-destructive">{toggle.error.message}</p>;
  if (item.ignored) {
    return (
      <div className="grid justify-items-end gap-1">
        <Button variant="outline" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          Stop ignoring
        </Button>
        {error}
      </div>
    );
  }
  return (
    <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <BellOffIcon />
          Ignore…
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Ignore this {typeLabel(kind, item)}?</AlertDialogTitle>
          <p className="font-mono text-xs [overflow-wrap:anywhere]">{shown(kind, item)}</p>
          <AlertDialogDescription>
            It goes on the Organization's Ignored list, for every Case: it will never suggest which Case an Alert belongs with, and
            sending it as a Response Action asks first. It stays linked and searchable, and an Admin can stop ignoring it at any time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={toggle.isPending}
            onClick={(e) => {
              e.preventDefault();
              toggle.mutate();
            }}
          >
            Ignore
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="mt-0.5 shrink-0"
      aria-label="Copy value"
      title="Copy (defanged)"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

/**
 * The Falcon devices recorded on a host, from the detections that name it, each linking to the
 * device in its Integration's Falcon console. Several for one Integration mark the host ambiguous
 * there: the same name has been seen on more than one sensor.
 */
function FalconDevicesCard({ item }: { item: ItemPage }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Falcon devices</CardTitle>
      </CardHeader>
      <CardContent>
        <Table aria-label="Falcon devices">
          <TableHeader className={item.falconDevices.length ? undefined : "sr-only"}>
            <TableRow>
              <TableHead>Device ID</TableHead>
              <TableHead>Integration</TableHead>
              <TableHead className="text-right">Recorded</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {item.falconDevices.flatMap((group) =>
              group.devices.map((d) => (
                <TableRow key={`${group.integration.id} ${d.deviceId}`}>
                  <TableCell>
                    <a href={d.consoleUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs break-all hover:underline">
                      {d.deviceId}
                      <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Opens in the Falcon console" />
                    </a>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {group.integration.name}
                    {group.ambiguous && (
                      <Badge variant="outline" className="ml-1.5" title="Several Falcon devices go by this name for this Integration">
                        Ambiguous
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums" title={exactTime(d.recordedAt)}>
                    {when(d.recordedAt)}
                  </TableCell>
                </TableRow>
              )),
            )}
            {item.falconDevices.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground">
                  No detection has named its Falcon device yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * The Cases it is on. For an Observable, Members right-click a Case's row, or use its ⋯ menu, to take
 * action on the Observable from that Case.
 */
function CasesCard({ item, actions }: { item: ItemPage; actions: boolean }) {
  const observable = { id: item.id, type: item.type as ObservableType, value: item.value };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cases</CardTitle>
      </CardHeader>
      <CardContent>
        <Table aria-label="Linked Cases">
          <TableHeader className={item.cases.length ? undefined : "sr-only"}>
            <TableRow>
              <TableHead>Case</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead className="hidden sm:table-cell">Assignee</TableHead>
              <TableHead className="text-right">Linked</TableHead>
              {actions && (
                <TableHead className="w-0">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {item.cases.map((c) => {
              const row = (menuButton?: ReactNode) => (
                <TableRow key={c.number}>
                  <TableCell className="max-w-0 min-w-48 whitespace-normal break-words">
                    <Link to="/cases/$number" params={{ number: String(c.number) }} className="hover:underline">
                      <span className="font-mono text-xs text-muted-foreground">{caseRef(c.number)}</span> {c.title}
                    </Link>
                    {c.restricted && <LockIcon className="ml-1 inline size-3 text-muted-foreground" aria-label="Restricted" />}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={c.status} />
                  </TableCell>
                  <TableCell>
                    <SeverityBadge severity={c.severity} />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{c.assignee?.name ?? <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums" title={exactTime(c.linkedAt)}>
                    {when(c.linkedAt)}
                  </TableCell>
                  {menuButton && <TableCell className="w-0 text-right">{menuButton}</TableCell>}
                </TableRow>
              );
              return actions ? (
                <ObservableActions key={c.number} number={c.number} observable={observable}>
                  {row}
                </ObservableActions>
              ) : (
                row()
              );
            })}
            {item.cases.length === 0 && (
              <TableRow>
                <TableCell colSpan={actions ? 6 : 5} className="text-muted-foreground">
                  Not on any Case you can see yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function AlertsCard({ item }: { item: ItemPage }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Alerts naming it</CardTitle>
      </CardHeader>
      <CardContent>
        <Table aria-label="Alerts naming it">
          <TableHeader className={item.alerts.length ? undefined : "sr-only"}>
            <TableRow>
              <TableHead>Alert</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead className="hidden sm:table-cell">Case</TableHead>
              <TableHead className="text-right">Raised</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {item.alerts.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="max-w-0 min-w-48 whitespace-normal break-words">
                  <Link to="/alerts" search={{ status: "any", alert: a.id }} className="hover:underline" title={a.externalId}>
                    {a.title}
                  </Link>
                  {a.host && <span className="block font-mono text-xs text-muted-foreground">{a.host}</span>}
                </TableCell>
                <TableCell>
                  <Badge variant={a.status === "new" ? "secondary" : "outline"}>{alertStatusLabel[a.status]}</Badge>
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={a.severity} />
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {a.case ? (
                    <Link to="/cases/$number" params={{ number: String(a.case.number) }} className="font-mono text-xs hover:underline" title={a.case.title}>
                      {caseRef(a.case.number)}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums" title={exactTime(a.seenAt)}>
                  {when(a.seenAt)}
                </TableCell>
              </TableRow>
            ))}
            {item.alerts.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No Alert names it.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** As on the Case: Failed asks for attention, Active stays quiet (never "in force"). */
const stateVariant = { pending: "secondary", active: "outline", removing: "secondary", failed: "destructive", removed: "outline" } as const;

/**
 * The Response Actions taken on the Observable from Cases the viewer can see: which Integration
 * (never for Guests), where each stands, its Case and when. Said as what Argus did, never that
 * something is in force now.
 */
function ResponseActionsCard({ item, actions }: { item: ItemPage; actions: boolean }) {
  const observable = { id: item.id, type: item.type as ObservableType, value: item.value };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Response Actions</CardTitle>
      </CardHeader>
      <CardContent>
        <Table aria-label="Response Actions">
          <TableHeader className={item.responseActions.length ? undefined : "sr-only"}>
            <TableRow>
              <TableHead>Action</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Case</TableHead>
              <TableHead className="text-right">When</TableHead>
              {actions && (
                <TableHead className="w-0">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {item.responseActions.map((r) => {
              const row = (menuButton?: ReactNode) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-normal">
                    {responseActionKindLabel[r.kind]}
                    <span className="block text-xs text-muted-foreground">
                      {r.falcon && falconIocActionLabel[r.falcon.action]}
                      {r.integration && ` · ${r.integration.name}`}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <Badge variant={stateVariant[r.state]}>{responseActionStateLabel[r.state]}</Badge>
                    {r.origin !== "created" && <span className="mt-1 block text-xs text-muted-foreground">Already present</span>}
                  </TableCell>
                  <TableCell>
                    <Link to="/cases/$number/observables" params={{ number: String(r.case.number) }} className="hover:underline" title={r.case.title}>
                      <span className="font-mono text-xs text-muted-foreground">{caseRef(r.case.number)}</span> {r.case.title}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums" title={exactTime(r.sentAt ?? r.requestedAt)}>
                    {r.sentAt ? <>Sent {when(r.sentAt)}</> : <>Requested {when(r.requestedAt)}</>}
                  </TableCell>
                  {menuButton && <TableCell className="w-0 text-right">{menuButton}</TableCell>}
                </TableRow>
              );
              // Taken from its Case, so acted on from there too.
              return actions ? (
                <ObservableActions key={r.id} number={r.case.number} observable={observable}>
                  {row}
                </ObservableActions>
              ) : (
                row()
              );
            })}
            {item.responseActions.length === 0 && (
              <TableRow>
                <TableCell colSpan={actions ? 5 : 4} className="text-muted-foreground">
                  No Response Actions taken on it.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
