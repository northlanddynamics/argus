import { queryOptions } from "@tanstack/react-query";
import { defang, type ObservableType } from "api/observables/vocabulary";
import { api, errorMessage } from "@/lib/api";
import { shortHash } from "@/lib/evidence";

export {
  ASSET_TYPES,
  type AssetType,
  assetTypeLabel,
  defang,
  normaliseObservable,
  OBSERVABLE_TYPES,
  type ObservableType,
  observableTypeLabel,
} from "api/observables/vocabulary";

/** Under the Case's key, so its live signal refreshes them. */
export const observablesKey = (number: number) => ["cases", number, "observables"] as const;
export const assetsKey = (number: number) => ["cases", number, "assets"] as const;

export const observablesQuery = (number: number) =>
  queryOptions({
    queryKey: observablesKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"].observables.$get({ param: { number: String(number) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the Observables");
      return (await res.json()).observables;
    },
  });

export const assetsQuery = (number: number) =>
  queryOptions({
    queryKey: assetsKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"].assets.$get({ param: { number: String(number) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the Assets");
      return (await res.json()).assets;
    },
  });

/** An Observable as shown in lists: hashes shortened, the rest defanged. */
export const shownObservable = (type: ObservableType, value: string) =>
  ["md5", "sha1", "sha256"].includes(type) ? shortHash(value) : defang(type, value);

/** Every Observable and Asset page's query starts with this key; any Case or Alert signal refreshes them. */
export const itemPagesKey = ["items"] as const;

/** An item page's URL search: the Case it was opened from, which its breadcrumb leads back to. */
export type ItemPageSearch = { from?: number };

export const validateItemPageSearch = (search: Record<string, unknown>): ItemPageSearch => {
  const from = Number(search.from);
  return Number.isInteger(from) && from > 0 ? { from } : {};
};

/** Which of the two an item page is about. */
export type ItemKind = "observable" | "asset";

/** An Observable's or Asset's page: null when there's none the viewer may see. */
export const itemPageQuery = (kind: ItemKind, id: string) =>
  queryOptions({
    queryKey: [...itemPagesKey, kind, id],
    queryFn: async () => {
      const res = kind === "observable" ? await api.observables[":id"].$get({ param: { id } }) : await api.assets[":id"].$get({ param: { id } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Could not load the ${kind === "observable" ? "Observable" : "Asset"}`);
      const body = await res.json();
      if (!("item" in body)) throw new Error("Unexpected response");
      return body.item;
    },
  });

export type ItemPage = NonNullable<Awaited<ReturnType<ReturnType<typeof itemPageQuery>["queryFn"] & {}>>>;

/** Under the item pages' key, so the same signals refresh it. */
export const ignoredKey = [...itemPagesKey, "ignored"] as const;

/** The Organization's Ignored list: Observables and Assets that never drive a Correlation. */
export const ignoredQuery = queryOptions({
  queryKey: ignoredKey,
  queryFn: async () => {
    const res = await api["ignored-observables"].$get();
    if (!res.ok) throw new Error("Could not load the Ignored list");
    const body = await res.json();
    if (!("ignored" in body)) throw new Error("Unexpected response");
    return body.ignored;
  },
});

export type IgnoredEntry = Awaited<ReturnType<typeof ignoredQuery.queryFn & {}>>[number];

/** Puts an Observable or Asset on the Ignored list, or takes it off. */
/** Asks Falcon again for a host's Enrichment (ADR 0009); the page shows it as refreshing until it arrives. */
export async function refreshEnrichment(id: string) {
  const res = await api.assets[":id"].enrichment.$post({ param: { id } });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not refresh the Enrichment"));
}

export async function setIgnored(kind: ItemKind, id: string, ignored: boolean) {
  const param = { param: { id } };
  const route = kind === "observable" ? api.observables[":id"].ignored : api.assets[":id"].ignored;
  const res = ignored ? await route.$put(param) : await route.$delete(param);
  if (!res.ok) throw new Error(await errorMessage(res, ignored ? "Could not ignore it" : "Could not stop ignoring it"));
}
