import { CircleAlertIcon, ExternalLinkIcon } from "lucide-react";
import { type MouseEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { ItemLink } from "@/components/item-link";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { assetsQuery } from "@/lib/observables";
import { when } from "@/lib/when";
import { cn } from "@/lib/utils";

export type CaseAsset = NonNullable<Awaited<ReturnType<ReturnType<typeof assetsQuery>["queryFn"] & {}>>>[number];
type FalconView = CaseAsset["falcon"][number];
type Device = FalconView["devices"][number];

const containmentLabel: Record<NonNullable<Device["containment"]>, string> = {
  normal: "Not contained",
  containment_pending: "Containment pending",
  contained: "Contained",
  lift_containment_pending: "Lifting containment",
};

const contained = (d: Device) => !!d.containment && d.containment !== "normal";

/** How looking a host up by hostname went, while no device is recorded for it. */
const lookupText = (lookup: FalconView["lookup"]) =>
  !lookup || lookup.refreshing ? "Looking up in Falcon…" : lookup.error ? "Couldn't look it up in Falcon" : "Not found in Falcon";

/** A device's key facts in a few words: its OS and when Falcon last saw it, or why there are none. */
function deviceSummary(d: Device) {
  if (d.notFound) return "Not found in Falcon";
  if (!d.fetchedAt) return d.refreshing ? "Fetching from Falcon…" : "Not fetched yet";
  return [d.osVersion ?? d.platform, d.lastSeen && `seen ${when(d.lastSeen)}`].filter(Boolean).join(" · ") || "No details";
}

/**
 * A host's key Enrichment facts on the Case (ADR 0009), kept to one line in the Assets table: the
 * OS and last seen of its device (a contained one first), its containment when it isn't normal, a
 * mark when a fetch failed, and how many more devices there are. Pointing at it or pressing it
 * opens every device's facts, as of when they were fetched, with the console link and a way to the
 * host's page, which has the rest. Opening the Case asks again for anything older than 15 minutes,
 * and a signal brings the result. Guests get no console link, Integration name or error.
 */
export function HostFalcon({ falcon, assetId, caseNumber }: { falcon: FalconView[]; assetId: string; caseNumber: number }) {
  const hover = useHoverOpen();
  if (!falcon.length) return <span className="text-muted-foreground">—</span>;
  const devices = falcon.flatMap((view) => view.devices.map((device) => ({ view, device })));
  const lead = devices.find((d) => contained(d.device)) ?? devices[0];
  const failed = falcon.some((v) => v.lookup?.error) || devices.some((d) => d.device.error);
  const more = devices.length - 1;
  const summary = lead ? deviceSummary(lead.device) : lookupText(falcon[0]!.lookup);
  const quiet = !lead || !lead.device.fetchedAt || lead.device.notFound;
  const label = [
    summary,
    lead && contained(lead.device) && containmentLabel[lead.device.containment!],
    failed && "a fetch failed",
    more > 0 && `${more} more ${more === 1 ? "device" : "devices"}`,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Popover open={hover.open} onOpenChange={hover.setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-falcon-summary
          aria-label={`Falcon: ${label}. Show details`}
          className="flex h-6 max-w-full min-w-0 cursor-default items-center gap-1.5 rounded-sm text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          {...hover.triggerProps}
        >
          <span
            className={cn(
              "min-w-0 truncate underline decoration-dotted decoration-foreground/30 underline-offset-4",
              quiet && "text-muted-foreground",
            )}
          >
            {summary}
          </span>
          {lead && contained(lead.device) && (
            <Badge variant="outline" className="shrink-0">
              {lead.device.containment === "contained" ? "Contained" : lead.device.containment === "containment_pending" ? "Containing" : "Lifting"}
            </Badge>
          )}
          {failed && <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />}
          {more > 0 && <span className="shrink-0 text-muted-foreground tabular-nums">+{more}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80"
        aria-label="Falcon details"
        {...hover.contentProps}
      >
        <div className="grid gap-3 text-xs">
          {falcon.map((view) => (
            <section key={view.integration?.id ?? "lookup"} className="grid gap-2">
              {(view.integration || view.ambiguous) && (
                <header className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium">{view.integration?.name ?? "Falcon"}</span>
                  {view.ambiguous && <span className="shrink-0 text-muted-foreground">{view.devices.length} devices with this hostname</span>}
                </header>
              )}
              {view.devices.length === 0 ? (
                <p className={view.lookup?.error ? "text-destructive" : "text-muted-foreground"}>
                  {lookupText(view.lookup)}
                  {view.lookup?.error && `: ${view.lookup.error}`}
                </p>
              ) : (
                view.devices.map((d) => <DeviceFacts key={d.deviceId} device={d} />)
              )}
            </section>
          ))}
          <ItemLink
            kind="asset"
            id={assetId}
            fromCase={caseNumber}
            className="border-t pt-2 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Everything Falcon reports on the host's page
          </ItemLink>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DeviceFacts({ device: d }: { device: Device }) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-muted-foreground" title={d.deviceId}>
          aid {d.deviceId.slice(0, 12)}…
        </span>
        {d.consoleUrl && (
          <a
            href={d.consoleUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            aria-label={`Open device ${d.deviceId} in the Falcon console`}
          >
            Falcon console
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        )}
      </div>
      {d.notFound || !d.fetchedAt ? (
        <p className="text-muted-foreground">{deviceSummary(d)}</p>
      ) : (
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">OS</dt>
          <dd>{d.osVersion ?? d.platform ?? "—"}</dd>
          <dt className="text-muted-foreground">Last seen</dt>
          <dd>{d.lastSeen ? <Time iso={d.lastSeen} /> : "—"}</dd>
          <dt className="text-muted-foreground">Containment</dt>
          <dd>{d.containment ? containmentLabel[d.containment] : "—"}</dd>
          <dt className="text-muted-foreground">Fetched</dt>
          <dd className="text-muted-foreground">
            <Time iso={d.fetchedAt} />
            {d.refreshing && ", refreshing…"}
          </dd>
        </dl>
      )}
      {d.error && (
        <p className="flex gap-1.5 text-destructive">
          <CircleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>Last fetch failed: {d.error}</span>
        </p>
      )}
    </div>
  );
}

/**
 * A popover that also opens while its trigger is pointed at, after a short wait, and stays open
 * while the pointer moves onto it. Opened that way it leaves focus where it is and closes as the
 * pointer leaves; pressed, it takes focus and stays open as a popover does.
 */
function useHoverOpen() {
  const [open, setOpenState] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const byHover = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const later = (fn: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  const enter = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    later(() => {
      byHover.current = true;
      setOpenState(true);
    }, 350);
  };
  const leave = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    later(() => byHover.current && setOpenState(false), 200);
  };
  return {
    open,
    setOpen: (next: boolean) => {
      clearTimeout(timer.current);
      byHover.current = false;
      setOpenState(next);
    },
    triggerProps: {
      onPointerEnter: enter,
      onPointerLeave: leave,
      // Pressing it while pointing has it open keeps it open, as if pressed to open.
      onClick: (e: MouseEvent) => {
        if (open && byHover.current) {
          e.preventDefault();
          byHover.current = false;
        }
      },
    },
    contentProps: {
      onPointerEnter: () => clearTimeout(timer.current),
      onPointerLeave: leave,
      onOpenAutoFocus: (e: Event) => byHover.current && e.preventDefault(),
    },
  };
}
