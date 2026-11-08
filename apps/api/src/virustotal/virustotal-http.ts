import { type FileReport, type VirustotalAnswer, type VirustotalClient, type VirustotalCredentials, VirustotalQuotaExceeded, VirustotalRefused } from "./virustotal";

/**
 * VirusTotal's v3 API over HTTP: `GET https://www.virustotal.com/api/v3/files/{hash}` with the key in
 * `x-apikey`. Unverified against a live key.
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

/** A v3 file object's attributes as a `FileReport`. */
export function readFile(body: Record<string, unknown>): FileReport {
  const a = obj(obj(body.data).attributes);
  const stats = obj(a.last_analysis_stats);
  const threat = obj(a.popular_threat_classification);
  const votes = obj(a.total_votes);
  const signature = obj(a.signature_info);
  const name = str(a.meaningful_name);
  const detections = Object.entries(obj(a.last_analysis_results))
    .map(([engine, r]) => ({ engine: str(obj(r).engine_name) ?? engine, category: obj(r).category, result: str(obj(r).result) }))
    .filter((d) => d.category === "malicious" && d.result)
    .toSorted((x, y) => x.engine.localeCompare(y.engine))
    .slice(0, MAX_LISTED)
    .map((d) => ({ engine: d.engine, result: d.result! }));
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
    stats: {
      malicious: count(stats.malicious),
      suspicious: count(stats.suspicious),
      undetected: count(stats.undetected),
      harmless: count(stats.harmless),
      unsupported: count(stats["type-unsupported"]),
      failed: count(stats.timeout) + count(stats["confirmed-timeout"]) + count(stats.failure),
    },
    lastAnalysisAt: time(a.last_analysis_date),
    firstSubmittedAt: time(a.first_submission_date),
    lastSubmittedAt: time(a.last_submission_date),
    timesSubmitted: num(a.times_submitted),
    reputation: num(a.reputation),
    threatLabel: str(threat.suggested_threat_label),
    threatCategories: ranked(threat.popular_threat_category),
    threatNames: ranked(threat.popular_threat_name),
    tags: strings(a.tags),
    votes: { harmless: count(votes.harmless), malicious: count(votes.malicious) },
    signature: Object.keys(signature).length ? { signers: str(signature.signers), verified: str(signature.verified) } : null,
    detections,
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
  return {
    async lookup(hash): Promise<VirustotalAnswer> {
      let res: Response;
      try {
        res = await fetchImpl(`${BASE_URL}/files/${encodeURIComponent(hash)}`, {
          headers: { "x-apikey": credentials.apiKey, accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        throw new VirustotalError(`VirusTotal couldn't be reached: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status === 404) return { found: false };
      if (res.status === 401 || res.status === 403) {
        const why = await reason(res);
        throw new VirustotalRefused(`VirusTotal refused your API key${why ? ` (${why})` : ""}`);
      }
      if (res.status === 429) throw new VirustotalQuotaExceeded("Your VirusTotal API key's lookup quota is used up for now");
      if (!res.ok) {
        const why = await reason(res);
        throw new VirustotalError(`VirusTotal lookup failed: ${res.status}${why ? ` ${why}` : ""}`);
      }
      return { found: true, report: readFile((await res.json()) as Record<string, unknown>) };
    },
  };
}
