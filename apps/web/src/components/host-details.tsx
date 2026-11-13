import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { type FocusEvent, type ReactElement, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { CardPager } from "@/components/card-pager";
import { ValueHeader } from "@/components/enrichment-parts";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Skeleton } from "@/components/ui/skeleton";
import { meQuery } from "@/lib/api";
import { useHoverCardOpen } from "@/lib/hover-card";
import { type ItemPage, itemPageQuery, itemPagesKey, refreshEnrichment } from "@/lib/observables";
import { cn } from "@/lib/utils";

/**
 * What Falcon says about a host Asset (ADR 0009), as the hover card shows it on resting the pointer
 * on the host: each device's containment, platform, last-seen time, last user and addresses. Laid
 * out in `docs/wireframes/host-context-popup.md`, the host counterpart of the account card
 * (`AccountHoverCard`). The host's page shows the rest (the "Falcon devices" card). An ambiguous
 * host's devices, or the host under several Integrations, show one at a time, stepped through with
 * `CardPager`.
 */

type Group = ItemPage["falconDevices"][number];
type Device = Group["devices"][number];
type Facts = NonNullable<Device["enrichment"]["host"]>;

const NOTICE = "border-notice-border bg-notice text-notice-foreground";

const containmentLabel: Record<NonNullable<Facts["containment"]>, string> = {
  normal: "Not contained",
  containment_pending: "Containing",
  contained: "Contained",
  lift_containment_pending: "Lifting containment",
};

function Problem({ children }: { children: ReactNode }) {
  return (
    <p className={cn("flex gap-1.5 rounded-md border px-2 py-1.5", NOTICE)}>
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function DetailsSkeleton() {
  return (
    <div className="grid gap-1.5" aria-label="Looking up">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;
const mono = (text: string) => <span className="font-mono text-xs break-all">{text}</span>;

/** One device's containment, platform, last-seen time, last user and addresses; or why there are none. */
function DeviceFacts({ group, device }: { group: Group; device: Device }) {
  const { host: f, notFound, error, refreshing } = device.enrichment;
  const head = (
    <div className="grid gap-0.5">
      <a href={device.consoleUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-xs break-all text-muted-foreground hover:underline">
        {device.deviceId}
        <ExternalLinkIcon className="size-3 shrink-0" aria-label="Opens in the Falcon console" />
      </a>
      {group.ambiguous && (
        <p>
          <Badge variant="outline" title="Several Falcon devices go by this hostname for this Integration">
            Ambiguous
          </Badge>
        </p>
      )}
    </div>
  );
  let body: ReactNode;
  if (notFound) body = <p>Not found in Falcon.</p>;
  else if (!f) body = refreshing ? <DetailsSkeleton /> : error ? <Problem>{error}</Problem> : <p className="text-muted-foreground">Not fetched from Falcon yet.</p>;
  else {
    const rows: { label: string; value: ReactNode }[] = [
      {
        label: "Containment",
        value: !f.containment ? muted("Unknown") : f.containment === "normal" ? containmentLabel.normal : <Badge variant="destructive">{containmentLabel[f.containment]}</Badge>,
      },
      { label: "Platform", value: f.osVersion ?? f.platform ?? muted("Unknown") },
      { label: "Last seen", value: f.lastSeen ? <Time iso={f.lastSeen} /> : muted("Never") },
      { label: "User", value: f.lastLoggedOnUser ? mono(f.lastLoggedOnUser) : muted("None recorded") },
      { label: "Local IP", value: f.localIp ? mono(f.localIp) : muted("None") },
      { label: "External IP", value: f.externalIp ? mono(f.externalIp) : muted("None") },
    ];
    body = (
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0 break-words">{r.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <div className="grid gap-2">
      {head}
      {body}
      {f && error && <p className="text-xs text-destructive">Last fetch failed: {error}</p>}
    </div>
  );
}

/** How looking the host up by hostname went, through an Integration with no device recorded on it. */
function LookupState({ lookup }: { lookup: NonNullable<Group["lookup"]> }) {
  if (lookup.notFound) return <p>Not found in Falcon.</p>;
  if (lookup.error) return <Problem>{lookup.error}</Problem>;
  return lookup.refreshing ? <DetailsSkeleton /> : <p className="text-muted-foreground">Not looked up in Falcon yet.</p>;
}

/** The newest fetch among the devices shown, for the footer. */
const latestFetch = (groups: Group[]) =>
  groups
    .flatMap((g) => [...g.devices.map((d) => d.enrichment.fetchedAt), g.lookup?.checkedAt ?? null])
    .filter((t): t is string => !!t)
    .toSorted()
    .at(-1) ?? null;

/** One page of the card: a device, or, for an Integration with none recorded, how looking the host up went. */
type Page = { group: Group; device: Device | null };

const cardPages = (groups: Group[]): Page[] =>
  groups.flatMap((group) => (group.devices.length ? group.devices.map((device): Page => ({ group, device })) : [{ group, device: null }]));

/** The hover card's content; mounted only while it is open, so the host is fetched when it opens. */
function HostCard({ assetId, host }: { assetId: string; host: string }) {
  const queryClient = useQueryClient();
  const q = useQuery(itemPageQuery("asset", assetId));
  const refresh = useMutation({
    mutationFn: () => refreshEnrichment(assetId),
    onError: (e) => toast.error(e.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: itemPagesKey }),
  });
  const [index, setIndex] = useState(0);
  const item = q.data;
  const groups = item?.falconDevices ?? [];
  const shown = item?.value ?? host;
  const refreshing = refresh.isPending || groups.some((g) => g.lookup?.refreshing || g.devices.some((d) => d.enrichment.refreshing));
  const asOf = latestFetch(groups);
  const pages = cardPages(groups);
  const at = Math.min(index, Math.max(pages.length - 1, 0));
  const page = pages[at];
  let body: ReactNode;
  if (q.isPending) body = <DetailsSkeleton />;
  else if (!item) body = <Problem>{q.error?.message ?? "Could not load the host"}</Problem>;
  else if (!page) body = <p className="text-muted-foreground">No CrowdStrike Integration to look this host up in. An Admin can add one in Settings · Integrations.</p>;
  else
    body = (
      <section aria-label={page.group.integration.name} className="grid gap-2">
        {page.group.integration.enrichmentUnavailable && <Problem>{page.group.integration.enrichmentUnavailable}.</Problem>}
        {page.device ? <DeviceFacts group={page.group} device={page.device} /> : page.group.lookup && <LookupState lookup={page.group.lookup} />}
      </section>
    );
  return (
    <div className="grid gap-2.5" data-testid="host-hover-card">
      <ValueHeader shown={shown} copy={shown} copied={`Copied ${shown}`} links={page?.device ? [{ source: "Falcon", href: page.device.consoleUrl }] : []} />
      {pages.length > 1 && <CardPager at={at} count={pages.length} onStep={setIndex} noun="device" label={groups.length > 1 ? page?.group.integration.name : undefined} />}
      <div className="max-h-96 overflow-y-auto border-t pt-2.5">{body}</div>
      {groups.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
          <span>Falcon · {refreshing ? "refreshing…" : asOf ? <Time iso={asOf} prefix="as of" /> : "never looked up"}</span>
          <Button variant="ghost" size="xs" disabled={refreshing} onClick={() => refresh.mutate()} aria-label={`Refresh ${shown}`}>
            <RefreshCwIcon className={cn(refreshing && "animate-spin")} aria-hidden />
            Refresh
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Wraps a host Asset as it is shown anywhere (a link to its page, a badge) so that resting the
 * pointer on it opens what Falcon says about it, as `AccountHoverCard` does for accounts. Focus
 * doesn't open it. `children` must be one element that can hold a ref. `enabled` false leaves it as
 * it is. Guests see the host alone: they never see Enrichment.
 */
export function HostHoverCard({ assetId, host, enabled = true, children }: { assetId: string; host: string; enabled?: boolean; children: ReactElement }) {
  const role = useQuery(meQuery).data?.organization?.role;
  const card = useHoverCardOpen();
  if (!enabled || !role) return children;
  return (
    <HoverCard openDelay={400} closeDelay={150} open={card.open} onOpenChange={card.onOpenChange}>
      <HoverCardTrigger asChild data-hovercard="" onFocus={(e: FocusEvent) => e.preventDefault()}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent className="w-80" side="bottom" align="start" collisionPadding={16}>
        <HostCard assetId={assetId} host={host} />
      </HoverCardContent>
    </HoverCard>
  );
}
