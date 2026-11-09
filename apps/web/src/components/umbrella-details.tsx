import { useQuery } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { SourceSection } from "@/components/enrichment-parts";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Problem, ReportSkeleton } from "@/components/virustotal-parts";
import { defang } from "@/lib/observables";
import { type UmbrellaIntegrationCheck, umbrellaCheckQuery, useRefreshUmbrellaCheck } from "@/lib/umbrella-checks";
import { cn } from "@/lib/utils";

/**
 * Which Cisco Umbrella destination lists hold a domain (ADR 0014), as the Enrichment panel and a
 * domain or email Observable's page show it: per Umbrella Integration, each list holding the domain
 * itself, or a domain above it that covers it. Shown only when the Organization has Umbrella.
 */

/** The lists holding it, or that none do. */
function Matches({ check }: { check: UmbrellaIntegrationCheck }) {
  if (check.matches.length === 0) {
    return <p className="text-muted-foreground">{check.checkedAt ? `In none of its ${check.listCount} destination lists.` : "Its destination lists haven't been read yet."}</p>;
  }
  return (
    <ul className="grid gap-2">
      {check.matches.map((m) => (
        <li key={`${m.list.id}:${m.destination}`} className="grid gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{m.list.name}</span>
            <Badge variant="outline" className={cn(m.list.access === "block" ? "border-destructive text-destructive" : undefined)}>
              {m.list.access === "block" ? "Block" : "Allow"}
            </Badge>
            {m.list.isGlobal && <Badge variant="outline">Global</Badge>}
          </span>
          <span className="text-xs text-muted-foreground">
            {m.matchedBy === "exact" ? "Holds this domain" : <>Covers it through <span className="font-mono">{defang("domain", m.destination)}</span></>}
            {m.addedAt && (
              <>
                {" "}
                · added <Time iso={m.addedAt} />
              </>
            )}
          </span>
          {m.comment && <span className="text-xs break-words text-muted-foreground">{m.comment}</span>}
        </li>
      ))}
    </ul>
  );
}

function Body({ check }: { check: UmbrellaIntegrationCheck }) {
  return (
    <div className="grid gap-2">
      {check.state === "failed" && <Problem>{check.error}</Problem>}
      {check.state === "paused" && <p className="text-muted-foreground">The Integration is paused: this is what was last read.</p>}
      <Matches check={check} />
    </div>
  );
}

function Footer({ value, check }: { value: string; check: UmbrellaIntegrationCheck }) {
  const refresh = useRefreshUmbrellaCheck(value);
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{refresh.isPending ? "reading the lists…" : check.checkedAt ? <Time iso={check.checkedAt} prefix="lists read" /> : "never read"}</span>
      {check.state !== "paused" && (
        <Button
          variant="ghost"
          size="xs"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate(undefined, { onError: (e) => toast.error(e.message) })}
          aria-label={`Read ${check.integration.name}'s destination lists again`}
        >
          <RefreshCwIcon className={cn(refresh.isPending && "animate-spin")} aria-hidden />
          {check.state === "failed" ? "Retry" : "Refresh"}
        </Button>
      )}
    </div>
  );
}

const titleOf = (check: UmbrellaIntegrationCheck, several: boolean) => (several ? `Cisco Umbrella · ${check.integration.name}` : "Cisco Umbrella");

/** The Enrichment panel's Umbrella sections for a domain or email address: one per Umbrella Integration. */
export function UmbrellaSections({ value }: { value: string }) {
  const q = useQuery(umbrellaCheckQuery(value));
  if (q.isPending) return null;
  if (!q.data) return q.error ? <SourceSection title="Cisco Umbrella"><Problem>{q.error.message}</Problem></SourceSection> : null;
  const several = q.data.integrations.length > 1;
  return q.data.integrations.map((check) => (
    <SourceSection key={check.integration.id} title={titleOf(check, several)} footer={<Footer value={value} check={check} />}>
      <Body check={check} />
    </SourceSection>
  ));
}

/** A domain or email Observable's own page's "Cisco Umbrella": what the Enrichment panel shows. */
export function UmbrellaCard({ value }: { value: string }) {
  const q = useQuery(umbrellaCheckQuery(value));
  if (q.data && q.data.integrations.length === 0) return null;
  const several = (q.data?.integrations.length ?? 0) > 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cisco Umbrella</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {q.isPending && <ReportSkeleton />}
        {q.error && <Problem>{q.error.message}</Problem>}
        {q.data?.integrations.map((check) => (
          <div key={check.integration.id} className="grid gap-2">
            {several && <span className="font-medium">{check.integration.name}</span>}
            <Body check={check} />
            <Footer value={value} check={check} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
