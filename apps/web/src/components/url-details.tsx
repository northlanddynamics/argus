import { useQuery } from "@tanstack/react-query";
import { Time } from "@/components/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EnrichmentLayout, FollowValue, KnownLine, SourceSection, ValueHeader } from "@/components/enrichment-parts";
import { communityRow, detectionsRow, joined, KeyLink, NoKey, PANEL_DETECTIONS, Problem, ReportSkeleton, Rows, Tags, Verdict, VirustotalFooter } from "@/components/virustotal-parts";
import { type UrlLookup, type UrlReport, urlLookupQuery, useRefreshUrlLookup } from "@/lib/domain-url-lookups";
import { defang } from "@/lib/observables";

/**
 * What VirusTotal says about a URL (ADR 0012), as the Enrichment panel and a URL Observable's page
 * show it; laid out in `docs/wireframes/domain-url-context-popup.md` and `enrichment-panel.md`. Argus only looks URLs up:
 * it never submits one for scanning, so VirusTotal never visits it on a Member's behalf.
 */

/** The verdict, then the report as label-value rows. */
function Report({ report: r, listed }: { report: UrlReport; listed?: number }) {
  return (
    <div className="grid gap-2">
      <Verdict stats={r.stats} />
      <Tags tags={r.tags} />
      <Rows
        rows={[
          { label: "Title", value: r.title && <span className="break-all">{r.title}</span> },
          {
            label: "Ends at",
            value: r.finalUrl && (
              <FollowValue type="url" value={r.finalUrl}>
                {defang("url", r.finalUrl)}
              </FollowValue>
            ),
          },
          { label: "Redirects", value: r.redirects.length > 1 && `${r.redirects.length - 1} before it ends` },
          { label: "Response", value: r.httpStatus !== null && `HTTP ${r.httpStatus}` },
          { label: "Categories", value: r.categories.length > 0 && r.categories.slice(0, 3).join(", ") },
          detectionsRow(r.detections, r.stats.malicious, listed),
          { label: "Threats", value: r.threatNames.length > 0 && <span className="font-mono text-xs break-all">{joined(r.threatNames.slice(0, 3))}</span> },
          { label: "First seen", value: r.firstSubmittedAt && <Time iso={r.firstSubmittedAt} /> },
          { label: "Analysed", value: r.lastAnalysisAt && <Time iso={r.lastAnalysisAt} /> },
          communityRow(r.votes, r.reputation),
        ]}
      />
    </div>
  );
}

/** The body of the panel or card for a URL's lookup: the report, or why there is none. */
export function UrlLookupBody({ lookup, loading, error, listed }: { lookup: UrlLookup | undefined; loading: boolean; error: Error | null; listed?: number }) {
  if (loading && !lookup) return <ReportSkeleton />;
  if (!lookup) return <Problem>{error?.message ?? "Could not look the URL up"}</Problem>;
  switch (lookup.state) {
    case "withheld":
      return <p className="text-muted-foreground">{lookup.withheld}</p>;
    case "no_key":
      return <NoKey what="URLs" />;
    case "not_found":
      return <p className="text-muted-foreground">VirusTotal has never seen this URL. Argus doesn't submit URLs for scanning.</p>;
    case "failed":
      return (
        <div className="grid gap-2">
          <Problem>
            {lookup.error} · <KeyLink>Your key</KeyLink>
          </Problem>
          {lookup.report && <Report report={lookup.report} listed={listed} />}
        </div>
      );
    case "found":
      return lookup.report && <Report report={lookup.report} listed={listed} />;
  }
}

function UrlFooter({ url, lookup, loading, named }: { url: string; lookup: UrlLookup | undefined; loading: boolean; named?: boolean }) {
  return <VirustotalFooter what={defang("url", url)} lookup={lookup} loading={loading} refresh={useRefreshUrlLookup(url)} named={named} />;
}

/** The Enrichment panel's content for a URL: its header, then what VirusTotal says about it. */
export function UrlEnrichment({ url }: { url: string }) {
  const q = useQuery(urlLookupQuery(url));
  const lookup = q.data;
  const shown = defang("url", lookup?.url ?? url);
  // VirusTotal's page for a URL is under its own identifier, known only once it has reported on it.
  const href = lookup?.report?.id ? `https://www.virustotal.com/gui/url/${encodeURIComponent(lookup.report.id)}` : null;
  return (
    <EnrichmentLayout
      header={
        <ValueHeader shown={shown} copy={shown} copied="Copied (defanged)" href={href} hrefLabel="Open on VirusTotal">
          <KnownLine type="url" value={url} />
        </ValueHeader>
      }
    >
      {lookup?.state === "withheld" ? (
        <div className="p-4 text-sm">
          <UrlLookupBody lookup={lookup} loading={false} error={null} />
        </div>
      ) : (
        <SourceSection title="VirusTotal" footer={<UrlFooter url={url} lookup={lookup} loading={q.isPending} named={false} />}>
          <UrlLookupBody lookup={lookup} loading={q.isPending} error={q.error} listed={PANEL_DETECTIONS} />
        </SourceSection>
      )}
    </EnrichmentLayout>
  );
}

/** A URL Observable's own page's "VirusTotal": what the Enrichment panel shows. */
export function UrlDetailsCard({ url }: { url: string }) {
  const q = useQuery(urlLookupQuery(url));
  return (
    <Card>
      <CardHeader>
        <CardTitle>VirusTotal</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <UrlLookupBody lookup={q.data} loading={q.isPending} error={q.error} />
        <UrlFooter url={url} lookup={q.data} loading={q.isPending} />
      </CardContent>
    </Card>
  );
}
