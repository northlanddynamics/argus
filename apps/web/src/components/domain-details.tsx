import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { Time } from "@/components/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { communityRow, detectionsRow, joined, KeyLink, NoKey, PopupHeader, Problem, ReportSkeleton, Rows, Tags, Verdict, VirustotalFooter } from "@/components/virustotal-parts";
import { meQuery } from "@/lib/api";
import { type DomainLookup, type DomainReport, domainLookupQuery, useRefreshDomainLookup } from "@/lib/domain-url-lookups";
import { useHoverCardOpen } from "@/lib/hover-card";
import { defang } from "@/lib/observables";

/**
 * What VirusTotal says about a domain (ADR 0012), as the domain context popup and a domain or email
 * Observable's page show it; laid out in `docs/wireframes/domain-url-context-popup.md`. An email
 * address shows its domain's report: VirusTotal is only ever asked about the domain.
 */

/** "#40,210 in Cisco Umbrella": its best rank in a popularity list. */
const rankText = (p: DomainReport["popularity"]) => p[0] && `#${p[0].rank.toLocaleString()} in ${p[0].list}`;

/** The DNS records of `types`, at most three, joined. */
const records = (r: DomainReport, ...types: string[]) =>
  joined(
    r.dns
      .filter((d) => types.includes(d.type))
      .slice(0, 3)
      .map((d) => d.value),
  );

/** The verdict, a warning when the domain is newly registered, then the report as label-value rows. */
function Report({ report: r, newlyRegistered }: { report: DomainReport; newlyRegistered: boolean }) {
  const cert = r.certificate;
  return (
    <div className="grid gap-2">
      <Verdict stats={r.stats} />
      {newlyRegistered && (
        <Problem>
          Newly registered: <Time iso={r.registeredAt!} />
        </Problem>
      )}
      <Tags tags={r.tags} />
      <Rows
        rows={[
          { label: "Categories", value: r.categories.length > 0 && r.categories.slice(0, 3).join(", ") },
          detectionsRow(r.detections, r.stats.malicious),
          {
            label: "Registered",
            value: (r.registeredAt || r.registrar) && (
              <>
                {r.registeredAt && <Time iso={r.registeredAt} className="block" />}
                {r.registrar && <span className="block text-muted-foreground">{r.registrar}</span>}
              </>
            ),
          },
          { label: "Resolves to", value: records(r, "A", "AAAA", "CNAME") && <span className="font-mono text-xs break-all">{records(r, "A", "AAAA", "CNAME")}</span> },
          { label: "Mail", value: records(r, "MX") && <span className="font-mono text-xs break-all">{records(r, "MX")}</span> },
          { label: "Nameservers", value: records(r, "NS") && <span className="font-mono text-xs break-all">{records(r, "NS")}</span> },
          {
            label: "Certificate",
            value: cert && (cert.issuer || cert.validFrom) && (
              <>
                {cert.issuer && <span className="block">{cert.issuer}</span>}
                {cert.validFrom && (
                  <span className="block text-muted-foreground">
                    issued <Time iso={cert.validFrom} />
                  </span>
                )}
              </>
            ),
          },
          { label: "Popularity", value: rankText(r.popularity) },
          { label: "Analysed", value: r.lastAnalysisAt && <Time iso={r.lastAnalysisAt} /> },
          communityRow(r.votes, r.reputation),
        ]}
      />
    </div>
  );
}

/** The body of the popup or card for a domain's lookup: the report, or why there is none. */
export function DomainLookupBody({ lookup, loading, error }: { lookup: DomainLookup | undefined; loading: boolean; error: Error | null }) {
  if (loading && !lookup) return <ReportSkeleton />;
  if (!lookup) return <Problem>{error?.message ?? "Could not look the domain up"}</Problem>;
  switch (lookup.state) {
    case "withheld":
      return <p className="text-muted-foreground">{lookup.withheld}</p>;
    case "no_key":
      return <NoKey what="domains" />;
    case "not_found":
      return <p className="text-muted-foreground">VirusTotal has never seen this domain.</p>;
    case "failed":
      return (
        <div className="grid gap-2">
          <Problem>
            {lookup.error} · <KeyLink>Your key</KeyLink>
          </Problem>
          {lookup.report && <Report report={lookup.report} newlyRegistered={lookup.newlyRegistered} />}
        </div>
      );
    case "found":
      return lookup.report && <Report report={lookup.report} newlyRegistered={lookup.newlyRegistered} />;
  }
}

function DomainFooter({ value, lookup, loading }: { value: string; lookup: DomainLookup | undefined; loading: boolean }) {
  return <VirustotalFooter what={defang("domain", lookup?.domain ?? value)} lookup={lookup} loading={loading} refresh={useRefreshDomainLookup(value)} />;
}

/** VirusTotal's page for a domain, when it may be looked up there. */
const domainHref = (lookup: DomainLookup | undefined) => (lookup && lookup.state !== "withheld" ? `https://www.virustotal.com/gui/domain/${encodeURIComponent(lookup.domain)}` : null);

/** The popup's content; mounted only while it is open, so the lookup starts when it opens. */
function DomainPopup({ type, value }: { type: "domain" | "email"; value: string }) {
  const q = useQuery(domainLookupQuery(value));
  const lookup = q.data;
  const shown = defang(type, value);
  return (
    <div className="grid gap-2.5">
      <PopupHeader shown={shown} copy={shown} copied="Copied (defanged)" href={domainHref(lookup)}>
        {type === "email" && lookup && <span className="text-xs break-all text-muted-foreground">Its domain, {defang("domain", lookup.domain)}</span>}
      </PopupHeader>
      <div className="border-t pt-2.5">
        <DomainLookupBody lookup={lookup} loading={q.isPending} error={q.error} />
      </div>
      {lookup?.state !== "no_key" && lookup?.state !== "withheld" && (
        <div className="border-t pt-2">
          <DomainFooter value={value} lookup={lookup} loading={q.isPending} />
        </div>
      )}
    </div>
  );
}

/**
 * Wraps a domain or email address as it is shown anywhere so that resting the pointer on it, or
 * focusing it, opens what VirusTotal says about the domain. `children` must be one element that can
 * hold a ref, and focusable to open from the keyboard. Guests see the value alone.
 */
export function DomainHoverCard({ type, value, children }: { type: "domain" | "email"; value: string; children: ReactElement }) {
  const me = useQuery(meQuery).data;
  const popup = useHoverCardOpen();
  if (!me?.organization) return children;
  return (
    <HoverCard openDelay={400} closeDelay={150} {...popup}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent className="max-h-(--radix-hover-card-content-available-height) w-80 overflow-y-auto" side="bottom" align="start" collisionPadding={16}>
        <DomainPopup type={type} value={value} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** A domain or email Observable's own page's "VirusTotal": what the popup shows, without needing a hover. */
export function DomainDetailsCard({ type, value }: { type: "domain" | "email"; value: string }) {
  const q = useQuery(domainLookupQuery(value));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{type === "email" && q.data ? `VirusTotal · ${defang("domain", q.data.domain)}` : "VirusTotal"}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <DomainLookupBody lookup={q.data} loading={q.isPending} error={q.error} />
        <DomainFooter value={value} lookup={q.data} loading={q.isPending} />
      </CardContent>
    </Card>
  );
}
