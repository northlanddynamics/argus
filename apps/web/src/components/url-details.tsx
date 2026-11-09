import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { Time } from "@/components/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { communityRow, detectionsRow, joined, KeyLink, NoKey, PopupHeader, Problem, ReportSkeleton, Rows, Tags, Verdict, VirustotalFooter } from "@/components/virustotal-parts";
import { meQuery } from "@/lib/api";
import { type UrlLookup, type UrlReport, urlLookupQuery, useRefreshUrlLookup } from "@/lib/domain-url-lookups";
import { useHoverCardOpen } from "@/lib/hover-card";
import { defang } from "@/lib/observables";

/**
 * What VirusTotal says about a URL (ADR 0012), as the URL context popup and a URL Observable's page
 * show it; laid out in `docs/wireframes/domain-url-context-popup.md`. Argus only looks URLs up:
 * it never submits one for scanning, so VirusTotal never visits it on a Member's behalf.
 */

/** The verdict, then the report as label-value rows. */
function Report({ report: r }: { report: UrlReport }) {
  return (
    <div className="grid gap-2">
      <Verdict stats={r.stats} />
      <Tags tags={r.tags} />
      <Rows
        rows={[
          { label: "Title", value: r.title && <span className="break-all">{r.title}</span> },
          { label: "Ends at", value: r.finalUrl && <span className="font-mono text-xs break-all">{defang("url", r.finalUrl)}</span> },
          { label: "Redirects", value: r.redirects.length > 1 && `${r.redirects.length - 1} before it ends` },
          { label: "Response", value: r.httpStatus !== null && `HTTP ${r.httpStatus}` },
          { label: "Categories", value: r.categories.length > 0 && r.categories.slice(0, 3).join(", ") },
          detectionsRow(r.detections, r.stats.malicious),
          { label: "Threats", value: r.threatNames.length > 0 && <span className="font-mono text-xs break-all">{joined(r.threatNames.slice(0, 3))}</span> },
          { label: "First seen", value: r.firstSubmittedAt && <Time iso={r.firstSubmittedAt} /> },
          { label: "Analysed", value: r.lastAnalysisAt && <Time iso={r.lastAnalysisAt} /> },
          communityRow(r.votes, r.reputation),
        ]}
      />
    </div>
  );
}

/** The body of the popup or card for a URL's lookup: the report, or why there is none. */
export function UrlLookupBody({ lookup, loading, error }: { lookup: UrlLookup | undefined; loading: boolean; error: Error | null }) {
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
          {lookup.report && <Report report={lookup.report} />}
        </div>
      );
    case "found":
      return lookup.report && <Report report={lookup.report} />;
  }
}

function UrlFooter({ url, lookup, loading }: { url: string; lookup: UrlLookup | undefined; loading: boolean }) {
  return <VirustotalFooter what={defang("url", url)} lookup={lookup} loading={loading} refresh={useRefreshUrlLookup(url)} />;
}

/** The popup's content; mounted only while it is open, so the lookup starts when it opens. */
function UrlPopup({ url }: { url: string }) {
  const q = useQuery(urlLookupQuery(url));
  const lookup = q.data;
  const shown = defang("url", lookup?.url ?? url);
  // VirusTotal's page for a URL is under its own identifier, known only once it has reported on it.
  const href = lookup?.report?.id ? `https://www.virustotal.com/gui/url/${encodeURIComponent(lookup.report.id)}` : null;
  return (
    <div className="grid gap-2.5">
      <PopupHeader shown={shown} copy={shown} copied="Copied (defanged)" href={href} />
      <div className="border-t pt-2.5">
        <UrlLookupBody lookup={lookup} loading={q.isPending} error={q.error} />
      </div>
      {lookup?.state !== "no_key" && lookup?.state !== "withheld" && (
        <div className="border-t pt-2">
          <UrlFooter url={url} lookup={lookup} loading={q.isPending} />
        </div>
      )}
    </div>
  );
}

/**
 * Wraps a URL as it is shown anywhere so that resting the pointer on it, or focusing it, opens what
 * VirusTotal says about it. `children` must be one element that can hold a ref, and focusable to
 * open from the keyboard. Guests see the URL alone.
 */
export function UrlHoverCard({ url, children }: { url: string; children: ReactElement }) {
  const me = useQuery(meQuery).data;
  const popup = useHoverCardOpen();
  if (!me?.organization) return children;
  return (
    <HoverCard openDelay={400} closeDelay={150} {...popup}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent className="max-h-(--radix-hover-card-content-available-height) w-80 overflow-y-auto" side="bottom" align="start" collisionPadding={16}>
        <UrlPopup url={url} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** A URL Observable's own page's "VirusTotal": what the popup shows, without needing a hover. */
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
