/**
 * VirusTotal as Argus uses it (ADR 0011, ADR 0012): an adapter, so lookups go to the real v3 API
 * (`virustotal-http.ts`) in production and to a fake in tests (`test/fake-virustotal.ts`).
 *
 * VirusTotal is not an Integration: each Member looks files, domains and URLs up with their own API
 * key, which only they can set, replace or remove. The answers are facts about a file, domain or
 * URL, so they are cached once per Organization (`hash-lookups.ts`, `domain-url-lookups.ts`) and
 * served to every Member, key or not.
 */

/** A Member's VirusTotal API key. */
export type VirustotalCredentials = { apiKey: string };

/** The hash types VirusTotal looks files up by: those of the hash Observable types. */
export const HASH_TYPES = ["md5", "sha1", "sha256"] as const;
export type HashType = (typeof HASH_TYPES)[number];

/** How many engines put the file in each category in its last analysis. */
export type AnalysisStats = {
  malicious: number;
  suspicious: number;
  undetected: number;
  harmless: number;
  /** Engines that can't analyse a file of its type. */
  unsupported: number;
  /** Engines that timed out or failed. */
  failed: number;
};

/** What VirusTotal reports about a file it has seen. Anything it leaves out is null or empty. */
export type FileReport = {
  md5: string | null;
  sha1: string | null;
  sha256: string | null;
  /** The name VirusTotal thinks most telling, of all it has been submitted under. */
  name: string | null;
  /** Other names it has been submitted under, at most ten. */
  names: string[];
  size: number | null;
  /** "Win32 EXE", "PDF", … */
  typeDescription: string | null;
  stats: AnalysisStats;
  lastAnalysisAt: string | null;
  firstSubmittedAt: string | null;
  lastSubmittedAt: string | null;
  timesSubmitted: number | null;
  /** VirusTotal's community reputation score: negative is bad. */
  reputation: number | null;
  /** The suggested threat label, such as "trojan.emotet/generic". */
  threatLabel: string | null;
  /** Popular threat categories, most-voted first: "trojan", "ransomware", … */
  threatCategories: string[];
  /** Popular threat family names, most-voted first. */
  threatNames: string[];
  tags: string[];
  votes: { harmless: number; malicious: number };
  /** Its code signature, when it carries one. */
  signature: { signers: string | null; verified: string | null } | null;
  /** The engines that call it malicious, with what each calls it, at most ten, by engine name. */
  detections: { engine: string; result: string }[];
};

/** VirusTotal's answer: the report, or that it has never seen the file. */
export type VirustotalAnswer = { found: true; report: FileReport } | { found: false };

/** VirusTotal refused the API key: it is wrong or has been revoked. */
export class VirustotalRefused extends Error {}

/** The key's quota (per minute, day or month) is used up for now. */
export class VirustotalQuotaExceeded extends Error {}

/** One engine that calls a file, domain or URL malicious, and what it calls it. */
export type Detection = { engine: string; result: string };

/**
 * What VirusTotal reports about a domain it has seen (ADR 0012). Anything it leaves out is null or
 * empty. Registration comes from the WHOIS VirusTotal last read; DNS and the certificate from its
 * last resolution and HTTPS connection.
 */
export type DomainReport = {
  domain: string;
  stats: AnalysisStats;
  /** At most ten, by engine name. */
  detections: Detection[];
  /** What the URL-categorisation vendors call it, most-agreed first, each once: "phishing", "business". */
  categories: string[];
  reputation: number | null;
  votes: { harmless: number; malicious: number };
  tags: string[];
  /** When the domain was registered, by WHOIS. */
  registeredAt: string | null;
  registrar: string | null;
  /** Its A, AAAA, CNAME, MX and NS records when VirusTotal last resolved it, at most ten. */
  dns: { type: string; value: string }[];
  /** The HTTPS certificate it last served. */
  certificate: { issuer: string | null; subject: string | null; validFrom: string | null; validUntil: string | null } | null;
  /** Its rank in popularity lists (Tranco, Cisco Umbrella, …), best first: a low rank means much visited. */
  popularity: { list: string; rank: number }[];
  lastAnalysisAt: string | null;
};

/** What VirusTotal reports about a URL it has seen (ADR 0012). Anything it leaves out is null or empty. */
export type UrlReport = {
  /** VirusTotal's identifier for the URL (the SHA-256 of it as VirusTotal canonicalises it), for its page. */
  id: string | null;
  /** The URL as VirusTotal holds it. */
  url: string | null;
  /** Where it ended up, after redirects, when that is somewhere else. */
  finalUrl: string | null;
  /** The redirects VirusTotal followed, in order, at most ten. */
  redirects: string[];
  /** The page's title. */
  title: string | null;
  /** The HTTP status of the last response. */
  httpStatus: number | null;
  stats: AnalysisStats;
  /** At most ten, by engine name. */
  detections: Detection[];
  /** What the URL-categorisation vendors call it, most-agreed first, each once. */
  categories: string[];
  threatNames: string[];
  reputation: number | null;
  votes: { harmless: number; malicious: number };
  tags: string[];
  firstSubmittedAt: string | null;
  lastSubmittedAt: string | null;
  timesSubmitted: number | null;
  lastAnalysisAt: string | null;
};

export type DomainAnswer = { found: true; report: DomainReport } | { found: false };
export type UrlAnswer = { found: true; report: UrlReport } | { found: false };

export interface VirustotalClient {
  /**
   * What VirusTotal knows about the file `hash` (lowercase hex) identifies. Rejects with
   * `VirustotalRefused`, `VirustotalQuotaExceeded`, or another error when VirusTotal can't be
   * reached or fails. So do the others.
   */
  lookup(hash: string): Promise<VirustotalAnswer>;
  /** What VirusTotal knows about `domain`, a public name in lowercase ASCII. */
  lookupDomain(domain: string): Promise<DomainAnswer>;
  /**
   * What VirusTotal knows about `url`, as Argus normalises it. Only looks it up: never submits it
   * for scanning, so VirusTotal never visits it on Argus's behalf.
   */
  lookupUrl(url: string): Promise<UrlAnswer>;
}

/** Makes the client for one Member's key. */
export type VirustotalConnector = (credentials: VirustotalCredentials) => VirustotalClient;

/** The type of hash `hash` (lowercase hex) is, by its length. */
export const hashTypeOf = (hash: string): HashType | null =>
  /^[0-9a-f]+$/.test(hash) ? (({ 32: "md5", 40: "sha1", 64: "sha256" }) as Record<number, HashType>)[hash.length] ?? null : null;

/** "34 of 72": how many engines that analysed the file call it malicious, out of those that could. */
export const enginesThatAnalysed = (s: AnalysisStats) => s.malicious + s.suspicious + s.undetected + s.harmless;

/** How long ago a domain registered counts as newly registered: phishing domains are usually days old. */
export const NEWLY_REGISTERED_MS = 30 * 24 * 60 * 60_000;

/**
 * The special-use and private-use top-level names (RFC 6761, 6762, 7686, 8375, 9476 and ICANN's
 * `.internal`), and those networks commonly use internally, which no public resolver answers.
 */
const PRIVATE_TLDS = new Set(["test", "example", "invalid", "localhost", "local", "onion", "alt", "internal", "arpa", "lan", "home", "corp", "intranet", "private", "localdomain"]);

/**
 * Why `domain` (lowercase ASCII) is not looked up on VirusTotal, or null when it may be: a name only
 * meaningful inside a network says nothing to VirusTotal, and sending it describes that network.
 */
export function withheldDomain(domain: string): string | null {
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return PRIVATE_TLDS.has(tld) ? `.${tld} names are only meaningful inside a network, so they aren't sent to VirusTotal` : null;
}
