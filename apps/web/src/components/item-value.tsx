import { AtSignIcon, FingerprintIcon, GlobeIcon, HashIcon, LinkIcon, type LucideIcon, MonitorIcon, NetworkIcon, UserIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ItemContext, type ItemReference } from "@/components/item-context";
import { ItemLink } from "@/components/item-link";
import { Badge } from "@/components/ui/badge";
import { hasEnrichment, useEnrichmentPanel } from "@/lib/enrichment";
import { type AssetType, assetTypeLabel, defang, type ObservableType, observableTypeLabel } from "@/lib/observables";
import { cn } from "@/lib/utils";

/**
 * How Argus shows an Observable or Asset wherever it refers to one: its type as an icon, not a word,
 * then its value, defanged for Observables. The icon carries the type's name for screen readers and
 * on hover, so nothing beside the value needs to spell it out.
 */

export const observableIcon: Record<ObservableType, LucideIcon> = {
  ip: NetworkIcon,
  domain: GlobeIcon,
  url: LinkIcon,
  email: AtSignIcon,
  md5: HashIcon,
  sha1: HashIcon,
  sha256: HashIcon,
};

export const assetIcon: Record<AssetType, LucideIcon> = { host: MonitorIcon, account: UserIcon };

/** "IP", "SHA-256", "Host": the name of an Observable's or Asset's type. */
export const itemTypeLabel = (type: string): string =>
  observableTypeLabel[type as ObservableType] ?? assetTypeLabel[type as AssetType] ?? type;

/**
 * The icon of an Observable's or Asset's type. Named with the type ("IP") for screen readers and on
 * hover; `decorative` hides it from them where the type is already said, such as under a heading.
 */
export function ItemTypeIcon({ type, decorative = false, className }: { type: string; decorative?: boolean; className?: string }) {
  const Icon = observableIcon[type as ObservableType] ?? assetIcon[type as AssetType] ?? FingerprintIcon;
  const style = cn("size-3.5 shrink-0 text-muted-foreground", className);
  if (decorative) return <Icon className={style} aria-hidden />;
  const label = itemTypeLabel(type);
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex shrink-0">
      <Icon className={style} aria-hidden />
    </span>
  );
}

/** A value as shown: defanged when it is an Observable's. */
export const shownValue = (type: string, value: string) => (type in observableTypeLabel ? defang(type as ObservableType, value) : value);

/** The icon and the value side by side, as text with nothing behind it, for lists that describe rather than link (a dialog's). */
export function ItemText({ type, value, truncate = false, className }: { type: string; value: string; truncate?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex max-w-full min-w-0 gap-1.5", truncate ? "items-center" : "items-start", className)} title={value}>
      <ItemTypeIcon type={type} className={truncate ? undefined : "mt-px"} />
      <span className={cn("min-w-0 font-mono text-xs", truncate ? "truncate" : "break-all")}>{shownValue(type, value)}</span>
    </span>
  );
}

/**
 * An Observable or Asset as a page refers to it: the type's icon and the value, through
 * `ItemContext` (its hover card, Enrichment and menu), and, with `id`, a link to its page.
 *
 * - `badge` shows it as an outline chip, for rows of several (what an Alert shares with a Case).
 * - Otherwise it is mono text, cut short with … when `truncate` (a table cell), wrapped otherwise.
 * - Without `id` (a value Argus doesn't hold yet) it links nowhere; for a type with a source,
 *   pressing it opens its Enrichment.
 *
 * The link is named "IP 185.220.101.4", as before the type became an icon. `icon` false leaves the
 * icon out where the place already says the type (a list headed "Contained hosts").
 */
export function ItemValue({
  item,
  id,
  fromCase,
  badge = false,
  truncate = false,
  icon = true,
  className,
  children,
}: {
  item: ItemReference;
  /** The Observable's or Asset's id, for the link to its page; none for a value Argus doesn't hold. */
  id?: string | null;
  fromCase?: number;
  badge?: boolean;
  truncate?: boolean;
  icon?: boolean;
  className?: string;
  /** How the value is shown, when not as `shownValue` gives it. */
  children?: ReactNode;
}) {
  const panel = useEnrichmentPanel();
  const label = `${itemTypeLabel(item.type)} ${shownValue(item.type, item.value)}`;
  const text = (
    <>
      {icon && <ItemTypeIcon type={item.type} decorative className={badge ? undefined : "mt-px"} />}
      <span className={cn("min-w-0", badge || truncate ? "truncate" : "break-all")}>{children ?? shownValue(item.type, item.value)}</span>
    </>
  );
  const inline = cn(
    "inline-flex max-w-full min-w-0 gap-1.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
    truncate ? "items-center" : "items-start",
    id && "hover:underline",
    className,
  );
  let shown;
  if (badge) {
    shown = (
      <Badge variant="outline" className={cn("max-w-full font-mono", className)} title={item.value} asChild>
        {id ? (
          <ItemLink kind={item.kind} id={id} fromCase={fromCase} aria-label={label}>
            {text}
          </ItemLink>
        ) : (
          <span tabIndex={0} aria-label={label}>
            {text}
          </span>
        )}
      </Badge>
    );
  } else if (id) {
    shown = (
      <ItemLink kind={item.kind} id={id} fromCase={fromCase} className={inline} title={item.value} aria-label={label}>
        {text}
      </ItemLink>
    );
  } else if (item.kind === "observable" && panel.available && hasEnrichment(item.type)) {
    // Not held yet, so no page to link to: pressing it opens its Enrichment instead.
    const target = { type: item.type, value: item.value };
    shown = (
      <button
        type="button"
        className={cn(inline, "cursor-pointer text-left underline underline-offset-2 hover:text-muted-foreground")}
        title={item.value}
        aria-label={label}
        onClick={(e) => panel.toggle(target, { from: e.currentTarget })}
      >
        {text}
      </button>
    );
  } else {
    shown = (
      <span tabIndex={0} className={inline} title={item.value} aria-label={label}>
        {text}
      </span>
    );
  }
  return <ItemContext item={item}>{shown}</ItemContext>;
}
