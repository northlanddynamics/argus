import { AS_TYPES, type AsType, type IpDetails, type IpinfoAnswer, type IpinfoClient, type IpinfoCredentials, IpinfoQuotaExceeded, IpinfoRefused } from "./ipinfo";

/**
 * IPinfo's Core API over HTTP: `GET https://api.ipinfo.io/lookup/{ip}` with the token as a bearer
 * token. Unverified against a live token.
 */

const BASE_URL = "https://api.ipinfo.io";

/** How long a lookup may take before it counts as failed: someone is waiting on it. */
const REQUEST_TIMEOUT_MS = 8_000;

/** An IPinfo API call failed; the message says how. */
export class IpinfoError extends Error {}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** IPinfo Core's JSON as `IpDetails`, or a bogon. */
export function readLookup(body: Record<string, unknown>): IpinfoAnswer {
  if (body.bogon === true) return { bogon: true };
  const geo = obj(body.geo);
  const as = obj(body.as);
  const asType = str(as.type)?.toLowerCase();
  const details: IpDetails = {
    hostname: str(body.hostname),
    city: str(geo.city),
    region: str(geo.region),
    country: str(geo.country),
    countryCode: str(geo.country_code)?.toUpperCase() ?? null,
    continent: str(geo.continent),
    latitude: num(geo.latitude),
    longitude: num(geo.longitude),
    timezone: str(geo.timezone),
    postalCode: str(geo.postal_code),
    asn: str(as.asn),
    asName: str(as.name),
    asDomain: str(as.domain),
    asType: (AS_TYPES as readonly string[]).includes(asType ?? "") ? (asType as AsType) : null,
    anonymous: body.is_anonymous === true,
    hosting: body.is_hosting === true,
    anycast: body.is_anycast === true,
    mobile: body.is_mobile === true,
    satellite: body.is_satellite === true,
  };
  return { bogon: false, details };
}

async function reason(res: Response) {
  try {
    const body = (await res.json()) as { error?: { title?: string; message?: string } | string };
    if (typeof body.error === "string") return body.error;
    return [body.error?.title, body.error?.message].filter(Boolean).join(": ");
  } catch {
    return "";
  }
}

export function ipinfoHttpClient(credentials: IpinfoCredentials, fetchImpl: typeof fetch = fetch): IpinfoClient {
  return {
    async lookup(ip) {
      let res: Response;
      try {
        res = await fetchImpl(`${BASE_URL}/lookup/${encodeURIComponent(ip)}`, {
          headers: { authorization: `Bearer ${credentials.token}`, accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        throw new IpinfoError(`IPinfo couldn't be reached: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status === 401 || res.status === 403) {
        const why = await reason(res);
        throw new IpinfoRefused(`IPinfo refused the API token${why ? ` (${why})` : ""}`);
      }
      if (res.status === 429) throw new IpinfoQuotaExceeded("IPinfo's lookup quota for this token is used up");
      if (!res.ok) {
        const why = await reason(res);
        throw new IpinfoError(`IPinfo lookup failed: ${res.status}${why ? ` ${why}` : ""}`);
      }
      return readLookup((await res.json()) as Record<string, unknown>);
    },
  };
}
