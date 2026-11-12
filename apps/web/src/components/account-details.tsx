import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import type { FocusEvent, ReactElement, ReactNode } from "react";
import { toast } from "sonner";
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
 * What Falcon Identity Protection says about an account Asset (ADR 0009), as the hover card shows
 * it on resting the pointer on the account: each identity's full name, account state, whether it is
 * privileged, and its last activity. Laid out in `docs/wireframes/account-context-popup.md`. The
 * account's page shows the rest (`FalconIdentitiesCard`).
 */

type Group = ItemPage["falconIdentities"][number];
type Identity = Group["identities"][number];
type Facts = NonNullable<Identity["enrichment"]["identity"]>;

const NOTICE = "border-notice-border bg-notice text-notice-foreground";

/** "Enabled", "Disabled", plus "Locked out" and "Stale" when they are so; null when Falcon said none of it. */
function accountState(f: Facts): { label: string; flagged: boolean }[] {
  const state: { label: string; flagged: boolean }[] = [];
  if (f.enabled !== null) state.push({ label: f.enabled ? "Enabled" : "Disabled", flagged: !f.enabled });
  if (f.lockedOut) state.push({ label: "Locked out", flagged: true });
  if (f.stale) state.push({ label: "Stale", flagged: true });
  return state;
}

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

/** One identity's name, account state, privilege and last activity; or why there are none. */
function IdentityFacts({ group, identity }: { group: Group; identity: Identity }) {
  const { identity: f, notFound, error, refreshing } = identity.enrichment;
  if (notFound) return <p>Not found in Falcon.</p>;
  if (!f) return refreshing ? <DetailsSkeleton /> : error ? <Problem>{error}</Problem> : <p className="text-muted-foreground">Not fetched from Falcon yet.</p>;
  const state = accountState(f);
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: "State",
      value: state.length ? (
        <span className="flex flex-wrap gap-1">
          {state.map((s) =>
            s.flagged ? (
              <Badge key={s.label} variant="outline" className={NOTICE}>
                {s.label}
              </Badge>
            ) : (
              <span key={s.label}>{s.label}</span>
            ),
          )}
        </span>
      ) : (
        muted("Unknown")
      ),
    },
    {
      label: "Privileged",
      value:
        f.privileged === null ? (
          muted("Unknown")
        ) : f.privileged ? (
          <>
            <Badge variant="outline" className={NOTICE}>
              Privileged
            </Badge>
            {f.privilegedGroups.length > 0 && <span className="mt-0.5 block text-muted-foreground">{f.privilegedGroups.join(", ")}</span>}
          </>
        ) : (
          "No"
        ),
    },
    { label: "Last activity", value: f.lastActivity ? <Time iso={f.lastActivity} /> : muted("None recorded") },
  ];
  return (
    <div className="grid gap-2">
      <div className="grid gap-0.5">
        <p className="font-medium break-words">{f.displayName ?? muted("No name in Falcon")}</p>
        {(f.upn ?? f.email) && <p className="font-mono text-xs break-all text-muted-foreground">{f.upn ?? f.email}</p>}
        {group.ambiguous && (
          <p className="text-xs text-muted-foreground">
            <Badge variant="outline" title="Several Falcon identities go by this account name for this Integration">
              Ambiguous
            </Badge>
          </p>
        )}
      </div>
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0 break-words">{r.value}</dd>
          </div>
        ))}
      </dl>
      {error && <p className="text-xs text-destructive">Last fetch failed: {error}</p>}
    </div>
  );
}

/** How looking the account up by name went, through an Integration with no identity recorded on it. */
function LookupState({ lookup }: { lookup: NonNullable<Group["lookup"]> }) {
  if (lookup.notFound) return <p>Not found in Falcon.</p>;
  if (lookup.error) return <Problem>{lookup.error}</Problem>;
  return lookup.refreshing ? <DetailsSkeleton /> : <p className="text-muted-foreground">Not looked up in Falcon yet.</p>;
}

/** The newest fetch among the identities shown, for the footer. */
const latestFetch = (groups: Group[]) =>
  groups
    .flatMap((g) => [...g.identities.map((i) => i.enrichment.fetchedAt), g.lookup?.checkedAt ?? null])
    .filter((t): t is string => !!t)
    .toSorted()
    .at(-1) ?? null;

/** The hover card's content; mounted only while it is open, so the account is fetched when it opens. */
function AccountCard({ assetId, account }: { assetId: string; account: string }) {
  const queryClient = useQueryClient();
  const q = useQuery(itemPageQuery("asset", assetId));
  const refresh = useMutation({
    mutationFn: () => refreshEnrichment(assetId),
    onError: (e) => toast.error(e.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: itemPagesKey }),
  });
  const item = q.data;
  const groups = item?.falconIdentities ?? [];
  const shown = item?.value ?? account;
  const refreshing = refresh.isPending || groups.some((g) => g.lookup?.refreshing || g.identities.some((i) => i.enrichment.refreshing));
  const asOf = latestFetch(groups);
  let body: ReactNode;
  if (q.isPending) body = <DetailsSkeleton />;
  else if (!item) body = <Problem>{q.error?.message ?? "Could not load the account"}</Problem>;
  else if (!groups.length) body = <p className="text-muted-foreground">No CrowdStrike Integration to look this account up in. An Admin can add one in Settings · Integrations.</p>;
  else
    body = (
      <div className="grid gap-3">
        {groups.map((g) => (
          <section key={g.integration.id} aria-label={g.integration.name} className="grid gap-2">
            {groups.length > 1 && <p className="text-xs text-muted-foreground">{g.integration.name}</p>}
            {g.integration.enrichmentUnavailable && <Problem>{g.integration.enrichmentUnavailable}.</Problem>}
            {g.identities.map((i) => (
              <IdentityFacts key={i.entityId} group={g} identity={i} />
            ))}
            {g.lookup && !g.identities.length && <LookupState lookup={g.lookup} />}
          </section>
        ))}
      </div>
    );
  return (
    <div className="grid gap-2.5" data-testid="account-hover-card">
      <ValueHeader shown={shown} copy={shown} copied={`Copied ${shown}`} href={null} hrefLabel="" />
      <div className="max-h-96 overflow-y-auto border-t pt-2.5">{body}</div>
      {groups.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
          <span>
            Falcon · {refreshing ? "refreshing…" : asOf ? <Time iso={asOf} prefix="as of" /> : "never looked up"}
          </span>
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
 * Wraps an account Asset as it is shown anywhere (a link to its page, a badge) so that resting the
 * pointer on it opens what Falcon Identity Protection says about it, as `IpHoverCard` does for IPs.
 * Focus doesn't open it. `children` must be one element that can hold a ref. `enabled` false leaves
 * it as it is. Guests see the account alone: they never see Enrichment.
 */
export function AccountHoverCard({ assetId, account, enabled = true, children }: { assetId: string; account: string; enabled?: boolean; children: ReactElement }) {
  const role = useQuery(meQuery).data?.organization?.role;
  const card = useHoverCardOpen();
  if (!enabled || !role) return children;
  return (
    <HoverCard openDelay={400} closeDelay={150} open={card.open} onOpenChange={card.onOpenChange}>
      <HoverCardTrigger asChild onFocus={(e: FocusEvent) => e.preventDefault()}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent className="w-80" side="bottom" align="start" collisionPadding={16}>
        <AccountCard assetId={assetId} account={account} />
      </HoverCardContent>
    </HoverCard>
  );
}
