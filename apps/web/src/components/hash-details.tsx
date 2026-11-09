import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { Time } from "@/components/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { communityRow, detectionsRow, joined, KeyLink, NoKey, PopupHeader, Problem, ReportSkeleton, Rows, Tags, Verdict, VirustotalFooter } from "@/components/virustotal-parts";
import { meQuery } from "@/lib/api";
import { useHoverCardOpen } from "@/lib/hover-card";
import { formatBytes } from "@/lib/evidence";
import { type FileReport, type HashLookup, hashLookupQuery, useRefreshHashLookup } from "@/lib/hash-lookups";

/**
 * What VirusTotal says about a file, by its hash (ADR 0011), as the hash context popup and a hash
 * Observable's page show it; laid out in `docs/wireframes/hash-context-popup.md`. The conventions
 * are the IP context popup's (`ip-details.tsx`); the parts are shared with domains and URLs
 * (`virustotal-parts.tsx`).
 */

/** The verdict, then the report as label-value rows. `showName` puts the file's name among them, for the card. */
function Report({ report: r, showName }: { report: FileReport; showName: boolean }) {
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
          detectionsRow(r.detections, r.stats.malicious),
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
 * The body of the popup or card for a hash's lookup: the report, or why there is none.
 */
export function HashLookupBody({ lookup, loading, error, showName = false }: { lookup: HashLookup | undefined; loading: boolean; error: Error | null; showName?: boolean }) {
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
          {lookup.report && <Report report={lookup.report} showName={showName} />}
        </div>
      );
    case "found":
      return lookup.report && <Report report={lookup.report} showName={showName} />;
  }
}

/** "VirusTotal · as of 3 hours ago", with Refresh (or Retry after a failure), or the way to a key. */
export function HashLookupFooter({ hash, lookup, loading }: { hash: string; lookup: HashLookup | undefined; loading: boolean }) {
  return <VirustotalFooter what={hash} lookup={lookup} loading={loading} refresh={useRefreshHashLookup(hash)} />;
}

/** The popup's content; mounted only while it is open, so the lookup starts when it opens. */
function HashPopup({ hash }: { hash: string }) {
  const q = useQuery(hashLookupQuery(hash));
  const lookup = q.data;
  const shown = lookup?.hash ?? hash.toLowerCase();
  return (
    <div className="grid gap-2.5">
      <PopupHeader shown={shown} copy={shown} copied="Copied the hash" href={`https://www.virustotal.com/gui/file/${encodeURIComponent(shown)}`}>
        {lookup?.report?.name && <span className="text-xs break-all text-muted-foreground">{lookup.report.name}</span>}
      </PopupHeader>
      <div className="border-t pt-2.5">
        <HashLookupBody lookup={lookup} loading={q.isPending} error={q.error} />
      </div>
      {lookup?.state !== "no_key" && (
        <div className="border-t pt-2">
          <HashLookupFooter hash={hash} lookup={lookup} loading={q.isPending} />
        </div>
      )}
    </div>
  );
}

/**
 * Wraps a hash as it is shown anywhere (a link to its page, a badge, plain text) so that resting the
 * pointer on it, or focusing it, opens what VirusTotal says about the file. `children` must be one
 * element that can hold a ref, and focusable to open from the keyboard. `enabled` false leaves it as
 * it is, for lists of values only some of which are hashes. Guests see the hash alone.
 */
export function HashHoverCard({ hash, enabled = true, children }: { hash: string; enabled?: boolean; children: ReactElement }) {
  const me = useQuery(meQuery).data;
  const popup = useHoverCardOpen();
  if (!enabled || !me?.organization) return children;
  return (
    <HoverCard openDelay={400} closeDelay={150} {...popup}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent className="max-h-(--radix-hover-card-content-available-height) w-80 overflow-y-auto" side="bottom" align="start" collisionPadding={16}>
        <HashPopup hash={hash} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** A hash Observable's own page's "VirusTotal": what the popup shows, without needing a hover. */
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
