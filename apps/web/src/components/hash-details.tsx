import { useQuery } from "@tanstack/react-query";
import { Time } from "@/components/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EnrichmentLayout, KnownLine, SourceSection, ValueHeader } from "@/components/enrichment-parts";
import { communityRow, detectionsRow, joined, KeyLink, listed, NoKey, Problem, ReportSkeleton, Rows, Tags, Verdict, VirustotalFooter } from "@/components/virustotal-parts";
import { formatBytes } from "@/lib/evidence";
import { type FileReport, type HashLookup, hashLookupQuery, useRefreshHashLookup } from "@/lib/hash-lookups";

/**
 * What VirusTotal says about a file, by its hash (ADR 0011), as the Enrichment panel and a hash
 * Observable's page show it; laid out in `docs/wireframes/hash-context-popup.md` and
 * `enrichment-panel.md`. The parts are shared with domains and URLs (`virustotal-parts.tsx`).
 */

const hashText = (h: string | null) => h && <span className="font-mono text-xs break-all">{h}</span>;

/**
 * The verdict, then the report as label-value rows. `showName` puts the file's name among them, for
 * the card; `full`, for the Enrichment panel, lists everything VirusTotal reported rather than the first few.
 */
function Report({ report: r, showName, full }: { report: FileReport; showName: boolean; full?: boolean }) {
  return (
    <div className="grid gap-2">
      <Verdict stats={r.stats} />
      <Tags tags={r.tags} full={full} />
      <Rows
        rows={[
          { label: "Name", value: showName && r.name && <span className="break-all">{r.name}</span> },
          { label: "MD5", value: full && hashText(r.md5) },
          { label: "SHA-1", value: full && hashText(r.sha1) },
          { label: "SHA-256", value: full && hashText(r.sha256) },
          {
            label: "Threat",
            value: (r.threatLabel || r.threatCategories.length > 0) && (
              <>
                {r.threatLabel && <span className="block font-mono text-xs break-all">{r.threatLabel}</span>}
                {r.threatCategories.length > 0 && <span className="block text-muted-foreground">{listed(r.threatCategories, full).join(", ")}</span>}
                {full && r.threatNames.length > 0 && <span className="block font-mono text-xs break-all text-muted-foreground">{r.threatNames.join(", ")}</span>}
              </>
            ),
          },
          detectionsRow(r.detections, r.stats.malicious, full),
          { label: "Type", value: joined([r.typeDescription, r.size !== null ? formatBytes(r.size) : null], " · ") },
          {
            label: "Also named",
            value: r.names.length > 0 && (
              <span className="break-all">
                {joined(listed(r.names, full))}
                {!full && r.names.length > 3 && ` +${r.names.length - 3}`}
              </span>
            ),
          },
          { label: "Signed by", value: r.signature?.signers && <span title={r.signature.verified ?? undefined}>{r.signature.signers}</span> },
          { label: "First seen", value: r.firstSubmittedAt && <Time iso={r.firstSubmittedAt} /> },
          { label: "Last seen", value: full && r.lastSubmittedAt && <Time iso={r.lastSubmittedAt} /> },
          { label: "Submitted", value: full && r.timesSubmitted !== null && `${r.timesSubmitted.toLocaleString()} ${r.timesSubmitted === 1 ? "time" : "times"}` },
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
  full,
}: {
  lookup: HashLookup | undefined;
  loading: boolean;
  error: Error | null;
  showName?: boolean;
  /** Everything VirusTotal reported, for the Enrichment panel, rather than the first few. */
  full?: boolean;
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
          {lookup.report && <Report report={lookup.report} showName={showName} full={full} />}
        </div>
      );
    case "found":
      return lookup.report && <Report report={lookup.report} showName={showName} full={full} />;
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
        <HashLookupBody lookup={lookup} loading={q.isPending} error={q.error} full />
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
      <CardContent className="grid gap-3">
        <HashLookupBody lookup={q.data} loading={q.isPending} error={q.error} showName />
        <HashLookupFooter hash={hash} lookup={q.data} loading={q.isPending} />
      </CardContent>
    </Card>
  );
}
