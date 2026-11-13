import type { AssetType, ObservableType } from "api/observables/vocabulary";
import type { ReactElement } from "react";
import { AccountHoverCard } from "@/components/account-details";
import { HostHoverCard } from "@/components/host-details";
import { EnrichmentTarget } from "@/components/observable-details";
import { ObservableMenu } from "@/components/observable-menu";

/** An Observable or Asset as a page refers to it; an Asset needs its id for its hover card. */
export type ItemReference =
  | { kind: "observable"; type: ObservableType; value: string }
  | { kind: "asset"; id: string; type: AssetType | string; value: string };

/** The reference to a held Observable or Asset of `kind`, as lists that show either carry it. */
export const itemReference = (kind: "observable" | "asset", item: { id: string; type: string; value: string }): ItemReference =>
  kind === "observable" ? { kind, type: item.type as ObservableType, value: item.value } : { kind, id: item.id, type: item.type, value: item.value };

/**
 * Everything Argus offers on an Observable or Asset wherever it is shown other than in running text
 * (a link to its page, a badge, a value in a list): the one wrapper every such reference goes
 * through, so they all behave the same.
 *
 * - An Observable is an `EnrichmentTarget` (the IPinfo hover card for an IP, `I` and the panel's
 *   ↑ ↓ for any type with a source) with the Observable menu on right-click.
 * - A host Asset gets the Falcon device hover card (`HostHoverCard`), an account Asset the Falcon
 *   identity hover card (`AccountHoverCard`).
 *
 * `item` null (a value Argus doesn't hold, or doesn't know the kind of) leaves `children` as they
 * are. `children` must be one element that can take props and hold a ref. `hoverCard` false leaves
 * out the hover cards, for a reference already inside one; `menu` false leaves out the Observable
 * menu, for a row whose own right-click menu (a Case's `ObservableActions`) already offers it.
 */
export function ItemContext({
  item,
  hoverCard = true,
  menu = true,
  children,
}: {
  item: ItemReference | null | undefined;
  hoverCard?: boolean;
  menu?: boolean;
  children: ReactElement;
}) {
  if (!item) return children;
  if (item.kind === "observable") {
    return (
      <EnrichmentTarget type={item.type} value={item.value} hoverCard={hoverCard}>
        {/* ObservableMenu with no Observable drops the props the hover card's trigger hands it, so it is left out entirely. */}
        {menu ? <ObservableMenu observable={{ type: item.type, value: item.value }}>{children}</ObservableMenu> : children}
      </EnrichmentTarget>
    );
  }
  if (!hoverCard) return children;
  if (item.type === "host") {
    return (
      <HostHoverCard assetId={item.id} host={item.value}>
        {children}
      </HostHoverCard>
    );
  }
  if (item.type === "account") {
    return (
      <AccountHoverCard assetId={item.id} account={item.value}>
        {children}
      </AccountHoverCard>
    );
  }
  return children;
}
