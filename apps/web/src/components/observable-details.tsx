import type { ObservableType } from "api/observables/vocabulary";
import { PanelRightOpenIcon } from "lucide-react";
import { Slot } from "radix-ui";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import { DomainHoverCard } from "@/components/domain-details";
import { HashHoverCard } from "@/components/hash-details";
import { IpHoverCard } from "@/components/ip-details";
import { ObservableMenu } from "@/components/observable-menu";
import { RowIconButton } from "@/components/row-icon-button";
import { enrichmentKey, hasEnrichment, useEnrichmentPanel } from "@/lib/enrichment";
import { defang } from "@/lib/observables";
import { cn } from "@/lib/utils";

/**
 * Where an Observable is shown, the ways to open its Enrichment in the Enrichment panel
 * (`docs/wireframes/enrichment-panel.md`): what IPinfo says about an IP (ADR 0010), and what
 * VirusTotal says about a hash's file (ADR 0011) or a domain, an email address's domain or a URL
 * (ADR 0012). Resting the pointer on an IP, a hash or a domain also shows what its source says about
 * it in a hover card (`ValueHoverCard`); the panel opens only on purpose.
 */

/**
 * The hover card for a value of `type`: IPinfo's for an IP, VirusTotal's for a hash or a domain.
 * Any other type (an email address, a URL) has none, and its value is left as it is.
 */
function ValueHoverCard({ type, value, enabled, held, children }: { type: string; value: string; enabled: boolean; held: boolean; children: ReactElement }) {
  switch (type) {
    case "ip":
      return (
        <IpHoverCard ip={value} enabled={enabled} held={held}>
          {children}
        </IpHoverCard>
      );
    case "md5":
    case "sha1":
    case "sha256":
      return (
        <HashHoverCard hash={value} enabled={enabled} held={held}>
          {children}
        </HashHoverCard>
      );
    case "domain":
      return (
        <DomainHoverCard domain={value} enabled={enabled} held={held}>
          {children}
        </DomainHoverCard>
      );
    default:
      return children;
  }
}

/** `I` on a focused value opens its Enrichment, unless a modifier is held or focus is on something inside it. */
const isShortcut = (e: KeyboardEvent) => e.key.toLowerCase() === "i" && !e.metaKey && !e.ctrlKey && !e.altKey && e.target === e.currentTarget;

/**
 * Marks an Observable's value as it is shown anywhere (a link to its page, a badge, plain text) as
 * one the Enrichment panel can show: it becomes part of the list the panel steps through with ↑ ↓,
 * is marked while the panel shows it (its table row takes the selected fill), and `I` on it opens
 * the panel. An IP, a hash or a domain also gets its hover card, unless the panel already shows it
 * or `hoverCard` is false. Any type with no source, `enabled` false, or a Guest, leaves it as it is. `children` must be one element that can
 * take props.
 */
export function EnrichmentTarget({
  type,
  value,
  enabled = true,
  hoverCard = true,
  children,
}: {
  type: ObservableType | string;
  value: string;
  enabled?: boolean;
  /** False for a value already inside a hover card: it keeps the rest, but opens no card of its own. */
  hoverCard?: boolean;
  children: ReactElement;
}) {
  const panel = useEnrichmentPanel();
  if (!enabled || !panel.available || !hasEnrichment(type)) return children;
  const key = enrichmentKey({ type, value });
  return (
    <ValueHoverCard type={type} value={value} enabled={hoverCard} held={panel.currentKey === key}>
      <Slot.Root
        data-enrichment={key}
        data-enrichment-current={panel.currentKey === key ? "" : undefined}
        onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
          if (!isShortcut(e)) return;
          e.preventDefault();
          panel.open({ type, value }, { from: e.currentTarget });
        }}
      >
        {children}
      </Slot.Root>
    </ValueHoverCard>
  );
}

/**
 * A row's "Show Enrichment" button, beside the value it is for: muted until the row is pointed at
 * (the row needs `group/row`), shown while the panel shows its value, and pressing it again closes
 * the panel. Nothing for types with no source, or for Guests.
 */
export function EnrichmentButton({ type, value, className }: { type: ObservableType; value: string; className?: string }) {
  const panel = useEnrichmentPanel();
  if (!panel.available || !hasEnrichment(type)) return null;
  const open = panel.currentKey === enrichmentKey({ type, value });
  return (
    <RowIconButton
      label="Show Enrichment (I)"
      aria-label={`Show Enrichment for ${defang(type, value)}`}
      aria-pressed={open}
      className={cn("size-6 shrink-0", className)}
      onClick={(e) => panel.toggle({ type, value }, { from: e.currentTarget })}
    >
      <PanelRightOpenIcon aria-hidden />
    </RowIconButton>
  );
}

/**
 * Plain Observable text with the Observable menu: a button that opens its Enrichment, for types
 * that have one (for Members), and focusable text otherwise. `children` is how it is shown, and
 * `label` its accessible name when that is shortened.
 */
export function ObservableText({ type, value, label, className, children }: { type: ObservableType; value: string; label?: string; className?: string; children: ReactNode }) {
  const panel = useEnrichmentPanel();
  const style = cn("font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className);
  if (!panel.available || !hasEnrichment(type)) {
    return (
      <ObservableMenu observable={{ type, value }}>
        <span tabIndex={0} className={style} aria-label={label}>
          {children}
        </span>
      </ObservableMenu>
    );
  }
  return (
    <EnrichmentTarget type={type} value={value}>
      <ObservableMenu observable={{ type, value }}>
        <button
          type="button"
          className={cn("cursor-pointer text-left break-all underline underline-offset-2 hover:text-muted-foreground", style)}
          aria-label={label}
          onClick={(e) => panel.toggle({ type, value }, { from: e.currentTarget })}
        >
          {children}
        </button>
      </ObservableMenu>
    </EnrichmentTarget>
  );
}
