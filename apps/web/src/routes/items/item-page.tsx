import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useRouteContext } from "@tanstack/react-router";
import { BellOffIcon, CheckIcon, CopyIcon, ExternalLinkIcon, FingerprintIcon, LockIcon, MonitorIcon, RefreshCwIcon, SearchIcon, UserIcon } from "lucide-react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  refreshEnrichment,
  setIgnored,
} from "@/lib/observables";
import { falconIocActionLabel, responseActionKindLabel, responseActionStateLabel } from "@/lib/response-actions";
import { exactTime, when } from "@/lib/when";
import { ObservableActions } from "@/routes/cases/observable-actions";
import { FalconIdentitiesCard } from "@/routes/items/falcon-identities-card";

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
      {kind === "asset" && item.type === "account" && !guest && <FalconIdentitiesCard item={item} />}
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

type FalconDevice = ItemPage["falconDevices"][number]["devices"][number];
type HostFacts = NonNullable<FalconDevice["enrichment"]["host"]>;

const containmentLabel: Record<NonNullable<HostFacts["containment"]>, string> = {
  normal: "Not contained",
  containment_pending: "Containment pending",
  contained: "Contained",
  lift_containment_pending: "Lifting containment",
};

/**
 * The Falcon devices recorded on a host, from the detections that name it, each linking to the
 * device in its Integration's Falcon console with what Falcon last reported about it (Enrichment,
 * ADR 0009). Several for one Integration mark the host ambiguous there: the same name has been seen
 * on more than one sensor, and their Enrichment is shown side by side. An Integration with no device
 * recorded looks the host up by hostname, and shows what it found. Opening the page asks again for
 * anything older than 15 minutes; Refresh asks again now. A signal brings the result.
 */
function FalconDevicesCard({ item }: { item: ItemPage }) {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => refreshEnrichment(item.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: itemPagesKey }),
  });
  const devices = item.falconDevices.flatMap((group) => group.devices.map((device) => ({ group, device })));
  const lookups = item.falconDevices.flatMap((group) => (group.devices.length === 0 && group.lookup ? [{ group, lookup: group.lookup }] : []));
  const refreshing = devices.some((d) => d.device.enrichment.refreshing) || lookups.some((l) => l.lookup.refreshing);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Falcon devices</CardTitle>
        {item.falconDevices.length > 0 && (
          <CardAction>
            <Button variant="outline" size="sm" disabled={refresh.isPending || refreshing} onClick={() => refresh.mutate()}>
              <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} aria-hidden />
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        {refresh.error && (
          <Alert variant="destructive">
            <AlertDescription>{refresh.error.message}</AlertDescription>
          </Alert>
        )}
        {item.falconDevices
          .filter((g) => g.integration.enrichmentUnavailable)
          .map((g) => (
            <Alert key={g.integration.id}>
              <AlertDescription>
                {g.integration.name}: {g.integration.enrichmentUnavailable}.
              </AlertDescription>
            </Alert>
          ))}
        {lookups.map(({ group, lookup }) => (
          <HostLookup key={group.integration.id} integration={group.integration.name} lookup={lookup} />
        ))}
        {item.falconDevices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No detection has named its Falcon device yet.</p>
        ) : devices.length === 0 ? null : (
          <div className={devices.length > 1 ? "grid gap-3 md:grid-cols-2" : "grid gap-3"}>
            {devices.map(({ group, device }) => (
              <section
                key={`${group.integration.id} ${device.deviceId}`}
                aria-label={`Falcon device ${device.deviceId}`}
                className="grid min-w-0 content-start gap-3 rounded-lg border p-3"
              >
                <div className="grid gap-1">
                  <a
                    href={device.consoleUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-xs break-all hover:underline"
                  >
                    {device.deviceId}
                    <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Opens in the Falcon console" />
                  </a>
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{group.integration.name}</span>
                    {group.ambiguous && (
                      <Badge variant="outline" title="Several Falcon devices go by this name for this Integration">
                        Ambiguous
                      </Badge>
                    )}
                    <span>
                      · recorded <span title={exactTime(device.recordedAt)}>{when(device.recordedAt)}</span>
                    </span>
                  </p>
                </div>
                <HostEnrichment enrichment={device.enrichment} />
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** How looking the host up by hostname went, through an Integration with no device recorded on it. */
function HostLookup({ integration, lookup }: { integration: string; lookup: NonNullable<ItemPage["falconDevices"][number]["lookup"]> }) {
  const { refreshing, checkedAt, notFound, error } = lookup;
  return (
    <section aria-label={`Looking up in ${integration}`} className="grid gap-1 rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{integration}</p>
      {notFound ? (
        <p className="text-sm">Not found in Falcon.</p>
      ) : (
        !checkedAt && (
          <p className="text-sm text-muted-foreground">{refreshing ? "Looking up this hostname in Falcon…" : "Not looked up in Falcon yet."}</p>
        )
      )}
      {checkedAt && (
        <p className="text-xs text-muted-foreground">
          Checked <span title={exactTime(checkedAt)}>{when(checkedAt)}</span>
          {refreshing && " · checking again…"}
        </p>
      )}
      {error && <p className="text-xs text-destructive">Last lookup failed: {error}</p>}
    </section>
  );
}

/** The values Falcon gave, joined by `by`; null when it gave none. */
const joined = (values: readonly (string | null)[], by: string) => values.filter(Boolean).join(by) || null;

const Time = ({ at }: { at: string }) => <span title={exactTime(at)}>{when(at)}</span>;

/** A host's containment: plain when it isn't contained, marked otherwise. */
const Containment = ({ state }: { state: NonNullable<HostFacts["containment"]> }) =>
  state === "normal" ? containmentLabel.normal : <Badge variant="outline">{containmentLabel[state]}</Badge>;

/** What Falcon last reported about one device, as of when it was fetched. */
function HostEnrichment({ enrichment }: { enrichment: FalconDevice["enrichment"] }) {
  const { host, fetchedAt, notFound, error, refreshing } = enrichment;
  const asOf = fetchedAt && (
    <p className="text-xs text-muted-foreground">
      As of <span title={exactTime(fetchedAt)}>{when(fetchedAt)}</span>
      {refreshing && " · refreshing…"}
    </p>
  );
  const problem = error && <p className="text-xs text-destructive">Last fetch failed: {error}</p>;
  if (notFound) {
    return (
      <div className="grid gap-1">
        <p className="text-sm">Not found in Falcon.</p>
        {asOf}
        {problem}
      </div>
    );
  }
  if (!host) {
    return (
      <div className="grid gap-1">
        {refreshing ? <Skeleton className="h-24" /> : !error && <p className="text-sm text-muted-foreground">Not fetched from Falcon yet.</p>}
        {problem}
      </div>
    );
  }
  const facts: { label: string; value: ReactNode }[] = [
    { label: "Containment", value: host.containment && <Containment state={host.containment} /> },
    { label: "Platform", value: joined([host.platform, host.osVersion], " · ") },
    { label: "Sensor", value: joined([host.sensorVersion, host.sensorStatus], " · ") },
    { label: "First seen", value: host.firstSeen && <Time at={host.firstSeen} /> },
    { label: "Last seen", value: host.lastSeen && <Time at={host.lastSeen} /> },
    { label: "Local IP", value: host.localIp },
    { label: "External IP", value: host.externalIp },
    { label: "MAC", value: host.macAddress },
    { label: "Domain", value: host.domain },
    { label: "OU", value: joined(host.ou, ", ") },
    { label: "Site", value: host.site },
    { label: "Hardware", value: joined([host.manufacturer, host.model], " ") },
    { label: "Serial", value: host.serialNumber },
    { label: "Last logged on", value: host.lastLoggedOnUser },
    { label: "Host groups", value: joined(host.hostGroups, ", ") },
    { label: "Falcon tags", value: joined(host.tags, ", ") },
  ];
  return (
    <div className="grid gap-2">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        {facts.map(({ label, value }) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words">{value ?? <span className="text-muted-foreground">—</span>}</dd>
          </div>
        ))}
      </dl>
      {asOf}
      {problem}
    </div>
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
