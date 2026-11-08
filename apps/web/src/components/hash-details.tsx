import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CopyIcon, ExternalLinkIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { toast } from "sonner";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Skeleton } from "@/components/ui/skeleton";
import { meQuery } from "@/lib/api";
import { formatBytes } from "@/lib/evidence";
import { enginesThatAnalysed, type FileReport, type HashLookup, hashLookupQuery, useRefreshHashLookup } from "@/lib/hash-lookups";
import { cn } from "@/lib/utils";

/**
 * What VirusTotal says about a file, by its hash (ADR 0011), as the hash context popup and a hash
 * Observable's page show it; laid out in `docs/wireframes/hash-context-popup.md`. The conventions
 * are the IP context popup's (`ip-details.tsx`).
 */

/** How many detections are listed before "and N more". */
const LISTED_DETECTIONS = 3;

/** The tone of a detection count: several engines is a finding, one or two may be a false positive. */
const tone = (s: FileReport["stats"]) => (s.malicious >= 3 ? "malicious" : s.malicious > 0 || s.suspicious > 0 ? "suspicious" : "clean");

const toneClass = {
  malicious: "border-destructive/40 bg-destructive/10 text-destructive",
  suspicious: "border-notice-border bg-notice text-notice-foreground",
  clean: "",
} as const;

/** "61 of 69 engines flag it malicious", with a bar of the share. */
function Verdict({ report: r }: { report: FileReport }) {
  const analysed = enginesThatAnalysed(r.stats);
  const t = tone(r.stats);
  const share = analysed ? r.stats.malicious / analysed : 0;
  return (
    <div className={cn("grid gap-1.5 rounded-md border px-2 py-1.5", toneClass[t])}>
      <p>
        <span className="font-mono font-medium tabular-nums">
          {r.stats.malicious}/{analysed}
        </span>{" "}
        {analysed === 0 ? "engines have analysed it" : "engines flag it malicious"}
        {r.stats.suspicious > 0 && <span className="text-muted-foreground"> · {r.stats.suspicious} suspicious</span>}
      </p>
      {analysed > 0 && (
        <div className="h-1 overflow-hidden rounded-full bg-muted" role="presentation">
          <div className={cn("h-full rounded-full", t === "malicious" ? "bg-destructive" : t === "suspicious" ? "bg-notice-foreground" : "bg-transparent")} style={{ width: `${Math.max(share * 100, r.stats.malicious ? 3 : 0)}%` }} />
        </div>
      )}
    </div>
  );
}

const joined = (parts: (string | null | undefined)[], sep = ", ") => parts.filter(Boolean).join(sep) || null;

/** The verdict, then the report as label-value rows. `showName` puts the file's name among them, for the card. */
function Report({ report: r, showName }: { report: FileReport; showName: boolean }) {
  const more = r.stats.malicious - Math.min(r.detections.length, LISTED_DETECTIONS);
  const rows: { label: string; value: ReactNode }[] = [
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
    {
      label: "Detections",
      value: r.detections.length > 0 && (
        <>
          {r.detections.slice(0, LISTED_DETECTIONS).map((d) => (
            <span key={d.engine} className="block">
              <span className="text-muted-foreground">{d.engine}</span> <span className="font-mono text-xs wrap-anywhere">{d.result}</span>
            </span>
          ))}
          {more > 0 && <span className="block text-muted-foreground">and {more} more</span>}
        </>
      ),
    },
    { label: "Type", value: joined([r.typeDescription, r.size !== null ? formatBytes(r.size) : null], " · ") },
    { label: "Also named", value: r.names.length > 0 && <span className="break-all">{joined(r.names.slice(0, 3))}{r.names.length > 3 && ` +${r.names.length - 3}`}</span> },
    { label: "Signed by", value: r.signature?.signers && <span title={r.signature.verified ?? undefined}>{r.signature.signers}</span> },
    { label: "First seen", value: r.firstSubmittedAt && <Time iso={r.firstSubmittedAt} /> },
    { label: "Analysed", value: r.lastAnalysisAt && <Time iso={r.lastAnalysisAt} /> },
    {
      label: "Community",
      value:
        (r.votes.malicious > 0 || r.votes.harmless > 0 || (r.reputation !== null && r.reputation !== 0)) &&
        joined([r.votes.malicious ? `${r.votes.malicious} malicious` : null, r.votes.harmless ? `${r.votes.harmless} harmless` : null, r.reputation ? `reputation ${r.reputation}` : null], " · "),
    },
  ];
  return (
    <div className="grid gap-2">
      <Verdict report={r} />
      {r.tags.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label="Tags">
          {r.tags.slice(0, 6).map((tag) => (
            <Badge key={tag} variant="outline" className="font-mono">
              {tag}
            </Badge>
          ))}
        </div>
      )}
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1">
        {rows
          .filter((row) => row.value)
          .map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 break-words">{row.value}</dd>
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

function ReportSkeleton() {
  return (
    <div className="grid gap-1.5" aria-label="Looking up">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

/** The way to the Member's own key, in Your settings. */
function KeyLink({ children }: { children: ReactNode }) {
  return (
    <Link to="/account" className="underline underline-offset-2 hover:text-foreground">
      {children}
    </Link>
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
      return (
        <div className="grid gap-2">
          <p className="text-muted-foreground">No VirusTotal report yet. Each Member looks hashes up with their own VirusTotal API key.</p>
          <Button asChild size="sm" variant="outline" className="justify-self-start">
            <Link to="/account">Add your key in Your settings</Link>
          </Button>
        </div>
      );
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
  const refresh = useRefreshHashLookup(hash);
  if (lookup?.state === "no_key") return null;
  const busy = loading || refresh.isPending;
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        VirusTotal ·{" "}
        {!lookup ? "looking up…" : refresh.isPending ? "refreshing…" : lookup.fetchedAt ? <Time iso={lookup.fetchedAt} prefix="as of" /> : "never looked up"}
      </span>
      {lookup && !lookup.hasKey && <KeyLink>Add your key to refresh</KeyLink>}
      {lookup?.hasKey && (
        <Button
          variant="ghost"
          size="xs"
          disabled={busy}
          onClick={() => refresh.mutate(undefined, { onError: (e) => toast.error(e.message) })}
          aria-label={`${lookup.state === "failed" ? "Retry looking up" : "Refresh"} ${hash}`}
        >
          <RefreshCwIcon className={cn(refresh.isPending && "animate-spin")} aria-hidden />
          {lookup.state === "failed" ? "Retry" : "Refresh"}
        </Button>
      )}
    </div>
  );
}

/** The popup's content; mounted only while it is open, so the lookup starts when it opens. */
function HashPopup({ hash }: { hash: string }) {
  const q = useQuery(hashLookupQuery(hash));
  const lookup = q.data;
  const shown = lookup?.hash ?? hash.toLowerCase();
  const copy = () =>
    void navigator.clipboard.writeText(shown).then(
      () => toast("Copied the hash"),
      () => toast.error("Couldn't copy to the clipboard"),
    );
  return (
    <div className="grid gap-2.5">
      <div className="grid gap-0.5">
        <div className="flex items-start gap-1">
          <span className="min-w-0 flex-1 font-mono text-xs font-medium break-all">{shown}</span>
          <Button variant="ghost" size="icon-xs" onClick={copy} aria-label="Copy" title="Copy">
            <CopyIcon aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-xs" asChild>
            <a href={`https://www.virustotal.com/gui/file/${encodeURIComponent(shown)}`} target="_blank" rel="noreferrer noopener" aria-label="Open on VirusTotal" title="Open on VirusTotal">
              <ExternalLinkIcon aria-hidden />
            </a>
          </Button>
        </div>
        {lookup?.report?.name && <span className="text-xs break-all text-muted-foreground">{lookup.report.name}</span>}
      </div>
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
  if (!enabled || !me?.organization) return children;
  return (
    <HoverCard openDelay={400} closeDelay={150}>
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

/** Plain hash text, focusable, with the hash context popup. `children` is how it is shown, the hash itself by default. */
export function HashText({ hash, className, children }: { hash: string; className?: string; children?: ReactNode }) {
  return (
    <HashHoverCard hash={hash}>
      <span tabIndex={0} className={cn("font-mono text-xs underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className)}>
        {children ?? hash}
      </span>
    </HashHoverCard>
  );
}
