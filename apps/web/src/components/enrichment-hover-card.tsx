import { useQuery } from "@tanstack/react-query";
import type { FocusEvent, ReactElement, ReactNode } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { meQuery } from "@/lib/api";
import { useHoverCardOpen } from "@/lib/hover-card";
import { canManage } from "@/lib/roles";

/**
 * The hover card an Observable's value opens with what its source says about it: IPinfo for an IP
 * (`IpHoverCard`), VirusTotal for a hash (`HashHoverCard`) or a domain (`DomainHoverCard`).
 *
 * Opens 400 ms after the pointer rests on the value and closes 150 ms after it leaves both; focus
 * doesn't open it (from the keyboard, `I` opens the Enrichment panel), nor does it open over a
 * right-click menu. `card` is its content, mounted only while it is open, so the lookup starts when
 * it opens rather than when the value renders. `children` must be one element that can hold a ref.
 * `enabled` false leaves it as it is; `held` keeps the card shut without remounting the value (while
 * the Enrichment panel shows it, so focus can return to it). Guests see the value alone: Argus never
 * spends the Organization's quota or a Member's key on their behalf.
 */
export function EnrichmentHoverCard({
  enabled = true,
  held = false,
  card,
  children,
}: {
  enabled?: boolean;
  held?: boolean;
  /** The card's content; `admin` says whether the viewer can fix a missing Integration themselves. */
  card: (admin: boolean) => ReactNode;
  children: ReactElement;
}) {
  const role = useQuery(meQuery).data?.organization?.role;
  const state = useHoverCardOpen();
  if (!enabled || !role) return children;
  return (
    <HoverCard openDelay={400} closeDelay={150} open={state.open && !held} onOpenChange={state.onOpenChange}>
      <HoverCardTrigger asChild data-hovercard="" onFocus={(e: FocusEvent) => e.preventDefault()}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent className="w-80" side="bottom" align="start" collisionPadding={16}>
        {card(canManage(role))}
      </HoverCardContent>
    </HoverCard>
  );
}
