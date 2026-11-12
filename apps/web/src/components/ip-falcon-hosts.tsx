import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, ExternalLinkIcon, InfoIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { SourceSection } from "@/components/enrichment-parts";
import { ItemContext } from "@/components/item-context";
import { ItemLink } from "@/components/item-link";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useEnrichmentPanel } from "@/lib/enrichment";
import { type IpLookup, useRefreshIpLookup } from "@/lib/ip-lookups";
import { cn } from "@/lib/utils";

/**
 * What the Organization's CrowdStrike Integrations say last reported an internal IP (ADR 0018), as
 * the hover card, the Enrichment panel and an IP Observable's page show it; laid out in
 * `docs/wireframes/ip-falcon-lookup.md`. Always "last reported": an address is leased again, so
 * Argus never says which host it is.
 */

type FalconLookup = NonNullable<IpLookup["falcon"]>[number];
type IpHost = FalconLookup["hosts"][number];

/** How many hosts the hover card lists before "and N more". */
const CARD_HOSTS = 3;
/** From this many hosts the address is likely reused on each, and the card says so. */
const MANY_HOSTS = 5;
/** A host not seen for this long may have handed the address on. */
const STALE_MS = 7 * 24 * 60 * 60_000;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const stale = (h: IpHost) => !!h.host?.lastSeen && Date.now() - Date.parse(h.host.lastSeen) > STALE_MS;
const containmentText = { containment_pending: "Containing", contained: "Contained", lift_containment_pending: "Lifting containment" } as const;

/** "Private address · 10.0.0.0/8", under the value in a header. */
export function RangeLine({ reserved }: { reserved: { label: string; range: string | null } }) {
  return (
    <span className="text-xs text-muted-foreground">
      {reserved.label} address{reserved.range && <span className="font-mono"> · {reserved.range}</span>}
    </span>
  );
}

/**
 * The host's name: a link to its Asset page when Argus holds it, with ↗ to the Falcon console. In
 * the panel the link has the host's hover card; in the IP's hover card it doesn't, as a card opens
 * no card of its own.
 */
function HostName({ h, className, inCard = false }: { h: IpHost; className?: string; inCard?: boolean }) {
  const name = h.host?.hostname ?? h.deviceId;
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      {h.asset ? (
        <ItemContext item={{ kind: "asset", id: h.asset.id, type: "host", value: name }} hoverCard={!inCard}>
          <ItemLink kind="asset" id={h.asset.id} className="min-w-0 truncate font-medium underline underline-offset-2 hover:text-muted-foreground" title="Open its page">
            {name}
          </ItemLink>
        </ItemContext>
      ) : (
        <span className="min-w-0 truncate font-medium">{name}</span>
      )}
      <Button variant="ghost" size="icon-xs" asChild className="shrink-0">
        <a href={h.consoleUrl} target="_blank" rel="noreferrer noopener" aria-label={`Open ${name} in Falcon`} title="Open in Falcon">
          <ExternalLinkIcon aria-hidden />
        </a>
      </Button>
    </span>
  );
}

function ContainmentBadge({ h }: { h: IpHost }) {
  const c = h.host?.containment;
  if (!c || c === "normal") return null;
  return (
    <Badge variant="destructive" className="justify-self-start">
      {containmentText[c]}
    </Badge>
  );
}

/** "Windows 11 · last seen 4 min ago", or why there's nothing to say. */
function Summary({ h }: { h: IpHost }) {
  if (!h.host) return <span className="text-muted-foreground">Falcon no longer knows this device</span>;
  const os = h.host.osVersion ?? h.host.platform;
  return (
    <span className="text-muted-foreground">
      {os}
      {os && h.host.lastSeen && " · "}
      {h.host.lastSeen && <Time iso={h.host.lastSeen} prefix="last seen" />}
      {stale(h) && " — may have moved on"}
    </span>
  );
}

/** One host in the hover card: name, summary, user and containment when alone; name and summary on a line when one of several. */
function CardHost({ h, alone }: { h: IpHost; alone: boolean }) {
  if (!alone) {
    return (
      <li className={cn("grid gap-0.5", stale(h) && "opacity-60")}>
        <span className="flex min-w-0 items-center gap-1.5">
          <HostName h={h} className="flex-1" inCard />
          <ContainmentBadge h={h} />
        </span>
        <span className="text-xs">
          <Summary h={h} />
        </span>
      </li>
    );
  }
  return (
    <li className={cn("grid gap-0.5", stale(h) && "opacity-60")}>
      <HostName h={h} inCard />
      <span className="text-xs">
        <Summary h={h} />
      </span>
      {h.host?.lastLoggedOnUser && <span className="font-mono text-xs text-muted-foreground">{h.host.lastLoggedOnUser}</span>}
      <ContainmentBadge h={h} />
    </li>
  );
}

/** A host's facts as the panel lists them. */
function HostRows({ h }: { h: IpHost }) {
  const d = h.host;
  if (!d) return null;
  const rows: { label: string; value: ReactNode }[] = [
    { label: "Platform", value: d.osVersion ?? d.platform },
    { label: "Last seen", value: d.lastSeen && <Time iso={d.lastSeen} /> },
    { label: "User", value: d.lastLoggedOnUser && <span className="font-mono text-xs break-all">{d.lastLoggedOnUser}</span> },
    { label: "MAC", value: d.macAddress && <span className="font-mono text-xs">{d.macAddress}</span> },
    { label: "Site / OU", value: [d.site, d.ou.join(" / ")].filter(Boolean).join(" · ") || null },
    { label: "Groups", value: d.hostGroups.join(", ") || null },
    { label: "Sensor", value: [d.sensorVersion, d.sensorStatus].filter(Boolean).join(" · ") || null },
    { label: "Containment", value: d.containment && (d.containment === "normal" ? "Not contained" : containmentText[d.containment]) },
  ];
  return (
    <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1">
      {rows
        .filter((r) => r.value)
        .map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0 break-words">{r.value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** One host in the panel: a card, collapsed to its name and summary when there are many. */
function PanelHost({ h, collapsed }: { h: IpHost; collapsed: boolean }) {
  const head = (
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="flex items-center gap-1.5">
        <HostName h={h} className="flex-1" />
        {h.asset && (
          <Badge variant="outline" className="shrink-0">
            Held as a host
          </Badge>
        )}
      </span>
      <span className="text-xs">
        <Summary h={h} />
      </span>
      <ContainmentBadge h={h} />
    </span>
  );
  const frame = cn("rounded-md border p-2.5", stale(h) && "opacity-60");
  if (!collapsed) {
    return (
      <li className={cn(frame, "grid gap-2")}>
        {head}
        <HostRows h={h} />
      </li>
    );
  }
  return (
    <li className={frame}>
      <details className="group grid gap-2">
        <summary className="flex cursor-pointer list-none items-start gap-1 [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon aria-hidden className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          {head}
        </summary>
        <div className="mt-2 pl-4.5">
          <HostRows h={h} />
        </div>
      </details>
    </li>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-1.5 rounded-md border border-notice-border bg-notice px-2 py-1.5 text-notice-foreground">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** "CrowdStrike · as of 2 min ago", with Refresh (Retry after a failure; none while paused). */
function Footer({ ip, f, named, loading }: { ip: string; f: FalconLookup | null; named: string | null; loading: boolean }) {
  const refresh = useRefreshIpLookup(ip);
  const status =
    !f || loading ? "looking up…"
    : refresh.isPending ? "refreshing…"
    : f.state === "paused" ? "CrowdStrike is paused"
    : f.fetchedAt ? <Time iso={f.fetchedAt} prefix="as of" />
    : "never looked up";
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {named && `${named} · `}
        {status}
      </span>
      {f && f.state !== "paused" && (
        <Button
          variant="ghost"
          size="xs"
          disabled={loading || refresh.isPending}
          onClick={() => refresh.mutate(undefined, { onError: (e) => toast.error(e.message) })}
          aria-label={`${f.state === "failed" ? "Retry looking up" : "Refresh"} ${ip} in Falcon`}
        >
          <RefreshCwIcon className={cn(refresh.isPending && "animate-spin")} aria-hidden />
          {f.state === "failed" ? "Retry" : "Refresh"}
        </Button>
      )}
    </div>
  );
}

/** The section's heading: "CrowdStrike", or "CrowdStrike · EU tenant" when the Organization has several. */
const sourceName = (f: FalconLookup, several: boolean) => (several ? `CrowdStrike · ${f.integration.name}` : "CrowdStrike");

/** What one Integration says, as a list: the hosts, or why there are none. */
function Body({ ip, f, card, admin }: { ip: string; f: FalconLookup; card: boolean; admin: boolean }) {
  const panel = useEnrichmentPanel();
  const shown = card ? f.hosts.slice(0, CARD_HOSTS) : f.hosts;
  const more = f.total - shown.length;
  return (
    <div className="grid gap-2">
      {f.state === "failed" && f.error && <Problem>{f.error}</Problem>}
      {f.state === "paused" && !f.hosts.length && (
        <div className="grid gap-2">
          <p className="text-muted-foreground">CrowdStrike is paused, so nothing is looked up.{!admin && " An Admin can resume it in Settings · Integrations."}</p>
          {admin && (
            <Button asChild size="sm" variant="outline" className="justify-self-start">
              <Link to="/settings/integrations">Resume CrowdStrike in Settings · Integrations</Link>
            </Button>
          )}
        </div>
      )}
      {f.state === "found" && !f.hosts.length && (
        <p className="text-muted-foreground">
          No host in Falcon last reported this address. It may be a device without a sensor (a server, printer or phone), or the host that had it has moved on.
        </p>
      )}
      {f.hosts.length > 0 && (
        <>
          <p className="text-xs font-medium text-muted-foreground">
            Last reported by{f.total > 1 && ` ${plural(f.total, "host")}`}
          </p>
          <ul className="grid gap-1.5">
            {shown.map((h) => (card ? <CardHost key={h.deviceId} h={h} alone={f.total === 1} /> : <PanelHost key={h.deviceId} h={h} collapsed={f.hosts.length > CARD_HOSTS} />))}
          </ul>
          {more > 0 &&
            (card ? (
              <p className="text-xs text-muted-foreground">
                and {more} more
                {panel.available && (
                  <>
                    {" · "}
                    <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => panel.open({ type: "ip", value: ip })}>
                      Show all (I)
                    </button>
                  </>
                )}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Falcon matched {f.total}; showing the {shown.length} seen most recently.
              </p>
            ))}
          {f.total >= MANY_HOSTS && (
            <p className="flex gap-1.5 text-xs text-muted-foreground">
              <InfoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              Many hosts share this address; it is likely reused on each one.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function HostsSkeleton() {
  return (
    <div className="grid gap-1.5" aria-label="Looking up">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

/** Today's words for an internal address when the Organization has no CrowdStrike Integration. */
export function NotLookedUp() {
  return <p className="text-muted-foreground">Not looked up: it means nothing outside the network it belongs to, and Argus doesn't send internal addresses to IPinfo.</p>;
}

/**
 * The Falcon part of an internal IP's hover card or Observable-page card: each Integration's hosts
 * and its own "as of" footer, a skeleton while looking up, or `NotLookedUp` without CrowdStrike.
 */
export function FalconHostsCompact({ ip, lookup, loading, admin, card }: { ip: string; lookup: IpLookup | undefined; loading: boolean; admin: boolean; card: boolean }) {
  if (!lookup) {
    return (
      <div className="grid gap-2.5">
        <HostsSkeleton />
        <Footer ip={ip} f={null} named="CrowdStrike" loading />
      </div>
    );
  }
  const falcon = lookup.falcon ?? [];
  if (!falcon.length) return <NotLookedUp />;
  return (
    <div className="grid gap-2.5">
      {falcon.map((f) => (
        <div key={f.integration.id} className="grid gap-2">
          <Body ip={ip} f={f} card={card} admin={admin} />
          <Footer ip={ip} f={f} named={sourceName(f, falcon.length > 1)} loading={loading} />
        </div>
      ))}
    </div>
  );
}

/** The Falcon sections of an internal IP's Enrichment panel. */
export function FalconHostsSections({ ip, lookup, loading, admin }: { ip: string; lookup: IpLookup | undefined; loading: boolean; admin: boolean }) {
  if (!lookup) {
    return (
      <SourceSection title="CrowdStrike" footer={<Footer ip={ip} f={null} named={null} loading />}>
        <HostsSkeleton />
      </SourceSection>
    );
  }
  const falcon = lookup.falcon ?? [];
  if (!falcon.length) {
    return (
      <div className="p-4 text-sm">
        <NotLookedUp />
      </div>
    );
  }
  return falcon.map((f) => (
    <SourceSection key={f.integration.id} title={sourceName(f, falcon.length > 1)} footer={<Footer ip={ip} f={f} named={null} loading={loading} />}>
      <Body ip={ip} f={f} card={false} admin={admin} />
    </SourceSection>
  ));
}
