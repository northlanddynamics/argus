import { queryOptions } from "@tanstack/react-query";
import { reservedRange } from "api/ipinfo/ipinfo";
import { defang, type ObservableType } from "api/observables/vocabulary";
import { withheldDomain } from "api/virustotal/virustotal";
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
  refang,
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

const HASHES: readonly ObservableType[] = ["md5", "sha1", "sha256"];

/** An Observable as shown in lists: hashes shortened, the rest defanged. */
export const shownObservable = (type: ObservableType, value: string) =>
  HASHES.includes(type) ? shortHash(value) : defang(type, value);

/**
 * The ways to copy an Observable: defanged and fanged where the two differ (domains, URLs, email
 * addresses), as it is where they don't (IPs, hashes).
 */
export function observableCopies(type: ObservableType, value: string) {
  const defanged = defang(type, value);
  if (defanged === value) return [{ label: "Copy", text: value, done: "Copied" }];
  return [
    { label: "Copy defanged", text: defanged, done: "Copied (defanged)" },
    { label: "Copy fanged", text: value, done: "Copied (fanged)" },
  ];
}

/**
 * Where an Observable can be looked up outside Argus: a hash or a domain (an email address's, too)
 * in VirusTotal, a public IP in VirusTotal and on IPinfo.io. Reserved IPs and internal names mean nothing outside
 * their own network, so have none (as in ADR 0010 and ADR 0012). A URL's VirusTotal page is under an
 * identifier only VirusTotal knows, so its popup links it once VirusTotal has reported on it.
 */
export function observableLookups(type: ObservableType, value: string): { label: string; source: string; href: string }[] {
  const vt = (path: string) => ({ label: "Open in VirusTotal", source: "VirusTotal", href: `https://www.virustotal.com/gui/${path}` });
  if (HASHES.includes(type)) return [vt(`file/${encodeURIComponent(value)}`)];
  if (type === "domain" || type === "email") {
    const domain = type === "email" ? value.slice(value.lastIndexOf("@") + 1) : value;
    return withheldDomain(domain) ? [] : [vt(`domain/${encodeURIComponent(domain)}`)];
  }
  if (type === "ip" && !reservedRange(value)) {
    return [vt(`ip-address/${encodeURIComponent(value)}`), { label: "Open in IPinfo.io", source: "IPinfo.io", href: `https://ipinfo.io/${encodeURIComponent(value)}` }];
  }
  return [];
}

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

/** The Observables page's URL search: the value typed, and the types ticked (every type when none are). */
export type ObservablesSearch = { q?: string; types?: string };

export const validateObservablesSearch = (search: Record<string, unknown>): ObservablesSearch => ({
  q: typeof search.q === "string" && search.q ? search.q : undefined,
  types: typeof search.types === "string" && search.types ? search.types : undefined,
});

/** The types ticked on the Observables page, Observable and Asset types alike. */
export const tickedTypes = (types: string | undefined) => new Set(types?.split(",").filter(Boolean) ?? []);

/** Under the item pages' key, so the same signals refresh it. */
export const observableListKey = [...itemPagesKey, "list"] as const;

/**
 * The Organization's Observables, newest first, of `types` (every type when empty) and containing
 * `q`. Members only. The API gives the first 200; `more` says there are others.
 */
export const observableListQuery = (q: string, types: readonly ObservableType[]) =>
  queryOptions({
    queryKey: [...observableListKey, q, types.join(",")],
    queryFn: async () => {
      const res = await api.observables.$get({ query: { ...(q ? { q } : {}), ...(types.length ? { types: types.join(",") } : {}) } });
      if (!res.ok) throw new Error("Could not load the Observables");
      const body = await res.json();
      if (!("observables" in body)) throw new Error("Unexpected response");
      return body;
    },
  });

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

/**
 * Puts the Observable of `type` with this value on the Ignored list, or takes it off, wherever it is
 * shown: Argus adds it first if the Organization doesn't hold it yet.
 */
export async function setIgnoredByValue(type: ObservableType, value: string, ignored: boolean) {
  const res = await api.observables.ignored.$post({ json: { type, value, ignored } });
  if (!res.ok) throw new Error(await errorMessage(res, ignored ? "Could not ignore it" : "Could not stop ignoring it"));
}

/** Under the item pages' key, so the same signals refresh it. */
export const importantKey = [...itemPagesKey, "important"] as const;

/** The Organization's Important Observables: the only Observables that drive a Correlation. Members only. */
export const importantQuery = queryOptions({
  queryKey: importantKey,
  queryFn: async () => {
    const res = await api["important-observables"].$get();
    if (!res.ok) throw new Error("Could not load the Important Observables");
    const body = await res.json();
    if (!("important" in body)) throw new Error("Unexpected response");
    return body.important;
  },
});

/** Marks an Observable Important, or unmarks it. */
export async function setImportant(id: string, important: boolean) {
  const param = { param: { id } };
  const route = api.observables[":id"].important;
  const res = important ? await route.$put(param) : await route.$delete(param);
  if (!res.ok) throw new Error(await errorMessage(res, important ? "Could not mark it Important" : "Could not unmark it"));
}

/**
 * Marks the Observable of `type` with this value Important, or unmarks it, wherever it is shown:
 * Argus adds it first if the Organization doesn't hold it yet.
 */
export async function setImportantByValue(type: ObservableType, value: string, important: boolean) {
  const res = await api.observables.important.$post({ json: { type, value, important } });
  if (!res.ok) throw new Error(await errorMessage(res, important ? "Could not mark it Important" : "Could not unmark it"));
}
