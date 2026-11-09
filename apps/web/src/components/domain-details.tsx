import { useQuery } from "@tanstack/react-query";
import { Time } from "@/components/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EnrichmentLayout, FollowValue, KnownLine, SourceSection, ValueHeader } from "@/components/enrichment-parts";
import { communityRow, detectionsRow, KeyLink, listed, NoKey, Problem, ReportSkeleton, Rows, Tags, Verdict, VirustotalFooter } from "@/components/virustotal-parts";
import { type DomainLookup, type DomainReport, domainLookupQuery, useRefreshDomainLookup } from "@/lib/domain-url-lookups";
import type { EnrichableType } from "@/lib/enrichment";
import { defang } from "@/lib/observables";

/**
 * What VirusTotal says about a domain (ADR 0012), as the Enrichment panel and a domain or email
 * Observable's page show it; laid out in `docs/wireframes/domain-url-context-popup.md` and
 * `enrichment-panel.md`. Its DNS records open their own Enrichment. An email
 * address shows its domain's report: VirusTotal is only ever asked about the domain.
 */

/** "#40,210 in Cisco Umbrella": its best rank in a popularity list. */
const rankText = (p: DomainReport["popularity"]) => p[0] && `#${p[0].rank.toLocaleString()} in ${p[0].list}`;

/** What a DNS record points at, as an Observable: an address for A and AAAA, a name for the rest. */
const recordType = (type: string): EnrichableType => (type === "A" || type === "AAAA" ? "ip" : "domain");

const hasRecords = (r: DomainReport, types: string[]) => r.dns.some((d) => types.includes(d.type));

/** The DNS records of `types`, at most three or every one when `full`, each opening its own Enrichment. */
function Records({ report, types, full }: { report: DomainReport; types: string[]; full?: boolean }) {
  const all = report.dns.filter((d) => types.includes(d.type));
  const found = listed(all, full);
  return (
    <span className="grid justify-items-start">
      {found.map((d) => {
        const type = recordType(d.type);
        const value = d.value.replace(/\.$/, "");
        return (
          <FollowValue key={`${d.type}:${d.value}`} type={type} value={value}>
            {defang(type, value)}
          </FollowValue>
        );
      })}
      {all.length > found.length && <span className="text-muted-foreground">and {all.length - found.length} more</span>}
    </span>
  );
}

/**
 * The verdict, a warning when the domain is newly registered, then the report as label-value rows;
 * `full`, for the Enrichment panel, lists everything VirusTotal reported rather than the first few.
 */
function Report({ report: r, newlyRegistered, full }: { report: DomainReport; newlyRegistered: boolean; full?: boolean }) {
  const cert = r.certificate;
  return (
    <div className="grid gap-2">
      <Verdict stats={r.stats} />
      {newlyRegistered && (
        <Problem>
          Newly registered: <Time iso={r.registeredAt!} />
        </Problem>
      )}
      <Tags tags={r.tags} full={full} />
      <Rows
        rows={[
          { label: "Categories", value: r.categories.length > 0 && listed(r.categories, full).join(", ") },
          detectionsRow(r.detections, r.stats.malicious, full),
          {
            label: "Registered",
            value: (r.registeredAt || r.registrar) && (
              <>
                {r.registeredAt && <Time iso={r.registeredAt} className="block" />}
                {r.registrar && <span className="block text-muted-foreground">{r.registrar}</span>}
              </>
            ),
          },
          { label: "Resolves to", value: hasRecords(r, ["A", "AAAA", "CNAME"]) && <Records report={r} types={["A", "AAAA", "CNAME"]} full={full} /> },
          { label: "Mail", value: hasRecords(r, ["MX"]) && <Records report={r} types={["MX"]} full={full} /> },
          { label: "Nameservers", value: hasRecords(r, ["NS"]) && <Records report={r} types={["NS"]} full={full} /> },
          {
            label: "Certificate",
            value: cert && (cert.issuer || cert.validFrom || (full && (cert.subject || cert.validUntil))) && (
              <>
                {full && cert.subject && <span className="block font-mono text-xs break-all">{cert.subject}</span>}
                {cert.issuer && <span className="block">{cert.issuer}</span>}
                {cert.validFrom && (
                  <span className="block text-muted-foreground">
                    issued <Time iso={cert.validFrom} />
                  </span>
                )}
                {full && cert.validUntil && (
                  <span className="block text-muted-foreground">
                    expires <Time iso={cert.validUntil} />
                  </span>
                )}
              </>
            ),
          },
          {
            label: "Popularity",
            value: full
              ? r.popularity.length > 0 && (
                  <>
                    {r.popularity.map((p) => (
                      <span key={p.list} className="block">
                        #{p.rank.toLocaleString()} in {p.list}
                      </span>
                    ))}
                  </>
                )
              : rankText(r.popularity),
          },
          { label: "Analysed", value: r.lastAnalysisAt && <Time iso={r.lastAnalysisAt} /> },
          communityRow(r.votes, r.reputation),
        ]}
      />
    </div>
  );
}

/** The body of the panel or card for a domain's lookup: the report, or why there is none. */
export function DomainLookupBody({ lookup, loading, error, full }: { lookup: DomainLookup | undefined; loading: boolean; error: Error | null; full?: boolean }) {
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
          {lookup.report && <Report report={lookup.report} newlyRegistered={lookup.newlyRegistered} full={full} />}
        </div>
      );
    case "found":
      return lookup.report && <Report report={lookup.report} newlyRegistered={lookup.newlyRegistered} full={full} />;
  }
}

function DomainFooter({ value, lookup, loading, named }: { value: string; lookup: DomainLookup | undefined; loading: boolean; named?: boolean }) {
  return <VirustotalFooter what={defang("domain", lookup?.domain ?? value)} lookup={lookup} loading={loading} refresh={useRefreshDomainLookup(value)} named={named} />;
}

/** VirusTotal's page for a domain, when it may be looked up there. */
const domainHref = (lookup: DomainLookup | undefined) => (lookup && lookup.state !== "withheld" ? `https://www.virustotal.com/gui/domain/${encodeURIComponent(lookup.domain)}` : null);

/** The Enrichment panel's content for a domain or email address: its header, then what VirusTotal says about the domain. */
export function DomainEnrichment({ type, value }: { type: "domain" | "email"; value: string }) {
  const q = useQuery(domainLookupQuery(value));
  const lookup = q.data;
  const shown = defang(type, value);
  const withheld = lookup?.state === "withheld";
  return (
    <EnrichmentLayout
      header={
        <ValueHeader shown={shown} copy={shown} copied="Copied (defanged)" href={domainHref(lookup)} hrefLabel="Open on VirusTotal">
          {type === "email" && lookup && <span className="text-xs break-all text-muted-foreground">Its domain, {defang("domain", lookup.domain)}</span>}
          <KnownLine type={type} value={value} />
        </ValueHeader>
      }
    >
      {withheld ? (
        <div className="p-4 text-sm">
          <DomainLookupBody lookup={lookup} loading={false} error={null} />
        </div>
      ) : (
        <SourceSection title="VirusTotal" footer={<DomainFooter value={value} lookup={lookup} loading={q.isPending} named={false} />}>
          <DomainLookupBody lookup={lookup} loading={q.isPending} error={q.error} full />
        </SourceSection>
      )}
    </EnrichmentLayout>
  );
}

/** A domain or email Observable's own page's "VirusTotal": what the Enrichment panel shows. */
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
