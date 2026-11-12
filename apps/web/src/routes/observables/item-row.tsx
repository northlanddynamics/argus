import { FingerprintIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { ItemLink } from "@/components/item-link";
import { ObservableMenu } from "@/components/observable-menu";
import { assetIcon, Highlighted, observableIcon } from "@/components/search/search-hit";
import { type AssetType, defang, type ItemKind, type ObservableType } from "@/lib/observables";

/** The icon of an Observable's or Asset's type, as search results show it. */
export function TypeIcon({ type, className = "size-4 shrink-0 text-muted-foreground" }: { type: string; className?: string }) {
  const Icon = observableIcon[type as ObservableType] ?? assetIcon[type as AssetType] ?? FingerprintIcon;
  return <Icon className={className} aria-hidden />;
}

/**
 * An Observable or Asset in the Observables page's lists, laid out as a search result: its type's
 * icon, its value (defanged, with what was searched for in bold) over a muted line of detail, and
 * `aside` on the right, outside the link so it can hold buttons. Observables have their
 * right-click menu.
 */
export function ItemRow({
  kind,
  id,
  type,
  value,
  query,
  detail,
  aside,
  children,
}: {
  kind: ItemKind;
  id: string;
  type: string;
  value: string;
  query: string;
  detail: ReactNode;
  aside?: ReactNode;
  /** Wraps the link, as a hover card does. */
  children?: (link: ReactElement) => ReactNode;
}) {
  const shown = kind === "observable" ? defang(type as ObservableType, value) : value;
  const link = (
    <ObservableMenu observable={kind === "observable" ? { type: type as ObservableType, value } : null}>
      <ItemLink kind={kind} id={id} title={value} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 outline-none focus-visible:bg-muted">
        <TypeIcon type={type} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm">
            <Highlighted text={shown} query={query} />
          </div>
          <div className="truncate text-xs text-muted-foreground">{detail}</div>
        </div>
      </ItemLink>
    </ObservableMenu>
  );
  return (
    <li className="flex min-w-0 items-center hover:bg-muted/60">
      {children ? children(link) : link}
      {aside && <div className="flex shrink-0 items-center gap-2 pr-3">{aside}</div>}
    </li>
  );
}
