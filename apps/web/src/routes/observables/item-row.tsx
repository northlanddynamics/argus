import type { ReactNode } from "react";
import { ItemContext, itemReference } from "@/components/item-context";
import { ItemLink } from "@/components/item-link";
import { EnrichmentButton } from "@/components/observable-details";
import { ItemTypeIcon } from "@/components/item-value";
import { Highlighted } from "@/components/search/search-hit";
import {  defang, type ItemKind, type ObservableType } from "@/lib/observables";

/**
 * An Observable or Asset in the Observables page's lists, laid out as a search result: its type's
 * icon, its value (defanged, with what was searched for in bold) over a muted line of detail, and
 * `aside` on the right, outside the link so it can hold buttons. As on a Case's lists, Observables
 * have their right-click menu, the Enrichment panel (`I`, or the button) and an IP's hover card;
 * hosts and accounts have theirs (`ItemContext`).
 */
export function ItemRow({
  kind,
  id,
  type,
  value,
  query,
  detail,
  aside,
}: {
  kind: ItemKind;
  id: string;
  type: string;
  value: string;
  query: string;
  detail: ReactNode;
  aside?: ReactNode;
}) {
  const observable = kind === "observable";
  const shown = observable ? defang(type as ObservableType, value) : value;
  return (
    <li className="group/row flex min-w-0 items-center hover:bg-muted/60">
      <ItemContext item={itemReference(kind, { id, type, value })}>
            <ItemLink
              kind={kind}
              id={id}
              title={value}
              className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 outline-none focus-visible:bg-muted data-[enrichment-current]:bg-muted"
            >
              <ItemTypeIcon type={type} className="size-4" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm">
                  <Highlighted text={shown} query={query} />
                </div>
                <div className="truncate text-xs text-muted-foreground">{detail}</div>
              </div>
            </ItemLink>
      </ItemContext>
      <div className="flex shrink-0 items-center gap-2 pr-3">
        {aside}
        {observable && <EnrichmentButton type={type as ObservableType} value={value} />}
      </div>
    </li>
  );
}
