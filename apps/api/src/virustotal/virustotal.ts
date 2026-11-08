/**
 * VirusTotal as Argus uses it (ADR 0011): an adapter, so lookups go to the real v3 API
 * (`virustotal-http.ts`) in production and to a fake in tests (`test/fake-virustotal.ts`).
 *
 * VirusTotal is not an Integration: each Member looks hashes up with their own API key, which only
 * they can set, replace or remove. The answers are facts about a file, so they are cached once per
 * Organization in `hash_lookups` (`hash-lookups.ts`) and served to every Member, key or not.
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

export interface VirustotalClient {
  /**
   * What VirusTotal knows about the file `hash` (lowercase hex) identifies. Rejects with
   * `VirustotalRefused`, `VirustotalQuotaExceeded`, or another error when VirusTotal can't be
   * reached or fails.
   */
  lookup(hash: string): Promise<VirustotalAnswer>;
}

/** Makes the client for one Member's key. */
export type VirustotalConnector = (credentials: VirustotalCredentials) => VirustotalClient;

/** The type of hash `hash` (lowercase hex) is, by its length. */
export const hashTypeOf = (hash: string): HashType | null =>
  /^[0-9a-f]+$/.test(hash) ? (({ 32: "md5", 40: "sha1", 64: "sha256" }) as Record<number, HashType>)[hash.length] ?? null : null;

/** "34 of 72": how many engines that analysed the file call it malicious, out of those that could. */
export const enginesThatAnalysed = (s: AnalysisStats) => s.malicious + s.suspicious + s.undetected + s.harmless;
