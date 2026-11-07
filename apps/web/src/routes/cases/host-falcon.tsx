import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { assetsQuery } from "@/lib/observables";
import { exactTime, when } from "@/lib/when";

export type CaseAsset = NonNullable<Awaited<ReturnType<ReturnType<typeof assetsQuery>["queryFn"] & {}>>>[number];
type FalconView = CaseAsset["falcon"][number];
type Device = FalconView["devices"][number];

const containmentLabel: Record<NonNullable<Device["containment"]>, string> = {
  normal: "Not contained",
  containment_pending: "Containment pending",
  contained: "Contained",
  lift_containment_pending: "Lifting containment",
};

/**
 * A host's key Enrichment facts on the Case (ADR 0009): OS, last seen and containment for each
 * Falcon device recorded on it, as of when they were fetched. Opening the Case asks again for
 * anything older than 15 minutes, and a signal brings the result; the host's page has the rest.
 * Members also get each device's console link and why a fetch failed. Guests get neither, nor the
 * Integration's name.
 */
export function HostFalcon({ falcon }: { falcon: FalconView[] }) {
  if (!falcon.length) return <span className="text-muted-foreground">—</span>;
  const named = falcon.length > 1;
  return (
    <ul className="grid gap-1 text-xs" aria-label="Falcon">
      {falcon.flatMap((view) => {
        const prefix = named && view.integration ? `${view.integration.name}: ` : "";
        if (!view.devices.length) {
          const lookup = view.lookup;
          const text = !lookup || lookup.refreshing ? "Looking up in Falcon…" : lookup.error ? "Couldn't look it up in Falcon" : "Not found in Falcon";
          return [
            <li key={view.integration?.id ?? "lookup"} className="text-muted-foreground" title={lookup?.error ?? undefined}>
              {prefix}
              {text}
            </li>,
          ];
        }
        return view.devices.map((d) => (
          <li key={`${view.integration?.id ?? ""}-${d.deviceId}`} className="grid gap-0.5">
            <DeviceLine device={d} prefix={view.ambiguous ? `${prefix}${d.deviceId.slice(0, 8)}… ` : prefix} />
          </li>
        ));
      })}
    </ul>
  );
}

function DeviceLine({ device: d, prefix }: { device: Device; prefix: string }) {
  const asOf = d.fetchedAt ? (
    <span className="text-muted-foreground" title={exactTime(d.fetchedAt)}>
      as of {when(d.fetchedAt)}
      {d.refreshing && ", refreshing…"}
    </span>
  ) : null;
  const facts = d.notFound ? (
    <span>Not found in Falcon</span>
  ) : d.fetchedAt ? (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <span>{[d.osVersion ?? d.platform, d.lastSeen && `seen ${when(d.lastSeen)}`].filter(Boolean).join(" · ") || "—"}</span>
      {d.containment && d.containment !== "normal" ? (
        <Badge variant="outline" className="h-5 px-1.5 text-[11px]">
          {containmentLabel[d.containment]}
        </Badge>
      ) : (
        d.containment && <span className="text-muted-foreground">· {containmentLabel.normal}</span>
      )}
    </span>
  ) : (
    <span className="text-muted-foreground">{d.refreshing ? "Fetching from Falcon…" : "Not fetched from Falcon yet"}</span>
  );
  return (
    <>
      <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
        {prefix && <span className="font-mono text-muted-foreground">{prefix}</span>}
        {facts}
        {d.consoleUrl && (
          <a href={d.consoleUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" aria-label={`Open device ${d.deviceId} in the Falcon console`}>
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </a>
        )}
      </span>
      {asOf}
      {d.error && <span className="text-destructive">Last fetch failed: {d.error}</span>}
    </>
  );
}
