import { useQuery } from "@tanstack/react-query";
import { Time } from "@/components/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EnrichmentLayout, KnownLine, SourceSection, ValueHeader } from "@/components/enrichment-parts";
import { communityRow, detectionsRow, joined, KeyLink, NoKey, PANEL_DETECTIONS, Problem, ReportSkeleton, Rows, Tags, Verdict, VirustotalFooter } from "@/components/virustotal-parts";
import { formatBytes } from "@/lib/evidence";
import { type FileReport, type HashLookup, hashLookupQuery, useRefreshHashLookup } from "@/lib/hash-lookups";

/**
 * What VirusTotal says about a file, by its hash (ADR 0011), as the Enrichment panel and a hash
 * Observable's page show it; laid out in `docs/wireframes/hash-context-popup.md` and
 * `enrichment-panel.md`. The parts are shared with domains and URLs (`virustotal-parts.tsx`).
 */

/** The verdict, then the report as label-value rows. `showName` puts the file's name among them, for the card. */
function Report({ report: r, showName, listed }: { report: FileReport; showName: boolean; listed?: number }) {
  return (
    <div className="grid gap-2">
      <Verdict stats={r.stats} />
      <Tags tags={r.tags} />
      <Rows
        rows={[
          { label: "Name", value: showName && r.name && <span className="break-all">{r.name}</span> },
          {
            label: "Threat",
            value: (r.threatLabel || r.threatCategories.length > 0) && (
              <>
                {r.threatLabel && <span className="block font-mono text-xs break-all">{r.threatLabel}</span>}
                {r.threatCategories.length > 0 && <span className="block text-muted-foreground">{r.threatCategories.slice(0, 3).join(", ")}</span>}
              </>
            ),
          },
          detectionsRow(r.detections, r.stats.malicious, listed),
          { label: "Type", value: joined([r.typeDescription, r.size !== null ? formatBytes(r.size) : null], " · ") },
          {
            label: "Also named",
            value: r.names.length > 0 && (
              <span className="break-all">
                {joined(r.names.slice(0, 3))}
                {r.names.length > 3 && ` +${r.names.length - 3}`}
              </span>
            ),
          },
          { label: "Signed by", value: r.signature?.signers && <span title={r.signature.verified ?? undefined}>{r.signature.signers}</span> },
          { label: "First seen", value: r.firstSubmittedAt && <Time iso={r.firstSubmittedAt} /> },
          { label: "Analysed", value: r.lastAnalysisAt && <Time iso={r.lastAnalysisAt} /> },
          communityRow(r.votes, r.reputation),
        ]}
      />
    </div>
  );
}

/**
 * The body of the panel or card for a hash's lookup: the report, or why there is none.
 */
export function HashLookupBody({
  lookup,
  loading,
  error,
  showName = false,
  listed,
}: {
  lookup: HashLookup | undefined;
  loading: boolean;
  error: Error | null;
  showName?: boolean;
  /** How many detections to name before "and N more". */
  listed?: number;
}) {
  if (loading && !lookup) return <ReportSkeleton />;
  if (!lookup) return <Problem>{error?.message ?? "Could not look the hash up"}</Problem>;
  switch (lookup.state) {
    case "no_key":
      return <NoKey what="hashes" />;
    case "not_found":
      return <p className="text-muted-foreground">VirusTotal has never seen this file.</p>;
    case "failed":
      return (
        <div className="grid gap-2">
          <Problem>
            {lookup.error} · <KeyLink>Your key</KeyLink>
          </Problem>
          {lookup.report && <Report report={lookup.report} showName={showName} listed={listed} />}
        </div>
      );
    case "found":
      return lookup.report && <Report report={lookup.report} showName={showName} listed={listed} />;
  }
}

/** "VirusTotal · as of 3 hours ago", with Refresh (or Retry after a failure), or the way to a key. */
export function HashLookupFooter({ hash, lookup, loading, named }: { hash: string; lookup: HashLookup | undefined; loading: boolean; named?: boolean }) {
  return <VirustotalFooter what={hash} lookup={lookup} loading={loading} refresh={useRefreshHashLookup(hash)} named={named} />;
}

/** The Enrichment panel's content for a hash: its header, then what VirusTotal says about the file. */
export function HashEnrichment({ hash, type }: { hash: string; type: "md5" | "sha1" | "sha256" }) {
  const q = useQuery(hashLookupQuery(hash));
  const lookup = q.data;
  const shown = lookup?.hash ?? hash.toLowerCase();
  return (
    <EnrichmentLayout
      header={
        <ValueHeader shown={shown} copy={shown} copied="Copied the hash" href={`https://www.virustotal.com/gui/file/${encodeURIComponent(shown)}`} hrefLabel="Open on VirusTotal">
          {lookup?.report?.name && <span className="text-xs break-all text-muted-foreground">{lookup.report.name}</span>}
          <KnownLine type={type} value={hash} />
        </ValueHeader>
      }
    >
      <SourceSection title="VirusTotal" footer={<HashLookupFooter hash={hash} lookup={lookup} loading={q.isPending} named={false} />}>
        <HashLookupBody lookup={lookup} loading={q.isPending} error={q.error} listed={PANEL_DETECTIONS} />
      </SourceSection>
    </EnrichmentLayout>
  );
}

/** A hash Observable's own page's "VirusTotal": what the Enrichment panel shows. */
export function HashDetailsCard({ hash }: { hash: string }) {
  const q = useQuery(hashLookupQuery(hash));
  return (
    <Card>
      <CardHeader>
        <CardTitle>VirusTotal</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <HashLookupBody lookup={q.data} loading={q.isPending} error={q.error} showName />
        <HashLookupFooter hash={hash} lookup={q.data} loading={q.isPending} />
      </CardContent>
    </Card>
  );
}
