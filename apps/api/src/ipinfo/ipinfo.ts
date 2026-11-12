/**
 * IPinfo as Argus uses it (ADR 0010): an adapter, so lookups go to the real Plus API
 * (`ipinfo-http.ts`) in production and to a fake in tests (`test/fake-ipinfo.ts`).
 *
 * An IPinfo Integration sends no Alerts, writes nothing back and takes no Response Actions. It only
 * answers what IPinfo Plus knows about a public IP address: where it is and how precisely, which
 * network announces it, whether it is anonymous (and as a VPN, proxy, Tor exit or relay, run by
 * which service), hosting, anycast, mobile (and on which carrier) or satellite. The answers are
 * cached in `ip_lookups` (`ip-lookups.ts`).
 */

/** An IPinfo API access token. */
export type IpinfoCredentials = { token: string };

/** The kind of network an autonomous system is, as IPinfo classifies it. */
export const AS_TYPES = ["isp", "hosting", "business", "education", "government"] as const;
export type AsType = (typeof AS_TYPES)[number];
export const asTypeLabel: Record<AsType, string> = {
  isp: "ISP",
  hosting: "Hosting",
  business: "Business",
  education: "Education",
  government: "Government",
};

/** What IPinfo Plus reports about a public address. Anything IPinfo leaves out is null (or false). */
export type IpDetails = {
  /** Its reverse DNS name. */
  hostname: string | null;
  city: string | null;
  region: string | null;
  /** The region's ISO 3166-2 subdivision code, such as "CA". */
  regionCode: string | null;
  country: string | null;
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode: string | null;
  continent: string | null;
  /** "EU", "NA". */
  continentCode: string | null;
  latitude: number | null;
  longitude: number | null;
  /** How far, in kilometres, the address may be from the coordinates. */
  accuracyRadius: number | null;
  /** IANA time zone, such as "Europe/Berlin". */
  timezone: string | null;
  postalCode: string | null;
  /** The Nielsen DMA (US metro area) code. */
  dmaCode: string | null;
  /** The city's GeoNames ID. */
  geonameId: string | null;
  /** The day IPinfo last saw the address's location change, "2025-04-01". */
  locationChangedOn: string | null;
  /** "AS15169". */
  asn: string | null;
  asName: string | null;
  asDomain: string | null;
  asType: AsType | null;
  /** The day IPinfo last saw the address move to another AS. */
  asChangedOn: string | null;
  /** A VPN, proxy, Tor exit or relay; which ones are below. */
  anonymous: boolean;
  vpn: boolean;
  proxy: boolean;
  tor: boolean;
  /** A privacy relay, such as iCloud Private Relay. */
  relay: boolean;
  /** The anonymising service, such as "NordVPN", when IPinfo knows it. */
  anonymousService: string | null;
  /** Belongs to a hosting provider, cloud or data centre. */
  hosting: boolean;
  anycast: boolean;
  mobile: boolean;
  satellite: boolean;
  /** The mobile carrier's name, and its mobile country and network codes. */
  carrier: string | null;
  mcc: string | null;
  mnc: string | null;
};

/** Every field of `IpDetails`, null or false, for filling in what an older cached answer lacks. */
export const EMPTY_IP_DETAILS: IpDetails = {
  hostname: null,
  city: null,
  region: null,
  regionCode: null,
  country: null,
  countryCode: null,
  continent: null,
  continentCode: null,
  latitude: null,
  longitude: null,
  accuracyRadius: null,
  timezone: null,
  postalCode: null,
  dmaCode: null,
  geonameId: null,
  locationChangedOn: null,
  asn: null,
  asName: null,
  asDomain: null,
  asType: null,
  asChangedOn: null,
  anonymous: false,
  vpn: false,
  proxy: false,
  tor: false,
  relay: false,
  anonymousService: null,
  hosting: false,
  anycast: false,
  mobile: false,
  satellite: false,
  carrier: null,
  mcc: null,
  mnc: null,
};

/**
 * Whether cached details came from IPinfo Plus. Answers cached while Argus used Core lack the Plus
 * fields, so they are fetched again rather than served as fresh.
 */
export const hasPlusDetails = (details: Partial<IpDetails>) => "vpn" in details;

/** IPinfo's answer: the details, or that the address is a bogon it holds nothing for. */
export type IpinfoAnswer = { bogon: true } | { bogon: false; details: IpDetails };

/** IPinfo refused the token: it is wrong, revoked, or its plan lacks the Plus API. */
export class IpinfoRefused extends Error {}

/** The token's lookup quota is used up for now. */
export class IpinfoQuotaExceeded extends Error {}

export interface IpinfoClient {
  /**
   * What IPinfo knows about `ip`, a public address in canonical form. Rejects with `IpinfoRefused`,
   * `IpinfoQuotaExceeded`, or another error when IPinfo can't be reached or fails.
   */
  lookup(ip: string): Promise<IpinfoAnswer>;
}

/** Makes the client for one Integration. */
export type IpinfoConnector = (credentials: IpinfoCredentials) => IpinfoClient;

/**
 * A range of addresses that mean nothing outside the network they are used in, so are never sent to
 * IPinfo. `internal` ranges are the ones an Organization numbers its own hosts from (private, shared
 * and unique local), which are looked up in Falcon instead (ADR 0018).
 */
export type ReservedRange = { range: string; label: string; internal: boolean };

/** The reserved ranges an Organization's own hosts are addressed from. */
const INTERNAL = new Set(["10.0.0.0/8", "100.64.0.0/10", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]);

const V4_RESERVED: [string, string][] = [
  ["0.0.0.0/8", "“This network”"],
  ["10.0.0.0/8", "Private"],
  ["100.64.0.0/10", "Shared (carrier-grade NAT)"],
  ["127.0.0.0/8", "Loopback"],
  ["169.254.0.0/16", "Link-local"],
  ["172.16.0.0/12", "Private"],
  ["192.0.0.0/24", "IETF protocol"],
  ["192.0.2.0/24", "Documentation"],
  ["192.168.0.0/16", "Private"],
  ["198.18.0.0/15", "Benchmarking"],
  ["198.51.100.0/24", "Documentation"],
  ["203.0.113.0/24", "Documentation"],
  ["224.0.0.0/4", "Multicast"],
  ["240.0.0.0/4", "Reserved"],
];

const V6_RESERVED: [string, string][] = [
  ["::/128", "Unspecified"],
  ["::1/128", "Loopback"],
  ["100::/64", "Discard"],
  ["2001:db8::/32", "Documentation"],
  ["fc00::/7", "Unique local"],
  ["fe80::/10", "Link-local"],
  ["ff00::/8", "Multicast"],
];

/** A dotted IPv4 address as a 32-bit number. */
const v4Bits = (ip: string) => ip.split(".").reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);

/** An IPv6 address (with "::" and an optional dotted tail) as a 128-bit number; null if it isn't one. */
function v6Bits(ip: string): bigint | null {
  let text = ip.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const n = v4Bits(dotted[1]!);
    text = `${text.slice(0, dotted.index)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n);
}

const inRange = (bits: bigint, width: number, cidr: string, parse: (s: string) => bigint | null) => {
  const [base, prefix] = cidr.split("/");
  const size = BigInt(width - Number(prefix));
  return bits >> size === parse(base!)! >> size;
};

/** The reserved range `ip` (canonical IPv4 or IPv6) falls in, or null for a public address. */
export function reservedRange(ip: string): ReservedRange | null {
  if (!ip.includes(":")) {
    const bits = v4Bits(ip);
    const hit = V4_RESERVED.find(([cidr]) => inRange(bits, 32, cidr, v4Bits));
    return hit ? { range: hit[0], label: hit[1], internal: INTERNAL.has(hit[0]) } : null;
  }
  const bits = v6Bits(ip);
  if (bits === null) return null;
  // An IPv4-mapped address (::ffff:a.b.c.d) is the IPv4 address it carries.
  if (bits >> 32n === 0xffffn) {
    const v4 = [24n, 16n, 8n, 0n].map((s) => String((bits >> s) & 0xffn)).join(".");
    return reservedRange(v4);
  }
  const hit = V6_RESERVED.find(([cidr]) => inRange(bits, 128, cidr, v6Bits));
  return hit ? { range: hit[0], label: hit[1], internal: INTERNAL.has(hit[0]) } : null;
}
