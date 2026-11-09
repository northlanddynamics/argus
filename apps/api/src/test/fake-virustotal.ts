import type { DomainReport, FileReport, UrlReport, VirustotalConnector } from "../virustotal/virustotal";
import { VirustotalQuotaExceeded, VirustotalRefused } from "../virustotal/virustotal";

/**
 * A fake VirusTotal for tests: knows the files in `files` (by any of their hashes), and makes up a
 * report for any other hash (knowing it only by that hash) unless it is in `unknown`; domains and
 * URLs likewise (`domains`, `urls`, never seen if in `unknown`). It records every lookup with the
 * key it was made with (files in `lookups`, domains in `domainLookups`, URLs in `urlLookups`), and
 * can refuse a key, run out of a key's quota, or be unreachable.
 */
export function fakeVirustotal() {
  const fake = {
    /** Every file lookup, in order. */
    lookups: [] as { apiKey: string; hash: string }[],
    /** Every domain lookup, in order. */
    domainLookups: [] as { apiKey: string; domain: string }[],
    /** Every URL lookup, in order. */
    urlLookups: [] as { apiKey: string; url: string }[],
    /** What it says about particular files, under the hash they are looked up by. */
    files: new Map<string, Partial<FileReport>>(),
    /** What it says about particular domains. */
    domains: new Map<string, Partial<DomainReport>>(),
    /** What it says about particular URLs. */
    urls: new Map<string, Partial<UrlReport>>(),
    /** Hashes, domains and URLs it has never seen. */
    unknown: new Set<string>(),
    /** Keys it refuses, as VirusTotal does wrong or revoked ones. */
    refused: new Set<string>(),
    /** Keys whose quota is used up. */
    exhausted: new Set<string>(),
    /** Set to make every lookup fail with this message, as when VirusTotal can't be reached. */
    unreachable: null as string | null,
  };

  const answerable = (apiKey: string) => {
    if (fake.unreachable) throw new Error(fake.unreachable);
    if (fake.refused.has(apiKey)) throw new VirustotalRefused("VirusTotal refused your API key");
    if (fake.exhausted.has(apiKey)) throw new VirustotalQuotaExceeded("Your VirusTotal API key's lookup quota is used up for now");
  };

  const stats = { malicious: 0, suspicious: 0, undetected: 30, harmless: 60, unsupported: 0, failed: 0 };

  const connect: VirustotalConnector = ({ apiKey }) => ({
    async lookup(hash) {
      fake.lookups.push({ apiKey, hash });
      answerable(apiKey);
      if (fake.unknown.has(hash)) return { found: false };
      const byLength = { 32: "md5", 40: "sha1", 64: "sha256" } as const;
      const type = byLength[hash.length as 32 | 40 | 64];
      return {
        found: true,
        report: {
          md5: null,
          sha1: null,
          sha256: null,
          name: "invoice_0423.exe",
          names: ["invoice.exe"],
          size: 68,
          typeDescription: "Win32 EXE",
          stats: { malicious: 61, suspicious: 0, undetected: 8, harmless: 0, unsupported: 3, failed: 0 },
          lastAnalysisAt: "2026-11-01T09:00:00.000Z",
          firstSubmittedAt: "2006-05-22T07:54:24.000Z",
          lastSubmittedAt: "2026-11-01T08:59:00.000Z",
          timesSubmitted: 1204,
          reputation: -12,
          threatLabel: "trojan.emotet/generic",
          threatCategories: ["trojan"],
          threatNames: ["emotet"],
          tags: ["peexe"],
          votes: { harmless: 1, malicious: 40 },
          signature: null,
          detections: [{ engine: "Kaspersky", result: "Trojan.Win32.Emotet.gen" }],
          ...(type && { [type]: hash }),
          ...fake.files.get(hash),
        },
      };
    },

    async lookupDomain(domain) {
      fake.domainLookups.push({ apiKey, domain });
      answerable(apiKey);
      if (fake.unknown.has(domain)) return { found: false };
      return {
        found: true,
        report: {
          domain,
          stats,
          detections: [],
          categories: ["business"],
          reputation: 0,
          votes: { harmless: 0, malicious: 0 },
          tags: [],
          registeredAt: "2009-03-14T00:00:00.000Z",
          registrar: "Example Registrar, Inc.",
          dns: [{ type: "A", value: "198.51.100.7" }],
          certificate: null,
          popularity: [],
          lastAnalysisAt: "2026-11-01T09:00:00.000Z",
          ...fake.domains.get(domain),
        },
      };
    },

    async lookupUrl(url) {
      fake.urlLookups.push({ apiKey, url });
      answerable(apiKey);
      if (fake.unknown.has(url)) return { found: false };
      return {
        found: true,
        report: {
          id: "f".repeat(64),
          url,
          finalUrl: null,
          redirects: [],
          title: null,
          httpStatus: 200,
          stats,
          detections: [],
          categories: [],
          threatNames: [],
          reputation: 0,
          votes: { harmless: 0, malicious: 0 },
          tags: [],
          firstSubmittedAt: "2026-10-30T12:00:00.000Z",
          lastSubmittedAt: "2026-11-01T08:59:00.000Z",
          timesSubmitted: 3,
          lastAnalysisAt: "2026-11-01T09:00:00.000Z",
          ...fake.urls.get(url),
        },
      };
    },
  });

  return Object.assign(fake, { connect });
}
