import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { type FocusEvent, type ReactElement, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { CardPager } from "@/components/card-pager";
import { EnrichmentLayout, KnownLine, SourceSection, ValueHeader } from "@/components/enrichment-parts";
import { ObservableText } from "@/components/observable-details";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FalconHostsCompact, FalconHostsSections, RangeLine } from "@/components/ip-falcon-hosts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Skeleton } from "@/components/ui/skeleton";
import { meQuery } from "@/lib/api";
import { observableLookups } from "@/lib/observables";
import { useHoverCardOpen } from "@/lib/hover-card";
import { asTypeLabel, type IpDetails, type IpLookup, ipLookupQuery, reservedRange, useRefreshIpLookup } from "@/lib/ip-lookups";
import { canManage } from "@/lib/roles";
import { cn } from "@/lib/utils";

/**
 * What IPinfo Plus says about an IP (ADR 0010), as the hover card (a page at a time), the
 * Enrichment panel and an IP Observable's page (everything, by subject) show it; laid out in `docs/wireframes/ip-context-popup.md` and `enrichment-panel.md`.
 * An internal IP shows what Falcon says last reported it instead (ADR 0018, `ip-falcon-hosts.tsx`).
 */

/** Whether `ip` is an internal address, looked up in Falcon: known from the address itself, before any answer. */
const internalIp = (ip: string, lookup: IpLookup | undefined) => lookup?.reserved?.internal ?? reservedRange(ip)?.internal ?? false;

/** 🇩🇪 for "DE". */
const flag = (code: string) => (/^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "");

/** "UTC+1" for "Europe/Berlin", now. */
function utcOffset(timeZone: string) {
  try {
    const part = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
    return part?.value.replace(/^GMT/, "UTC") || null;
  } catch {
    return null;
  }
}

/** "14 Mar 2025" for "2025-03-14"; IPinfo's change dates are days, not instants. */
function day(date: string) {
  const at = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? date : at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

const joined = (parts: (string | null)[], sep = ", ") => parts.filter(Boolean).join(sep) || null;
const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;
const mono = (text: string) => <span className="font-mono text-xs">{text}</span>;
/** "Hesse (HE)", or whichever of the two IPinfo gave. */
const withCode = (name: string | null, code: string | null) => (name && code ? `${name} (${code})` : (name ?? code));
/** Yes or No; a Yes worth an Analyst's attention in the notice tone. */
const yesNo = (value: boolean, notice = false) =>
  value ? (
    notice ? (
      <Badge variant="notice">Yes</Badge>
    ) : (
      "Yes"
    )
  ) : (
    muted("No")
  );

type Row = { label: string; value: ReactNode };

/**
 * The flags that are true, in this order: which kinds of anonymity (VPN, Proxy, Tor, Relay, or
 * Anonymous when IPinfo didn't say which) in the notice tone, then Hosting, Anycast, Mobile, Satellite.
 */
function flags(d: IpDetails): { label: string; title: string; notice: boolean }[] {
  const kinds = [
    { on: d.vpn, label: "VPN", title: "A VPN service's address" },
    { on: d.proxy, label: "Proxy", title: "An open, web or residential proxy" },
    { on: d.tor, label: "Tor", title: "A Tor exit node" },
    { on: d.relay, label: "Relay", title: "A privacy relay, such as iCloud Private Relay" },
  ].filter((k) => k.on);
  const anonymous = kinds.length
    ? kinds.map((k) => ({ label: k.label, title: d.anonymousService ? `${k.title}: ${d.anonymousService}` : k.title, notice: true }))
    : d.anonymous
      ? [{ label: "Anonymous", title: d.anonymousService ?? "A VPN, proxy, Tor exit or relay", notice: true }]
      : [];
  return [
    ...anonymous,
    ...[
      { on: d.hosting, label: "Hosting", title: "A hosting provider, cloud or data centre" },
      { on: d.anycast, label: "Anycast", title: "Announced from many places at once" },
      { on: d.mobile, label: "Mobile", title: d.carrier ? `On ${d.carrier}'s mobile network` : "A mobile carrier's network" },
      { on: d.satellite, label: "Satellite", title: "A satellite provider's network" },
    ]
      .filter((f) => f.on)
      .map((f) => ({ label: f.label, title: f.title, notice: false })),
  ];
}

function Flags({ details }: { details: IpDetails }) {
  const shown = flags(details);
  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap gap-1" aria-label="Flags">
      {shown.map((f) => (
        <Badge key={f.label} variant={f.notice ? "notice" : "outline"} title={f.title}>
          {f.label}
        </Badge>
      ))}
    </div>
  );
}

/** Label-value rows, leaving out those with nothing to show. */
function Rows({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1">
      {rows
        .filter((r) => r.value !== null && r.value !== undefined && r.value !== false && r.value !== "")
        .map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0 break-words">{r.value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** The time zone with its offset now: "Europe/Berlin (UTC+1)". */
const timeZone = (d: IpDetails) => {
  const offset = d.timezone && utcOffset(d.timezone);
  return d.timezone && (offset ? `${d.timezone} (${offset})` : d.timezone);
};

/** What answers "where is it and who runs it" at a glance: the hover card's first page. */
function summaryRows(d: IpDetails, showHostname: boolean): Row[] {
  return [
    { label: "Hostname", value: showHostname && d.hostname && <span className="font-mono text-xs break-all">{d.hostname}</span> },
    {
      label: "Location",
      value: (d.city || d.region || d.country) && (
        <>
          {joined([d.city, d.region]) && <span className="block">{joined([d.city, d.region])}</span>}
          {d.country && (
            <span className="block">
              {d.countryCode && <span aria-hidden>{flag(d.countryCode)} </span>}
              {joined([d.country, d.continent], " · ")}
            </span>
          )}
        </>
      ),
    },
    {
      label: "Network",
      value: (d.asn || d.asName) && (
        <>
          <span className="block">
            {d.asn && mono(d.asn)}
            {d.asn && d.asName && " · "}
            {d.asName}
          </span>
          {d.asDomain && <span className="block text-muted-foreground">{d.asDomain}</span>}
        </>
      ),
    },
    { label: "Type", value: d.asType && asTypeLabel[d.asType] },
    { label: "Anonymiser", value: d.anonymousService },
    { label: "Carrier", value: d.carrier },
    { label: "Time zone", value: timeZone(d) },
  ];
}

type Section = { key: "location" | "network" | "privacy" | "mobile"; title: string; rows: Row[] };

/** Everything IPinfo Plus says, by subject: the hover card's other pages and the panel's sections. */
function sections(d: IpDetails, showHostname: boolean): Section[] {
  const map =
    d.latitude !== null && d.longitude !== null
      ? `https://www.openstreetmap.org/?mlat=${d.latitude}&mlon=${d.longitude}#map=${d.accuracyRadius && d.accuracyRadius > 50 ? 8 : 11}/${d.latitude}/${d.longitude}`
      : null;
  return [
    {
      key: "location",
      title: "Location",
      rows: [
        { label: "City", value: d.city },
        { label: "Region", value: withCode(d.region, d.regionCode) },
        { label: "Postcode", value: d.postalCode && mono(d.postalCode) },
        {
          label: "Country",
          value: (d.country || d.countryCode) && (
            <>
              {d.countryCode && <span aria-hidden>{flag(d.countryCode)} </span>}
              {withCode(d.country, d.countryCode)}
            </>
          ),
        },
        { label: "Continent", value: withCode(d.continent, d.continentCode) },
        {
          label: "Coordinates",
          value: map && (
            <a href={map} target="_blank" rel="noreferrer noopener" className="font-mono text-xs underline underline-offset-2 hover:text-muted-foreground" title="Open on OpenStreetMap">
              {d.latitude}, {d.longitude}
            </a>
          ),
        },
        { label: "Accuracy", value: d.accuracyRadius !== null && `Within ${d.accuracyRadius.toLocaleString("en-GB")} km` },
        { label: "Time zone", value: timeZone(d) },
        { label: "Metro (DMA)", value: d.dmaCode && mono(d.dmaCode) },
        { label: "GeoNames ID", value: d.geonameId && mono(d.geonameId) },
        { label: "Changed on", value: d.locationChangedOn && day(d.locationChangedOn) },
      ],
    },
    {
      key: "network",
      title: "Network",
      rows: [
        { label: "Hostname", value: showHostname && d.hostname && <span className="font-mono text-xs break-all">{d.hostname}</span> },
        { label: "ASN", value: d.asn && mono(d.asn) },
        { label: "Name", value: d.asName },
        { label: "Domain", value: d.asDomain },
        { label: "Type", value: d.asType && asTypeLabel[d.asType] },
        { label: "Hosting", value: yesNo(d.hosting) },
        { label: "Anycast", value: yesNo(d.anycast) },
        { label: "Changed on", value: d.asChangedOn && day(d.asChangedOn) },
      ],
    },
    {
      key: "privacy",
      title: "Privacy",
      rows: [
        { label: "Anonymous", value: yesNo(d.anonymous, true) },
        { label: "VPN", value: yesNo(d.vpn, true) },
        { label: "Proxy", value: yesNo(d.proxy, true) },
        { label: "Tor", value: yesNo(d.tor, true) },
        { label: "Relay", value: yesNo(d.relay, true) },
        { label: "Service", value: d.anonymousService },
      ],
    },
    {
      key: "mobile",
      title: "Mobile",
      rows: [
        { label: "Mobile", value: yesNo(d.mobile) },
        { label: "Carrier", value: d.carrier },
        { label: "MCC", value: d.mcc && mono(d.mcc) },
        { label: "MNC", value: d.mnc && mono(d.mnc) },
        { label: "Satellite", value: yesNo(d.satellite) },
      ],
    },
  ];
}

/** The hover card's pages: the summary, then a page per subject; Mobile only when there is something mobile or satellite to say. */
function cardPages(d: IpDetails): { title: string; body: ReactNode }[] {
  const relevant = sections(d, false).filter((s) => s.key !== "mobile" || d.mobile || d.satellite || d.carrier || d.mcc);
  return [
    {
      title: "Summary",
      body: (
        <div className="grid gap-2">
          <Flags details={d} />
          <Rows rows={summaryRows(d, false)} />
        </div>
      ),
    },
    ...relevant.map((s) => ({ title: s.title, body: <Rows rows={s.rows} /> })),
  ];
}

/** The flags, then every section with its heading: the Enrichment panel and an IP Observable's page. */
function FullDetails({ details: d, showHostname }: { details: IpDetails; showHostname: boolean }) {
  return (
    <div className="grid gap-4">
      <Flags details={d} />
      {sections(d, showHostname).map((s) => (
        <section key={s.key} aria-label={s.title} className="grid gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">{s.title}</h4>
          <Rows rows={s.rows} />
        </section>
      ))}
    </div>
  );
}

/** The summary alone, the flags then the rows. */
function Details({ details: d, showHostname }: { details: IpDetails; showHostname: boolean }) {
  return (
    <div className="grid gap-2">
      <Flags details={d} />
      <Rows rows={summaryRows(d, showHostname)} />
    </div>
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

function DetailsSkeleton() {
  return (
    <div className="grid gap-1.5" aria-label="Looking up">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

/** "Your Organization hasn't connected IPinfo", with the way to fix it for those who can. */
function Unconfigured({ admin, paused }: { admin: boolean; paused: boolean }) {
  if (admin) {
    return (
      <div className="grid gap-2">
        <p>{paused ? "IPinfo is paused, so nothing new is looked up." : "No IP details yet."}</p>
        <Button asChild size="sm" variant="outline" className="justify-self-start">
          <Link to="/settings/integrations">{paused ? "Resume" : "Add"} IPinfo in Settings · Integrations</Link>
        </Button>
      </div>
    );
  }
  return (
    <p className="text-muted-foreground">
      {paused ? "IPinfo is paused, so nothing new is looked up." : "No IP details: your Organization hasn't connected IPinfo."} An Admin can{" "}
      {paused ? "resume" : "add"} it in Settings · Integrations.
    </p>
  );
}

/**
 * The body of the panel or card for `ip`'s lookup: details, or why there are none. `showHostname`
 * puts the reverse DNS name among the rows, for the card, which has no header to show it in. `full`
 * shows everything IPinfo said, by subject; `page`, the hover card's, shows the details its own way.
 */
export function IpLookupBody({
  lookup,
  loading,
  error,
  admin,
  showHostname = false,
  full,
  page,
}: {
  lookup: IpLookup | undefined;
  loading: boolean;
  error: Error | null;
  admin: boolean;
  showHostname?: boolean;
  full?: boolean;
  page?: (details: IpDetails) => ReactNode;
}) {
  const shown = (d: IpDetails) => (page ? page(d) : full ? <FullDetails details={d} showHostname={showHostname} /> : <Details details={d} showHostname={showHostname} />);
  if (loading && !lookup) return <DetailsSkeleton />;
  if (!lookup) return <Problem>{error?.message ?? "Could not look the IP up"}</Problem>;
  switch (lookup.state) {
    case "reserved":
      return (
        <div className="grid gap-1">
          <p className="font-medium">
            {lookup.reserved?.label} address{lookup.reserved?.range && <span className="font-mono text-xs font-normal"> ({lookup.reserved.range})</span>}
          </p>
          {!lookup.reserved?.range && <p className="text-muted-foreground">IPinfo holds nothing for it: it isn't routed on the public internet.</p>}
        </div>
      );
    case "unconfigured":
      return <Unconfigured admin={admin} paused={false} />;
    case "paused":
      return lookup.details ? shown(lookup.details) : <Unconfigured admin={admin} paused />;
    case "failed":
      return (
        <div className="grid gap-2">
          <Problem>{lookup.error}</Problem>
          {lookup.details && shown(lookup.details)}
        </div>
      );
    case "found":
      return lookup.details && shown(lookup.details);
  }
}

/** "IPinfo · as of 3 hours ago", with Refresh (or Retry after a failure); `named` false drops "IPinfo ·" where a heading says it. */
export function IpLookupFooter({ ip, lookup, loading, named = true }: { ip: string; lookup: IpLookup | undefined; loading: boolean; named?: boolean }) {
  const refresh = useRefreshIpLookup(ip);
  if (lookup && (lookup.state === "reserved" || lookup.state === "unconfigured")) return null;
  const busy = loading || refresh.isPending;
  const canRefresh = lookup && lookup.state !== "paused";
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {named && "IPinfo · "}
        {!lookup ? "looking up…" : refresh.isPending ? "refreshing…" : lookup.fetchedAt ? <Time iso={lookup.fetchedAt} prefix="as of" /> : "never looked up"}
      </span>
      {canRefresh && (
        <Button
          variant="ghost"
          size="xs"
          disabled={busy}
          onClick={() => refresh.mutate(undefined, { onError: (e) => toast.error(e.message) })}
          aria-label={`${lookup.state === "failed" ? "Retry looking up" : "Refresh"} ${ip}`}
        >
          <RefreshCwIcon className={cn(refresh.isPending && "animate-spin")} aria-hidden />
          {lookup.state === "failed" ? "Retry" : "Refresh"}
        </Button>
      )}
    </div>
  );
}

/** The Enrichment panel's content for an IP: its header, then what IPinfo says. */
export function IpEnrichment({ ip, admin }: { ip: string; admin: boolean }) {
  const q = useQuery(ipLookupQuery(ip));
  const lookup = q.data;
  const shown = lookup?.ip ?? ip;
  const internal = internalIp(ip, lookup);
  const range = lookup?.reserved ?? reservedRange(ip);
  const publicIp = !internal && (!lookup || lookup.state !== "reserved");
  return (
    <EnrichmentLayout
      header={
        <ValueHeader shown={shown} copy={shown} copied={`Copied ${shown}`} links={publicIp ? observableLookups("ip", shown) : []}>
          {lookup?.details?.hostname && <span className="font-mono text-xs break-all text-muted-foreground">{lookup.details.hostname}</span>}
          {internal && range && <RangeLine reserved={range} />}
          <KnownLine type="ip" value={ip} />
        </ValueHeader>
      }
    >
      {internal ? (
        <FalconHostsSections ip={ip} lookup={lookup} loading={q.isPending} admin={admin} />
      ) : lookup?.state === "reserved" ? (
        <div className="p-4 text-sm">
          <IpLookupBody lookup={lookup} loading={false} error={null} admin={admin} />
          {lookup.reserved?.range && (
            <p className="mt-1 text-muted-foreground">Not looked up: it means nothing outside the network it belongs to, and Argus doesn't send internal addresses to IPinfo.</p>
          )}
        </div>
      ) : (
        <SourceSection title="IPinfo" footer={<IpLookupFooter ip={ip} lookup={lookup} loading={q.isPending} named={false} />}>
          <IpLookupBody lookup={lookup} loading={q.isPending} error={q.error} admin={admin} full />
        </SourceSection>
      )}
    </EnrichmentLayout>
  );
}

/**
 * The hover card's content; mounted only while it is open, so the lookup starts when it opens. A
 * public IP's details show a page at a time (summary, Location, Network, Privacy, Mobile), stepped
 * through with the pager the account card uses for several identities.
 */
function IpCard({ ip, admin }: { ip: string; admin: boolean }) {
  const q = useQuery(ipLookupQuery(ip));
  const [index, setIndex] = useState(0);
  const lookup = q.data;
  const shown = lookup?.ip ?? ip;
  const internal = internalIp(ip, lookup);
  const range = lookup?.reserved ?? reservedRange(ip);
  const publicIp = !internal && (!lookup || lookup.state !== "reserved");
  const footer = !internal && (!lookup || (lookup.state !== "reserved" && lookup.state !== "unconfigured"));
  const pages = !internal && lookup?.details && lookup.state !== "reserved" ? cardPages(lookup.details) : [];
  const at = Math.min(index, Math.max(pages.length - 1, 0));
  // While it looks up and once it has pages, the body keeps one height and a long page scrolls
  // inside it: a card that grew or shrank on stepping could flip above or below the IP and slip
  // out from under the pointer, which closes it.
  const fixed = !internal && (q.isPending || pages.length > 0);
  return (
    <div className="grid gap-2.5" data-testid="ip-hover-card">
      <ValueHeader shown={shown} copy={shown} copied={`Copied ${shown}`} links={publicIp ? observableLookups("ip", shown) : []}>
        {lookup?.details?.hostname && <span className="font-mono text-xs break-all text-muted-foreground">{lookup.details.hostname}</span>}
        {internal && range && <RangeLine reserved={range} />}
      </ValueHeader>
      {pages.length > 1 && <CardPager at={at} count={pages.length} onStep={setIndex} noun="page" label={pages[at]!.title} />}
      <div className={cn("border-t pt-2.5", fixed && "h-52 overflow-y-auto overscroll-contain")} data-testid="ip-hover-card-body">
        {internal ? (
          <FalconHostsCompact ip={ip} lookup={lookup} loading={q.isPending} admin={admin} card />
        ) : (
          <IpLookupBody lookup={lookup} loading={q.isPending} error={q.error} admin={admin} page={() => pages[at]?.body} />
        )}
        {!internal && lookup?.state === "reserved" && lookup.reserved?.range && (
          <p className="mt-1 text-muted-foreground">Not looked up: it means nothing outside the network it belongs to, and Argus doesn't send internal addresses to IPinfo.</p>
        )}
      </div>
      {footer && (
        <div className="border-t pt-2">
          <IpLookupFooter ip={ip} lookup={lookup} loading={q.isPending} />
        </div>
      )}
    </div>
  );
}

/**
 * Wraps an IP as it is shown anywhere (a link to its page, a badge, plain text) so that resting the
 * pointer on it opens what IPinfo says about it (`docs/wireframes/ip-context-popup.md`). Focus
 * doesn't open it: from the keyboard, `I` opens the Enrichment panel. `children` must be one element
 * that can hold a ref. `enabled` false leaves it as it is; `held` keeps the card shut without
 * remounting the IP (while the Enrichment panel shows it, so focus can return to it). Guests see the IP alone: Argus never
 * spends the Organization's IPinfo quota on their behalf.
 */
export function IpHoverCard({ ip, enabled = true, held = false, children }: { ip: string; enabled?: boolean; held?: boolean; children: ReactElement }) {
  const role = useQuery(meQuery).data?.organization?.role;
  const card = useHoverCardOpen();
  if (!enabled || !role) return children;
  return (
    <HoverCard openDelay={400} closeDelay={150} open={card.open && !held} onOpenChange={card.onOpenChange}>
      <HoverCardTrigger asChild data-hovercard="" onFocus={(e: FocusEvent) => e.preventDefault()}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent className="w-80" side="bottom" align="start" collisionPadding={16}>
        <IpCard ip={ip} admin={canManage(role)} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** Plain IP text, with the Observable right-click menu, that opens the Enrichment panel. */
export function IpText({ ip, className }: { ip: string; className?: string }) {
  return (
    <ObservableText type="ip" value={ip} className={className}>
      {ip}
    </ObservableText>
  );
}

/** An IP Observable's own page's "IP details": what the Enrichment panel shows. */
export function IpDetailsCard({ ip, admin }: { ip: string; admin: boolean }) {
  const q = useQuery(ipLookupQuery(ip));
  const range = q.data?.reserved ?? reservedRange(ip);
  if (internalIp(ip, q.data)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Hosts in Falcon</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {range && <RangeLine reserved={range} />}
          <FalconHostsCompact ip={ip} lookup={q.data} loading={q.isPending} admin={admin} card={false} />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>IP details</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <IpLookupBody lookup={q.data} loading={q.isPending} error={q.error} admin={admin} showHostname full />
        <IpLookupFooter ip={ip} lookup={q.data} loading={q.isPending} />
      </CardContent>
    </Card>
  );
}
