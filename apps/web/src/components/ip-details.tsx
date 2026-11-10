import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import type { FocusEvent, ReactElement, ReactNode } from "react";
import { toast } from "sonner";
import { EnrichmentLayout, KnownLine, SourceSection, ValueHeader } from "@/components/enrichment-parts";
import { ObservableText } from "@/components/observable-details";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Skeleton } from "@/components/ui/skeleton";
import { meQuery } from "@/lib/api";
import { useHoverCardOpen } from "@/lib/hover-card";
import { asTypeLabel, type IpDetails, type IpLookup, ipLookupQuery, useRefreshIpLookup } from "@/lib/ip-lookups";
import { canManage } from "@/lib/roles";
import { cn } from "@/lib/utils";

/**
 * What IPinfo says about an IP (ADR 0010), as the hover card, the Enrichment panel and an IP
 * Observable's page show it; laid out in `docs/wireframes/ip-context-popup.md` and `enrichment-panel.md`.
 */

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

const FLAGS: { key: keyof Pick<IpDetails, "anonymous" | "hosting" | "anycast" | "mobile" | "satellite">; label: string; title: string }[] = [
  { key: "anonymous", label: "Anonymous", title: "A VPN, proxy, Tor exit or relay" },
  { key: "hosting", label: "Hosting", title: "A hosting provider, cloud or data centre" },
  { key: "anycast", label: "Anycast", title: "Announced from many places at once" },
  { key: "mobile", label: "Mobile", title: "A mobile carrier's network" },
  { key: "satellite", label: "Satellite", title: "A satellite provider's network" },
];

const joined = (parts: (string | null)[], sep = ", ") => parts.filter(Boolean).join(sep) || null;

/** The flags that are true, the details as label-value rows; `full`, for the Enrichment panel, adds the postcode and coordinates. */
function Details({ details: d, showHostname, full }: { details: IpDetails; showHostname: boolean; full?: boolean }) {
  const flags = FLAGS.filter((f) => d[f.key]);
  const offset = d.timezone && utcOffset(d.timezone);
  const rows: { label: string; value: ReactNode }[] = [
    { label: "Hostname", value: showHostname && d.hostname && <span className="font-mono text-xs break-all">{d.hostname}</span> },
    {
      label: "Location",
      value: (d.city || d.region || d.country) && (
        <>
          {joined([d.city, d.region, full ? d.postalCode : null]) && <span className="block">{joined([d.city, d.region, full ? d.postalCode : null])}</span>}
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
            {d.asn && <span className="font-mono text-xs">{d.asn}</span>}
            {d.asn && d.asName && " · "}
            {d.asName}
          </span>
          {d.asDomain && <span className="block text-muted-foreground">{d.asDomain}</span>}
        </>
      ),
    },
    { label: "Coordinates", value: full && d.latitude !== null && d.longitude !== null && <span className="font-mono text-xs">{d.latitude}, {d.longitude}</span> },
    { label: "Type", value: d.asType && asTypeLabel[d.asType] },
    { label: "Time zone", value: d.timezone && (offset ? `${d.timezone} (${offset})` : d.timezone) },
  ];
  return (
    <div className="grid gap-2">
      {flags.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label="Flags">
          {flags.map((f) => (
            <Badge
              key={f.key}
              variant="outline"
              title={f.title}
              className={cn(f.key === "anonymous" && "border-notice-border bg-notice text-notice-foreground")}
            >
              {f.label}
            </Badge>
          ))}
        </div>
      )}
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
 * puts the reverse DNS name among the rows, for the card, which has no header to show it in.
 */
export function IpLookupBody({
  lookup,
  loading,
  error,
  admin,
  showHostname = false,
  full,
}: {
  lookup: IpLookup | undefined;
  loading: boolean;
  error: Error | null;
  admin: boolean;
  showHostname?: boolean;
  full?: boolean;
}) {
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
      return lookup.details ? <Details details={lookup.details} showHostname={showHostname} full={full} /> : <Unconfigured admin={admin} paused />;
    case "failed":
      return (
        <div className="grid gap-2">
          <Problem>{lookup.error}</Problem>
          {lookup.details && <Details details={lookup.details} showHostname={showHostname} full={full} />}
        </div>
      );
    case "found":
      return lookup.details && <Details details={lookup.details} showHostname={showHostname} full={full} />;
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
  const publicIp = !lookup || lookup.state !== "reserved";
  return (
    <EnrichmentLayout
      header={
        <ValueHeader shown={shown} copy={shown} copied={`Copied ${shown}`} href={publicIp ? `https://ipinfo.io/${encodeURIComponent(shown)}` : null} hrefLabel="Open on ipinfo.io">
          {lookup?.details?.hostname && <span className="font-mono text-xs break-all text-muted-foreground">{lookup.details.hostname}</span>}
          <KnownLine type="ip" value={ip} />
        </ValueHeader>
      }
    >
      {lookup?.state === "reserved" ? (
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

/** The hover card's content; mounted only while it is open, so the lookup starts when it opens. */
function IpCard({ ip, admin }: { ip: string; admin: boolean }) {
  const q = useQuery(ipLookupQuery(ip));
  const lookup = q.data;
  const shown = lookup?.ip ?? ip;
  const publicIp = !lookup || lookup.state !== "reserved";
  const footer = !lookup || (lookup.state !== "reserved" && lookup.state !== "unconfigured");
  return (
    <div className="grid gap-2.5" data-testid="ip-hover-card">
      <ValueHeader shown={shown} copy={shown} copied={`Copied ${shown}`} href={publicIp ? `https://ipinfo.io/${encodeURIComponent(shown)}` : null} hrefLabel="Open on ipinfo.io">
        {lookup?.details?.hostname && <span className="font-mono text-xs break-all text-muted-foreground">{lookup.details.hostname}</span>}
      </ValueHeader>
      <div className="border-t pt-2.5">
        <IpLookupBody lookup={lookup} loading={q.isPending} error={q.error} admin={admin} />
        {lookup?.state === "reserved" && lookup.reserved?.range && (
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
      <HoverCardTrigger asChild onFocus={(e: FocusEvent) => e.preventDefault()}>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>IP details</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <IpLookupBody lookup={q.data} loading={q.isPending} error={q.error} admin={admin} showHostname />
        <IpLookupFooter ip={ip} lookup={q.data} loading={q.isPending} />
      </CardContent>
    </Card>
  );
}
