import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader, PageTitle } from "@/components/page-header";
import { DomainDetailsCard } from "@/components/domain-details";
import { HashDetailsCard } from "@/components/hash-details";
import { IpDetailsCard, IpText } from "@/components/ip-details";
import { UmbrellaCard } from "@/components/umbrella-details";
import { UrlDetailsCard } from "@/components/url-details";
import { FactGroups, type FactGroup, joined } from "@/components/fact-groups";
import { ObservableMenu } from "@/components/observable-menu";
import { Link, useParams, useRouteContext } from "@tanstack/react-router";
import { BellOffIcon, CheckIcon, CopyIcon, ExternalLinkIcon,  LockIcon,  RefreshCwIcon, SearchIcon, StarIcon, StarOffIcon } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { CaseRef } from "@/components/case-ref";
import { ItemText, ItemTypeIcon, ItemValue } from "@/components/item-value";
import { Time } from "@/components/time";
import { SeverityBadge, StatusBadge } from "@/components/case-badges";
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
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useMe } from "@/lib/api";
import { alertStatusLabel, alertsKey } from "@/lib/alerts";
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
  setImportant,
} from "@/lib/observables";
import { falconIocActionLabel, responseActionKindLabel, responseActionStateLabel } from "@/lib/response-actions";
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
/** Columns shown from `sm`; below it their cells stay in the row, emptied, so the columns keep their widths. */
const fromSm = "overflow-hidden px-0 sm:px-2";
const showSm = "hidden sm:inline";

function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[/?&=.])/);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

function TypeIcon({ item }: { kind: ItemKind; item: ItemPage }) {
  return <ItemTypeIcon type={item.type} decorative className="size-4" />;
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
      <div className="grid w-full grid-cols-1 gap-4">
        <Skeleton className="h-16" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (page.isError) return <p className="py-8 text-center text-sm text-destructive">{page.error.message}. Try again.</p>;
  if (!item) {
    return (
      <div className="grid w-full grid-cols-1 gap-4">
        <PageHeader title={`${noun[kind]} not found`} description="It doesn't exist, or it isn't on any Case you can see." />
      </div>
    );
  }

  return (
    <div className="grid w-full grid-cols-1 gap-4">
      <section aria-label={noun[kind]} className="grid gap-1">
        <PageHeader
          heading={
            <ObservableMenu observable={kind === "observable" ? { type: item.type as ObservableType, value: item.value } : null}>
              <PageTitle className="font-mono [overflow-wrap:anywhere]" title={item.value}>
                <Breakable text={shown(kind, item)} />
              </PageTitle>
            </ObservableMenu>
          }
          description={
            <p className="flex items-center gap-1.5 text-xs">
              <TypeIcon kind={kind} item={item} />
              {noun[kind]} · {typeLabel(kind, item)}
            </p>
          }
          actions={
            <>
              <CopyButton text={shown(kind, item)} />
              <Button variant="outline" size="sm" asChild>
                <Link to="/search" search={{ q: item.value }}>
                  <SearchIcon />
                  Search for this
                </Link>
              </Button>
              {kind === "observable" && !guest && <ImportantButton item={item} />}
              {canManage(me.organization?.role) && <IgnoreButton kind={kind} item={item} />}
            </>
          }
        />
        {item.important && (
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <Badge variant="outline">
              <StarIcon aria-hidden />
              Important
            </Badge>
            <span>
              Marked Important by {item.important.by.name} <Time iso={item.important.at} />, so it relates Alerts to Cases.
            </span>
          </p>
        )}
        {item.ignored && (
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <Badge variant="outline">
              <BellOffIcon aria-hidden />
              Ignored
            </Badge>
            <span>
              Added to the Ignored list by {item.ignored.by.name}{" "}
              <Time iso={item.ignored.at} />.
            </span>
          </p>
        )}
        <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">First seen</dt>
            <dd><Time iso={item.firstSeen} /></dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">Last seen</dt>
            <dd><Time iso={item.lastSeen} /></dd>
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

      {kind === "observable" && item.type === "ip" && !guest && <IpDetailsCard ip={item.value} admin={canManage(me.organization?.role)} />}
      {kind === "observable" && (item.type === "md5" || item.type === "sha1" || item.type === "sha256") && !guest && <HashDetailsCard hash={item.value} />}
      {kind === "observable" && (item.type === "domain" || item.type === "email") && !guest && <DomainDetailsCard type={item.type} value={item.value} />}
      {kind === "observable" && (item.type === "domain" || item.type === "email") && !guest && <UmbrellaCard value={item.value} />}
      {kind === "observable" && item.type === "url" && !guest && <UrlDetailsCard url={item.value} />}
      {kind === "asset" && item.type === "host" && !guest && <FalconDevicesCard item={item} />}
      {kind === "asset" && item.type === "account" && !guest && <FalconIdentitiesCard item={item} />}
      <CasesCard item={item} actions={kind === "observable" && !guest} />
      {!guest && <AlertsCard item={item} />}
      {kind === "observable" && <ResponseActionsCard item={item} actions={!guest} />}
    </div>
  );
}

/**
 * Members mark an Observable Important, Organization-wide, so it relates Alerts to Cases, or unmark it.
 * Easily undone, so it doesn't ask first.
 */
function ImportantButton({ item }: { item: ItemPage }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => setImportant(item.id, !item.important),
    onSettled: () => Promise.all([queryClient.invalidateQueries({ queryKey: [...itemPagesKey] }), queryClient.invalidateQueries({ queryKey: alertsKey })]),
  });
  return (
    <div className="grid justify-items-end gap-1">
      <Button variant="outline" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
        {item.important ? <StarOffIcon /> : <StarIcon />}
        {item.important ? "Unmark Important" : "Mark Important"}
      </Button>
      {toggle.isError && <p className="text-xs text-destructive">{toggle.error.message}</p>}
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
          <AlertDialogDescription>
              <span className="font-mono text-xs [overflow-wrap:anywhere]">{shown(kind, item)}</span>
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
          <div className={devices.length > 1 ? "grid gap-3 @3xl:grid-cols-2" : "grid gap-3"}>
            {devices.map(({ group, device }) => (
              <section
                key={`${group.integration.id} ${device.deviceId}`}
                aria-label={`Falcon device ${device.deviceId}`}
                className={cn("grid min-w-0 content-start gap-3", devices.length > 1 && "rounded-lg border p-3")}
              >
                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                  <a
                    href={device.consoleUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-mono break-all text-foreground hover:underline"
                  >
                    {device.deviceId}
                    <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Opens in the Falcon console" />
                  </a>
                  <span>· {group.integration.name}</span>
                  {group.ambiguous && (
                    <>
                      <Badge variant="outline" title="Several Falcon devices go by this name for this Integration">
                        Ambiguous
                      </Badge>
                      <span>
                        · recorded <Time iso={device.recordedAt} />
                      </span>
                    </>
                  )}
                  {device.enrichment.fetchedAt && (
                    <span>
                      · as of <Time iso={device.enrichment.fetchedAt} />
                      {device.enrichment.refreshing && " · refreshing…"}
                    </span>
                  )}
                </p>
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
          Checked <Time iso={checkedAt} />
          {refreshing && " · checking again…"}
        </p>
      )}
      {error && <p className="text-xs text-destructive">Last lookup failed: {error}</p>}
    </section>
  );
}

/** A host's containment: plain when it isn't contained, marked otherwise. */
const Containment = ({ state }: { state: NonNullable<HostFacts["containment"]> }) =>
  state === "normal" ? containmentLabel.normal : <Badge variant="outline">{containmentLabel[state]}</Badge>;

/**
 * What Falcon last reported about one device, in four groups: its state, where it is on the network,
 * what the machine is, and where it sits in the directory. When it was fetched is said above it.
 */
function HostEnrichment({ enrichment }: { enrichment: FalconDevice["enrichment"] }) {
  const { host, notFound, error, refreshing } = enrichment;
  const problem = error && <p className="text-xs text-destructive">Last fetch failed: {error}</p>;
  if (notFound) {
    return (
      <div className="grid gap-1">
        <p className="text-sm">Not found in Falcon.</p>
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
  const groups: FactGroup[] = [
    {
      label: "State",
      facts: [
        { label: "Containment", value: host.containment && <Containment state={host.containment} /> },
        { label: "Sensor", value: joined([host.sensorVersion, host.sensorStatus], " · ") },
        { label: "Last seen", value: host.lastSeen && <Time iso={host.lastSeen} /> },
        { label: "First seen", value: host.firstSeen && <Time iso={host.firstSeen} /> },
      ],
    },
    {
      label: "Network",
      facts: [
        { label: "Local IP", value: host.localIp && <IpText ip={host.localIp} /> },
        { label: "External IP", value: host.externalIp && <IpText ip={host.externalIp} /> },
        { label: "MAC", value: host.macAddress && <span className="font-mono text-xs">{host.macAddress}</span> },
      ],
    },
    {
      label: "Machine",
      facts: [
        { label: "Platform", value: joined([host.platform, host.osVersion], " · ") },
        { label: "Hardware", value: joined([host.manufacturer, host.model], " ") },
        { label: "Serial", value: host.serialNumber && <span className="font-mono text-xs">{host.serialNumber}</span> },
        { label: "Last user", value: host.lastLoggedOnUser && <span className="font-mono text-xs">{host.lastLoggedOnUser}</span> },
      ],
    },
    {
      label: "Directory",
      facts: [
        { label: "Domain", value: host.domain },
        { label: "OU", value: joined(host.ou, ", ") },
        { label: "Site", value: host.site },
        { label: "Host groups", value: joined(host.hostGroups, ", ") },
        { label: "Falcon tags", value: joined(host.tags, ", ") },
      ],
    },
  ];
  return (
    <div className="grid gap-2">
      <FactGroups groups={groups} source="Falcon" />
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
    <Card className="@container">
      <CardHeader>
        <CardTitle>Cases</CardTitle>
      </CardHeader>
      <CardContent>
        <Table aria-label="Linked Cases" className="@3xl:table-fixed">
          {/* Set widths, in the Cases list's order (Severity, then Status), so these lists read the same way. */}
          <colgroup>
            <col />
            <col className="@3xl:w-28 @7xl:w-[8.75%]" />
            <col className="@3xl:w-44 @7xl:w-[13.75%]" />
            <col className="@3xl:w-44 @7xl:w-[13.75%]" />
            <col className="@3xl:w-32 @7xl:w-[10%]" />
            {actions && <col className="@3xl:w-12" />}
          </colgroup>
          <TableHeader className={item.cases.length ? undefined : "sr-only"}>
            <TableRow variant="static">
              <TableHead>Case</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className={fromSm}><span className={showSm}>Assignee</span></TableHead>
              <TableHead>Linked</TableHead>
              {actions && (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {item.cases.map((c) => {
              const row = (menuButton?: ReactNode) => (
                <TableRow key={c.number}>
                  <TableCell className="whitespace-normal break-words">
                    <Link to="/cases/$number" params={{ number: String(c.number) }} className="hover:underline">
                      <span className="font-mono text-xs text-muted-foreground">{caseRef(c.number)}</span> <span className="font-medium">{c.title}</span>
                    </Link>
                    {c.restricted && <LockIcon className="ml-1 inline size-3 text-muted-foreground" aria-label="Restricted" />}
                  </TableCell>
                  <TableCell>
                    <SeverityBadge severity={c.severity} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={c.status} />
                  </TableCell>
                  <TableCell className={cn(fromSm, "truncate", !c.assignee && "text-muted-foreground")} title={c.assignee?.name}>
                    <span className={showSm}>{c.assignee?.name ?? "Unassigned"}</span>
                  </TableCell>
                  <TableCell className="truncate text-muted-foreground">
                    <Time iso={c.linkedAt} />
                  </TableCell>
                  {menuButton && <TableCell className="text-right">{menuButton}</TableCell>}
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
              <TableRow variant="static">
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
    <Card className="@container">
      <CardHeader>
        <CardTitle>Alerts naming it</CardTitle>
      </CardHeader>
      <CardContent>
        <Table aria-label="Alerts naming it" className="@3xl:table-fixed">
          {/* The same widths as the Cases above, so Severity and Status line up between the two. */}
          <colgroup>
            <col />
            <col className="@3xl:w-28 @7xl:w-[8.75%]" />
            <col className="@3xl:w-44 @7xl:w-[13.75%]" />
            <col className="@3xl:w-44 @7xl:w-[13.75%]" />
            <col className="@3xl:w-32 @7xl:w-[10%]" />
          </colgroup>
          <TableHeader className={item.alerts.length ? undefined : "sr-only"}>
            <TableRow variant="static">
              <TableHead>Alert</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Alert Status</TableHead>
              <TableHead className={fromSm}><span className={showSm}>Case</span></TableHead>
              <TableHead>Raised</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {item.alerts.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="whitespace-normal break-words">
                  <Link to="/alerts" search={{ status: "any", alert: a.id }} className="font-medium hover:underline" title={a.externalId}>
                    {a.title}
                  </Link>
                  {a.host &&
                    (a.hostAsset && a.hostAsset.id !== item.id ? (
                      <ItemValue item={{ kind: "asset", id: a.hostAsset.id, type: "host", value: a.host }} id={a.hostAsset.id} className="flex w-fit" />
                    ) : (
                      <ItemText type="host" value={a.host} className="flex" />
                    ))}
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={a.severity} />
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{alertStatusLabel[a.status]}</Badge>
                </TableCell>
                <TableCell className={fromSm}>
                  <span className={showSm}>
                  {a.case ? (
                    <CaseRef number={a.case.number} title={a.case.title} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  </span>
                </TableCell>
                <TableCell className="truncate text-muted-foreground">
                  <Time iso={a.seenAt} />
                </TableCell>
              </TableRow>
            ))}
            {item.alerts.length === 0 && (
              <TableRow variant="static">
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
    <Card className="@container">
      <CardHeader>
        <CardTitle>Response Actions</CardTitle>
      </CardHeader>
      <CardContent>
        <Table aria-label="Response Actions" className="@3xl:table-fixed">
          <colgroup>
            <col className="@3xl:w-[30%]" />
            <col className="@3xl:w-36 @7xl:w-[11.25%]" />
            <col />
            <col className="@3xl:w-44 @7xl:w-[13.75%]" />
            {actions && <col className="@3xl:w-12" />}
          </colgroup>
          <TableHeader className={item.responseActions.length ? undefined : "sr-only"}>
            <TableRow variant="static">
              <TableHead>Action</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Case</TableHead>
              <TableHead>When</TableHead>
              {actions && (
                <TableHead>
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
                  <TableCell className="truncate">
                    <Link to="/cases/$number/observables" params={{ number: String(r.case.number) }} className="hover:underline" title={r.case.title}>
                      <span className="font-mono text-xs text-muted-foreground">{caseRef(r.case.number)}</span> {r.case.title}
                    </Link>
                  </TableCell>
                  <TableCell className="truncate text-muted-foreground">
                    {r.sentAt ? <Time iso={r.sentAt} prefix="Sent" /> : <Time iso={r.requestedAt} prefix="Requested" />}
                  </TableCell>
                  {menuButton && <TableCell className="text-right">{menuButton}</TableCell>}
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
              <TableRow variant="static">
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
