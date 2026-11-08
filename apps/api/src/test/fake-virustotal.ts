import type { FileReport, VirustotalConnector } from "../virustotal/virustotal";
import { VirustotalQuotaExceeded, VirustotalRefused } from "../virustotal/virustotal";

/**
 * A fake VirusTotal for tests: knows the files in `files` (by any of their hashes), and makes up a
 * report for any other hash (knowing it only by that hash) unless it is in `unknown`. It records every lookup with the key it was
 * made with, and can refuse a key, run out of a key's quota, or be unreachable.
 */
export function fakeVirustotal() {
  const fake = {
    /** Every lookup, in order. */
    lookups: [] as { apiKey: string; hash: string }[],
    /** What it says about particular files, under the hash they are looked up by. */
    files: new Map<string, Partial<FileReport>>(),
    /** Hashes it has never seen. */
    unknown: new Set<string>(),
    /** Keys it refuses, as VirusTotal does wrong or revoked ones. */
    refused: new Set<string>(),
    /** Keys whose quota is used up. */
    exhausted: new Set<string>(),
    /** Set to make every lookup fail with this message, as when VirusTotal can't be reached. */
    unreachable: null as string | null,
  };

  const connect: VirustotalConnector = ({ apiKey }) => ({
    async lookup(hash) {
      fake.lookups.push({ apiKey, hash });
      if (fake.unreachable) throw new Error(fake.unreachable);
      if (fake.refused.has(apiKey)) throw new VirustotalRefused("VirusTotal refused your API key");
      if (fake.exhausted.has(apiKey)) throw new VirustotalQuotaExceeded("Your VirusTotal API key's lookup quota is used up for now");
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
  });

  return Object.assign(fake, { connect });
}
