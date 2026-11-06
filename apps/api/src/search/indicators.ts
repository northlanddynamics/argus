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
 * Fewer leading hex characters, down to this many, still find hashes when they mix digits and
 * letters, as the shortened hashes on a Case's Observables tab do (`e3b0…b855`); a word such as
 * "face" or a number such as "2024" doesn't. Such a match ranks below every text match.
 */
export const SHORT_HASH_PREFIX_MIN = 4;

/**
 * How a search query reads as an indicator, the way analysts paste them (defanged, in any case, IPv6
 * uncompressed), normalised as stored values are (`observables/vocabulary.ts`):
 * - `observables` and `assets`: the type and key of each item the query names exactly.
 * - `domain`: a domain, whose subdomains, and URLs and email addresses on it or a subdomain, it finds.
 * - `hashPrefix`: 8 or more hex characters, which find md5, sha1 and sha256 hashes starting with them.
 * - `shortHashPrefix`: 4 to 7 hex characters mixing digits and letters, which find the same, ranked low.
 * - `ipPrefix`: the first two or three parts of an IPv4 address ("185.220", "185.220.101."), which find
 *   the addresses in that range, whole parts only: "198.51.100" finds 198.51.100.7, not 198.51.1.7.
 * - `urlPrefix`: a URL, which finds URLs that start with it (the same page with a longer path or a query).
 */
export type IndicatorQuery = {
  observables: { type: ObservableType; key: string }[];
  assets: { type: AssetType; key: string }[];
  domain: string | null;
  hashPrefix: string | null;
  shortHashPrefix: string | null;
  ipPrefix: string | null;
  urlPrefix: string | null;
};

/** "185.220" or "185.220.101." as the start of an IPv4 address, "185.220.", parts without leading zeros; else null. */
function ipv4Prefix(text: string) {
  const match = /^(\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?\.?$/.exec(text);
  if (!match) return null;
  const parts = match.slice(1).filter((p) => p !== undefined).map(Number);
  return parts.every((p) => p <= 255) ? `${parts.join(".")}.` : null;
}

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
  const refanged = refang(text);
  const hex = refanged.toLowerCase();
  const short = new RegExp(`^[0-9a-f]{${SHORT_HASH_PREFIX_MIN},${HASH_PREFIX_MIN - 1}}$`).test(hex) && /\d/.test(hex) && /[a-f]/.test(hex);
  return {
    observables,
    assets,
    domain: observables.find((o) => o.type === "domain")?.key ?? null,
    hashPrefix: new RegExp(`^[0-9a-f]{${HASH_PREFIX_MIN},64}$`).test(hex) ? hex : null,
    shortHashPrefix: short ? hex : null,
    ipPrefix: ipv4Prefix(refanged),
    urlPrefix: observables.find((o) => o.type === "url")?.key ?? null,
  };
}

/**
 * The query with each word refanged and any URL scheme dropped, for full-text search:
 * `evil[.]example` reads as `evil.example`, and `hxxps://evil[.]example/login` as `evil.example/login`,
 * which is how a stored URL's words begin.
 */
export const refangWords = (query: string) =>
  query
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => refang(word).replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""))
    .filter(Boolean)
    .join(" ");
