import {
  type AnalysisStats,
  type Detection,
  type DomainReport,
  type FileReport,
  type UrlReport,
  type VirustotalClient,
  type VirustotalCredentials,
  VirustotalQuotaExceeded,
  VirustotalRefused,
} from "./virustotal";

/**
 * VirusTotal's v3 API over HTTP, with the key in `x-apikey`: `GET /files/{hash}`, `GET
 * /domains/{domain}` and `GET /urls/{id}`, the URL's id being it in unpadded base64url, which
 * VirusTotal canonicalises as it does on submission. Lookups only: nothing is ever submitted.
 * Unverified against a live key.
 */

const BASE_URL = "https://www.virustotal.com/api/v3";

/** How long a lookup may take before it counts as failed: someone is waiting on it. */
const REQUEST_TIMEOUT_MS = 8_000;

/** At most this many other names and detections are kept. */
const MAX_LISTED = 10;

/** A VirusTotal API call failed; the message says how. */
export class VirustotalError extends Error {}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown) => num(v) ?? 0;
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strings = (v: unknown) => (Array.isArray(v) ? v.map(str).filter((s): s is string => s !== null) : []);
/** A Unix time in seconds as ISO 8601. */
const time = (v: unknown) => {
  const s = num(v);
  return s === null ? null : new Date(s * 1000).toISOString();
};
/** `[{ value, count }]`, most counted first, as their values. */
const ranked = (v: unknown) =>
  (Array.isArray(v) ? v.map(obj) : [])
    .filter((e) => str(e.value))
    .toSorted((a, b) => count(b.count) - count(a.count))
    .map((e) => str(e.value)!);

/** `last_analysis_stats` as `AnalysisStats`. */
const statsOf = (v: unknown): AnalysisStats => {
  const stats = obj(v);
  return {
    malicious: count(stats.malicious),
    suspicious: count(stats.suspicious),
    undetected: count(stats.undetected),
    harmless: count(stats.harmless),
    unsupported: count(stats["type-unsupported"]),
    failed: count(stats.timeout) + count(stats["confirmed-timeout"]) + count(stats.failure),
  };
};

/** The engines `last_analysis_results` says call it malicious, by name, at most ten. */
const detectionsOf = (v: unknown): Detection[] =>
  Object.entries(obj(v))
    .map(([engine, r]) => ({ engine: str(obj(r).engine_name) ?? engine, category: obj(r).category, result: str(obj(r).result) }))
    .filter((d) => d.category === "malicious" && d.result)
    .toSorted((x, y) => x.engine.localeCompare(y.engine))
    .slice(0, MAX_LISTED)
    .map((d) => ({ engine: d.engine, result: d.result! }));

const votesOf = (v: unknown) => {
  const votes = obj(v);
  return { harmless: count(votes.harmless), malicious: count(votes.malicious) };
};

/** `categories` (`{ vendor: category }`) as each category once, those most vendors agree on first. */
const categoriesOf = (v: unknown) => {
  const tally = new Map<string, number>();
  for (const c of Object.values(obj(v))) {
    const name = str(c)?.toLowerCase();
    if (name) tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  return [...tally].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
};

/** A certificate's "2026-10-16 08:10:06" (UTC) as ISO 8601. */
const certTime = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(`${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** The DNS record types shown, in the order they are. */
const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "NS"];

/** A v3 domain object as a `DomainReport`. */
export function readDomain(body: Record<string, unknown>): DomainReport {
  const data = obj(body.data);
  const a = obj(data.attributes);
  const cert = obj(a.last_https_certificate);
  const issuer = obj(cert.issuer);
  const validity = obj(cert.validity);
  const dns = (Array.isArray(a.last_dns_records) ? a.last_dns_records.map(obj) : [])
    .map((r) => ({ type: str(r.type)?.toUpperCase() ?? "", value: str(r.value) }))
    .filter((r): r is { type: string; value: string } => DNS_TYPES.includes(r.type) && r.value !== null)
    .toSorted((x, y) => DNS_TYPES.indexOf(x.type) - DNS_TYPES.indexOf(y.type))
    .slice(0, MAX_LISTED);
  const popularity = Object.entries(obj(a.popularity_ranks))
    .map(([list, r]) => ({ list, rank: num(obj(r).rank) }))
    .filter((p): p is { list: string; rank: number } => p.rank !== null)
    .toSorted((x, y) => x.rank - y.rank);
  return {
    domain: (str(data.id) ?? "").toLowerCase(),
    stats: statsOf(a.last_analysis_stats),
    detections: detectionsOf(a.last_analysis_results),
    categories: categoriesOf(a.categories),
    reputation: num(a.reputation),
    votes: votesOf(a.total_votes),
    tags: strings(a.tags),
    registeredAt: time(a.creation_date),
    registrar: str(a.registrar),
    dns,
    certificate: Object.keys(cert).length
      ? { issuer: str(issuer.O) ?? str(issuer.CN), subject: str(obj(cert.subject).CN), validFrom: certTime(validity.not_before), validUntil: certTime(validity.not_after) }
      : null,
    popularity,
    lastAnalysisAt: time(a.last_analysis_date),
  };
}

/** A v3 URL object as a `UrlReport`. */
export function readUrl(body: Record<string, unknown>): UrlReport {
  const data = obj(body.data);
  const a = obj(data.attributes);
  const url = str(a.url);
  const finalUrl = str(a.last_final_url);
  return {
    id: str(data.id),
    url,
    finalUrl: finalUrl && finalUrl !== url ? finalUrl : null,
    redirects: strings(a.redirection_chain).slice(0, MAX_LISTED),
    title: str(a.title),
    httpStatus: num(a.last_http_response_code),
    stats: statsOf(a.last_analysis_stats),
    detections: detectionsOf(a.last_analysis_results),
    categories: categoriesOf(a.categories),
    threatNames: strings(a.threat_names),
    reputation: num(a.reputation),
    votes: votesOf(a.total_votes),
    tags: strings(a.tags),
    firstSubmittedAt: time(a.first_submission_date),
    lastSubmittedAt: time(a.last_submission_date),
    timesSubmitted: num(a.times_submitted),
    lastAnalysisAt: time(a.last_analysis_date),
  };
}

/** A URL as VirusTotal's URL identifier: unpadded base64url of it. */
export const urlIdentifier = (url: string) => Buffer.from(url, "utf8").toString("base64url");

/** A v3 file object's attributes as a `FileReport`. */
export function readFile(body: Record<string, unknown>): FileReport {
  const a = obj(obj(body.data).attributes);
  const threat = obj(a.popular_threat_classification);
  const signature = obj(a.signature_info);
  const name = str(a.meaningful_name);
  return {
    md5: str(a.md5)?.toLowerCase() ?? null,
    sha1: str(a.sha1)?.toLowerCase() ?? null,
    sha256: str(a.sha256)?.toLowerCase() ?? null,
    name,
    names: strings(a.names)
      .filter((n) => n !== name)
      .slice(0, MAX_LISTED),
    size: num(a.size),
    typeDescription: str(a.type_description),
    stats: statsOf(a.last_analysis_stats),
    lastAnalysisAt: time(a.last_analysis_date),
    firstSubmittedAt: time(a.first_submission_date),
    lastSubmittedAt: time(a.last_submission_date),
    timesSubmitted: num(a.times_submitted),
    reputation: num(a.reputation),
    threatLabel: str(threat.suggested_threat_label),
    threatCategories: ranked(threat.popular_threat_category),
    threatNames: ranked(threat.popular_threat_name),
    tags: strings(a.tags),
    votes: votesOf(a.total_votes),
    signature: Object.keys(signature).length ? { signers: str(signature.signers), verified: str(signature.verified) } : null,
    detections: detectionsOf(a.last_analysis_results),
  };
}

async function reason(res: Response) {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return [body.error?.code, body.error?.message].filter(Boolean).join(": ");
  } catch {
    return "";
  }
}

export function virustotalHttpClient(credentials: VirustotalCredentials, fetchImpl: typeof fetch = fetch): VirustotalClient {
  /** The object at `path`, or null when VirusTotal has never seen it. */
  const get = async (path: string): Promise<Record<string, unknown> | null> => {
    let res: Response;
    try {
      res = await fetchImpl(`${BASE_URL}${path}`, {
        headers: { "x-apikey": credentials.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      throw new VirustotalError(`VirusTotal couldn't be reached: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      const why = await reason(res);
      throw new VirustotalRefused(`VirusTotal refused your API key${why ? ` (${why})` : ""}`);
    }
    if (res.status === 429) throw new VirustotalQuotaExceeded("Your VirusTotal API key's lookup quota is used up for now");
    if (!res.ok) {
      const why = await reason(res);
      throw new VirustotalError(`VirusTotal lookup failed: ${res.status}${why ? ` ${why}` : ""}`);
    }
    return (await res.json()) as Record<string, unknown>;
  };

  return {
    async lookup(hash) {
      const body = await get(`/files/${encodeURIComponent(hash)}`);
      return body ? { found: true, report: readFile(body) } : { found: false };
    },
    async lookupDomain(domain) {
      const body = await get(`/domains/${encodeURIComponent(domain)}`);
      return body ? { found: true, report: readDomain(body) } : { found: false };
    },
    async lookupUrl(url) {
      const body = await get(`/urls/${urlIdentifier(url)}`);
      return body ? { found: true, report: readUrl(body) } : { found: false };
    },
  };
}
