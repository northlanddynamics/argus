import type { UseMutationResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type AnalysisStats, type Detection, enginesThatAnalysed } from "api/virustotal/virustotal";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * What VirusTotal's Enrichment panel content and cards share, for files (`hash-details.tsx`, ADR 0011) and
 * for domains, email addresses and URLs (`domain-details.tsx`, `url-details.tsx`, ADR 0012): the
 * verdict, label-value rows, the footer with Refresh, and the states with no report.
 */

/** How many detections are listed before "and N more" on an Observable's page, and in the Enrichment panel, which has the room for more. */
const LISTED_DETECTIONS = 3;
export const PANEL_DETECTIONS = 8;

/** The tone of a detection count: several engines is a finding, one or two may be a false positive. */
const tone = (s: AnalysisStats) => (s.malicious >= 3 ? "malicious" : s.malicious > 0 || s.suspicious > 0 ? "suspicious" : "clean");

const toneClass = {
  malicious: "border-destructive/40 bg-destructive/10 text-destructive",
  suspicious: "border-notice-border bg-notice text-notice-foreground",
  clean: "",
} as const;

/** "61/69 engines flag it malicious", with a bar of the share. */
export function Verdict({ stats }: { stats: AnalysisStats }) {
  const analysed = enginesThatAnalysed(stats);
  const t = tone(stats);
  const share = analysed ? stats.malicious / analysed : 0;
  return (
    <div className={cn("grid gap-1.5 rounded-md border px-2 py-1.5", toneClass[t])}>
      <p>
        <span className="font-mono font-medium tabular-nums">
          {stats.malicious}/{analysed}
        </span>{" "}
        {analysed === 0 ? "engines have analysed it" : "engines flag it malicious"}
        {stats.suspicious > 0 && <span className="text-muted-foreground"> · {stats.suspicious} suspicious</span>}
      </p>
      {analysed > 0 && (
        <div className="h-1 overflow-hidden rounded-full bg-muted" role="presentation">
          <div
            className={cn("h-full rounded-full", t === "malicious" ? "bg-destructive" : t === "suspicious" ? "bg-notice-foreground" : "bg-transparent")}
            style={{ width: `${Math.max(share * 100, stats.malicious ? 3 : 0)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export const joined = (parts: (string | null | undefined)[], sep = ", ") => parts.filter(Boolean).join(sep) || null;

/** VirusTotal's tags, at most six. */
export function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" aria-label="Tags">
      {tags.slice(0, 6).map((tag) => (
        <Badge key={tag} variant="outline" className="font-mono">
          {tag}
        </Badge>
      ))}
    </div>
  );
}

export type Row = { label: string; value: ReactNode };

/** Label-value rows, leaving out those with nothing to say. */
export function Rows({ rows }: { rows: Row[] }) {
  return (
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
  );
}

/** The "Detections" row: the first `listed` engines by name, and how many more call it malicious. */
export function detectionsRow(detections: Detection[], malicious: number, listed = LISTED_DETECTIONS): Row {
  const more = malicious - Math.min(detections.length, listed);
  return {
    label: "Detections",
    value: detections.length > 0 && (
      <>
        {detections.slice(0, listed).map((d) => (
          <span key={d.engine} className="block">
            <span className="text-muted-foreground">{d.engine}</span> <span className="font-mono text-xs wrap-anywhere">{d.result}</span>
          </span>
        ))}
        {more > 0 && <span className="block text-muted-foreground">and {more} more</span>}
      </>
    ),
  };
}

/** The "Community" row: votes and reputation, when there are any. */
export function communityRow(votes: { harmless: number; malicious: number }, reputation: number | null): Row {
  return {
    label: "Community",
    value:
      (votes.malicious > 0 || votes.harmless > 0 || (reputation !== null && reputation !== 0)) &&
      joined([votes.malicious ? `${votes.malicious} malicious` : null, votes.harmless ? `${votes.harmless} harmless` : null, reputation ? `reputation ${reputation}` : null], " · "),
  };
}

export function Problem({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-1.5 rounded-md border border-notice-border bg-notice px-2 py-1.5 text-notice-foreground">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

export function ReportSkeleton() {
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
export function KeyLink({ children }: { children: ReactNode }) {
  return (
    <Link to="/account" className="underline underline-offset-2 hover:text-foreground">
      {children}
    </Link>
  );
}

/** Nothing cached, and no key to look it up with. `what` is what is looked up: "hashes", "domains". */
export function NoKey({ what }: { what: string }) {
  return (
    <div className="grid gap-2">
      <p className="text-muted-foreground">No VirusTotal report yet. Each Member looks {what} up with their own VirusTotal API key.</p>
      <Button asChild size="sm" variant="outline" className="justify-self-start">
        <Link to="/account">Add your key in Your settings</Link>
      </Button>
    </div>
  );
}

/** What any VirusTotal lookup says about itself, whatever it looked up. */
export type LookupStatus = { state: string; fetchedAt: string | null; hasKey: boolean };

/**
 * "VirusTotal · as of 3 hours ago", with Refresh (or Retry after a failure), or the way to a key.
 * `what` names the value for Refresh's accessible name.
 */
export function VirustotalFooter({
  what,
  lookup,
  loading,
  refresh,
  named = true,
}: {
  what: string;
  lookup: LookupStatus | undefined;
  loading: boolean;
  refresh: UseMutationResult<unknown, Error, void>;
  /** False drops "VirusTotal ·" where a heading already says it. */
  named?: boolean;
}) {
  if (lookup?.state === "no_key" || lookup?.state === "withheld") return null;
  const busy = loading || refresh.isPending;
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>
        {named && "VirusTotal · "}
        {!lookup ? "looking up…" : refresh.isPending ? "refreshing…" : lookup.fetchedAt ? <Time iso={lookup.fetchedAt} prefix="as of" /> : "never looked up"}
      </span>
      {lookup && !lookup.hasKey && <KeyLink>Add your key to refresh</KeyLink>}
      {lookup?.hasKey && (
        <Button
          variant="ghost"
          size="xs"
          disabled={busy}
          onClick={() => refresh.mutate(undefined, { onError: (e) => toast.error(e.message) })}
          aria-label={`${lookup.state === "failed" ? "Retry looking up" : "Refresh"} ${what}`}
        >
          <RefreshCwIcon className={cn(refresh.isPending && "animate-spin")} aria-hidden />
          {lookup.state === "failed" ? "Retry" : "Refresh"}
        </Button>
      )}
    </div>
  );
}
