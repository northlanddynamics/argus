import {
  ASSET_TYPES,
  OBSERVABLE_TYPES,
  normaliseAsset,
  normaliseObservable,
  refang,
  type AssetType,
  type ObservableType,
} from "../observables/vocabulary";

/** The Observable types found only by indicator rules, never by full text: matching part of one is a false hit. */
export const EXACT_ONLY_TYPES = ["ip", "md5", "sha1", "sha256"] as const satisfies readonly ObservableType[];

/** Leading hex characters a query needs before it finds hashes that start with it. */
export const HASH_PREFIX_MIN = 8;

/**
 * How a search query reads as an indicator, the way analysts paste them (defanged, in any case, IPv6
 * uncompressed), normalised as stored values are (`observables/vocabulary.ts`):
 * - `observables` and `assets`: the type and key of each item the query names exactly.
 * - `domain`: a domain, whose subdomains, and URLs and email addresses on it or a subdomain, it finds.
 * - `hashPrefix`: 8 or more hex characters, which find md5, sha1 and sha256 hashes starting with them.
 */
export type IndicatorQuery = {
  observables: { type: ObservableType; key: string }[];
  assets: { type: AssetType; key: string }[];
  domain: string | null;
  hashPrefix: string | null;
};

export function readIndicator(query: string): IndicatorQuery {
  const text = query.trim();
  const observables = OBSERVABLE_TYPES.flatMap((type) => {
    const normalised = normaliseObservable(type, text);
    return normalised ? [{ type, key: normalised.key }] : [];
  });
  const assets = ASSET_TYPES.flatMap((type) => {
    const normalised = normaliseAsset(type, text);
    return normalised ? [{ type, key: normalised.key }] : [];
  });
  const hex = refang(text).toLowerCase();
  return {
    observables,
    assets,
    domain: observables.find((o) => o.type === "domain")?.key ?? null,
    hashPrefix: new RegExp(`^[0-9a-f]{${HASH_PREFIX_MIN},64}$`).test(hex) ? hex : null,
  };
}

/** The query with each word refanged, for full-text search: `evil[.]example` reads as `evil.example`. */
export const refangWords = (query: string) =>
  query
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => refang(word))
    .join(" ");
