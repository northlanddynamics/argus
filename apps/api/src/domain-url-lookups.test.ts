import { describe, expect, test } from "bun:test";
import { virustotalLookups } from "./db/schema";
import { DOMAIN_URL_LOOKUP_FRESH_MS, DOMAIN_URL_LOOKUP_NOT_FOUND_FRESH_MS } from "./virustotal/domain-url-lookups";
import { VIRUSTOTAL_CHECK_HASH } from "./virustotal/hash-lookups";
import { VIRUSTOTAL_RETRY_MS } from "./virustotal/member-keys";
import { readDomain, readUrl, urlIdentifier } from "./virustotal/virustotal-http";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const ANA_KEY = "ana-virustotal-key-0000000000000a1b2";
const COUNSEL = "kim@counsel.example";
const DOMAIN = "invoice-portal.biz";
const PHISH_URL = "https://invoice-portal.biz/login?next=%2Finvoice";

/** Acme Security: its Owner Olive (no VirusTotal key) and Ana, an Analyst with one. */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  expect((await ana.api["virustotal-key"].$put({ json: { apiKey: ANA_KEY } })).status).toBe(200);
  type Session = ReturnType<typeof t.session>;

  const domain = async (value: string, as: Session = ana) => {
    const res = await as.api["domain-lookups"].$get({ query: { domain: value } });
    const body = await res.json();
    return { status: res.status, lookup: "lookup" in body ? body.lookup : null };
  };
  const refreshDomain = async (value: string, as: Session = ana) => {
    const body = await (await as.api["domain-lookups"].refresh.$post({ json: { domain: value } })).json();
    return "lookup" in body ? body.lookup : null;
  };
  const url = async (value: string, as: Session = ana) => {
    const res = await as.api["url-lookups"].$get({ query: { url: value } });
    const body = await res.json();
    return { status: res.status, lookup: "lookup" in body ? body.lookup : null };
  };
  const refreshUrl = async (value: string, as: Session = ana) => {
    const body = await (await as.api["url-lookups"].refresh.$post({ json: { url: value } })).json();
    return "lookup" in body ? body.lookup : null;
  };
  return { t, owner, ana, domain, refreshDomain, url, refreshUrl };
}

describe("domain lookups", () => {
  test("a Member with a key looks a domain up: fetched once with their key, then served from the cache for a day", async () => {
    const a = await acme();
    a.t.virustotal.domains.set(DOMAIN, { registeredAt: "2025-12-20T00:00:00.000Z", categories: ["phishing"] });

    const first = await a.domain("Invoice-Portal[.]biz");
    expect(first.status).toBe(200);
    expect(first.lookup).toMatchObject({
      domain: DOMAIN,
      state: "found",
      hasKey: true,
      error: null,
      withheld: null,
      newlyRegistered: true,
      fetchedAt: a.t.clock.now().toISOString(),
      report: { domain: DOMAIN, registeredAt: "2025-12-20T00:00:00.000Z", categories: ["phishing"] },
    });
    expect(a.t.virustotal.domainLookups).toEqual([{ apiKey: ANA_KEY, domain: DOMAIN }]);

    a.t.clock.advance(DOMAIN_URL_LOOKUP_FRESH_MS - 1);
    expect((await a.domain(DOMAIN)).lookup).toMatchObject({ state: "found" });
    expect(a.t.virustotal.domainLookups).toHaveLength(1);
    // The fake's other domains were registered years ago.
    expect((await a.domain("old.example.com")).lookup).toMatchObject({ state: "found", newlyRegistered: false });
    a.t.virustotal.domainLookups.pop();

    a.t.clock.advance(1);
    await a.domain(DOMAIN);
    expect(a.t.virustotal.domainLookups).toHaveLength(2);
  });

  test("an email address is looked up by its domain alone: the mailbox name is never sent", async () => {
    const a = await acme();
    const got = await a.domain("billing.dept[@]invoice-portal[.]biz");
    expect(got.lookup).toMatchObject({ domain: DOMAIN, state: "found" });
    expect(a.t.virustotal.domainLookups).toEqual([{ apiKey: ANA_KEY, domain: DOMAIN }]);
    expect(JSON.stringify(a.t.virustotal)).not.toContain("billing.dept");
    // The address and the domain share one cached answer.
    await a.domain(DOMAIN);
    expect(a.t.virustotal.domainLookups).toHaveLength(1);
  });

  test("names only meaningful inside a network are never sent", async () => {
    const a = await acme();
    for (const name of ["fileserver.corp", "printer.local", "build.internal", "ops@acme.lan", "router.home.arpa"]) {
      const got = await a.domain(name);
      expect(got.status).toBe(200);
      expect(got.lookup).toMatchObject({ state: "withheld", report: null, hasKey: true });
      expect(got.lookup!.withheld).toContain("only meaningful inside a network");
    }
    expect(a.t.virustotal.domainLookups).toHaveLength(0);
  });

  test("a domain VirusTotal hasn't seen is believed for an hour", async () => {
    const a = await acme();
    a.t.virustotal.unknown.add(DOMAIN);
    expect((await a.domain(DOMAIN)).lookup).toMatchObject({ state: "not_found", report: null });
    a.t.clock.advance(DOMAIN_URL_LOOKUP_NOT_FOUND_FRESH_MS - 1);
    await a.domain(DOMAIN);
    expect(a.t.virustotal.domainLookups).toHaveLength(1);
    a.t.clock.advance(1);
    await a.domain(DOMAIN);
    expect(a.t.virustotal.domainLookups).toHaveLength(2);
  });

  test("the cache is the Organization's: a Member without a key reads what another's key fetched, but can't fetch", async () => {
    const a = await acme();
    expect((await a.domain(DOMAIN, a.owner)).lookup).toMatchObject({ state: "no_key", hasKey: false, report: null });
    await a.domain(DOMAIN);
    expect((await a.domain(DOMAIN, a.owner)).lookup).toMatchObject({ state: "found", hasKey: false });
    a.t.clock.advance(DOMAIN_URL_LOOKUP_FRESH_MS * 3);
    expect((await a.domain(DOMAIN, a.owner)).lookup).toMatchObject({ state: "found", hasKey: false });
    expect(await a.refreshDomain(DOMAIN, a.owner)).toMatchObject({ state: "found", hasKey: false });
    expect(a.t.virustotal.domainLookups).toHaveLength(1);

    await a.t.inviteOwner("Globex", "owner@globex.example");
    const globex = await a.t.acceptInvite("owner@globex.example", PASSWORD, "Gus Globex");
    expect((await a.domain(DOMAIN, globex)).lookup).toMatchObject({ state: "no_key" });
  });

  test("Refresh always fetches", async () => {
    const a = await acme();
    await a.domain(DOMAIN);
    a.t.virustotal.domains.set(DOMAIN, { categories: ["malware"] });
    expect(await a.refreshDomain(DOMAIN)).toMatchObject({ state: "found", report: { categories: ["malware"] } });
    expect(a.t.virustotal.domainLookups).toHaveLength(2);
  });

  test("a burst of lookups of one domain costs one call", async () => {
    const a = await acme();
    await Promise.all([a.domain(DOMAIN), a.domain(DOMAIN), a.domain("x@invoice-portal.biz")]);
    expect(a.t.virustotal.domainLookups).toHaveLength(1);
  });

  test("anything that isn't a domain or an email address is refused", async () => {
    const a = await acme();
    for (const value of ["not a domain", "198.51.100.7", "https://invoice-portal.biz/"]) {
      expect((await a.domain(value)).status as number).toBe(422);
    }
    expect(a.t.virustotal.domainLookups).toHaveLength(0);
  });
});

describe("URL lookups", () => {
  test("a URL is looked up as Argus normalises it, defanged or not, and cached for a day", async () => {
    const a = await acme();
    a.t.virustotal.urls.set(PHISH_URL, { title: "Sign in to your account", finalUrl: "https://invoice-portal.biz/m365/", stats: { malicious: 9, suspicious: 1, undetected: 50, harmless: 30, unsupported: 0, failed: 0 } });

    const got = await a.url("hxxps://invoice-portal[.]biz/login?next=%2Finvoice");
    expect(got.status).toBe(200);
    expect(got.lookup).toMatchObject({ url: PHISH_URL, state: "found", hasKey: true, report: { title: "Sign in to your account", finalUrl: "https://invoice-portal.biz/m365/", stats: { malicious: 9 } } });
    expect(a.t.virustotal.urlLookups).toEqual([{ apiKey: ANA_KEY, url: PHISH_URL }]);

    a.t.clock.advance(DOMAIN_URL_LOOKUP_FRESH_MS - 1);
    await a.url(PHISH_URL);
    expect(a.t.virustotal.urlLookups).toHaveLength(1);
    expect(await a.refreshUrl(PHISH_URL)).toMatchObject({ state: "found" });
    expect(a.t.virustotal.urlLookups).toHaveLength(2);

    // A domain and a URL with the same text are cached apart.
    expect(await a.t.deps.db.select().from(virustotalLookups)).toEqual([expect.objectContaining({ kind: "url", value: PHISH_URL })]);
  });

  test("URLs on internal names or reserved addresses, and URLs carrying a username or password, are never sent", async () => {
    const a = await acme();
    const reasons = {
      "http://10.0.0.5/admin": "Private addresses (10.0.0.0/8)",
      "http://[fe80::1]/": "Link-local addresses",
      "https://wiki.corp/page": ".corp names",
      "https://ana:hunter2@invoice-portal.biz/": "username or password",
    };
    for (const [value, reason] of Object.entries(reasons)) {
      const got = await a.url(value);
      expect(got.lookup).toMatchObject({ state: "withheld", report: null });
      expect(got.lookup!.withheld).toContain(reason);
    }
    expect(a.t.virustotal.urlLookups).toHaveLength(0);
    // A public address is fine.
    expect((await a.url("http://185.220.101.4/payload.bin")).lookup).toMatchObject({ state: "found" });
  });

  test("anything that isn't an http, https or ftp URL is refused", async () => {
    const a = await acme();
    for (const value of ["invoice-portal.biz", "javascript:alert(1)", "mailto:x@invoice-portal.biz"]) {
      expect((await a.url(value)).status as number).toBe(422);
    }
    expect(a.t.virustotal.urlLookups).toHaveLength(0);
  });
});

describe("failures", () => {
  test("a failed lookup keeps the cached report, records why on the key, and the key isn't tried again for a minute, whatever is looked up", async () => {
    const a = await acme();
    await a.domain(DOMAIN);
    a.t.clock.advance(DOMAIN_URL_LOOKUP_FRESH_MS);
    a.t.virustotal.exhausted.add(ANA_KEY);

    const failed = await a.domain(DOMAIN);
    expect(failed.lookup).toMatchObject({ state: "failed", error: "Your VirusTotal API key's lookup quota is used up for now", report: { domain: DOMAIN } });
    const key = await (await a.ana.api["virustotal-key"].$get()).json();
    expect(key).toMatchObject({ key: { error: "Your VirusTotal API key's lookup quota is used up for now" } });

    // Within the minute, neither another domain, a URL nor a hash costs a call.
    expect((await a.domain("other.example.com")).lookup).toMatchObject({ state: "failed", report: null });
    expect((await a.url(PHISH_URL)).lookup).toMatchObject({ state: "failed" });
    const sha = "a".repeat(64);
    expect(await (await a.ana.api["hash-lookups"].$get({ query: { hash: sha } })).json()).toMatchObject({ lookup: { state: "failed" } });
    expect(a.t.virustotal.domainLookups).toHaveLength(2);
    expect(a.t.virustotal.urlLookups).toHaveLength(0);
    expect(a.t.virustotal.lookups.filter((l) => l.hash !== VIRUSTOTAL_CHECK_HASH)).toHaveLength(0);

    // Refresh tries anyway; after the minute, so does a lookup.
    expect(await a.refreshUrl(PHISH_URL)).toMatchObject({ state: "failed" });
    expect(a.t.virustotal.urlLookups).toHaveLength(1);
    a.t.virustotal.exhausted.clear();
    a.t.clock.advance(VIRUSTOTAL_RETRY_MS);
    expect((await a.url(PHISH_URL)).lookup).toMatchObject({ state: "found", error: null });
    expect(await (await a.ana.api["virustotal-key"].$get()).json()).toMatchObject({ key: { error: null } });
  });

  test("Guests get no lookups", async () => {
    const a = await acme();
    const body = await (await a.ana.api.cases.$post({ json: { title: "Invoice phish", caseType: "phishing", severity: "high" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    await a.owner.api.cases[":number"].guests.$post({ param: { number: String(body.case.number) }, json: { email: COUNSEL, name: "Kim Patel", expiresAt: null } });
    const guest = await a.t.guestSignIn(COUNSEL);
    expect((await a.domain(DOMAIN, guest)).status as number).toBe(403);
    expect((await a.url(PHISH_URL, guest)).status as number).toBe(403);
    expect(a.t.virustotal.domainLookups).toHaveLength(0);
    expect(a.t.virustotal.urlLookups).toHaveLength(0);
  });
});

describe("VirusTotal v3 domain and URL objects", () => {
  test("a domain object is read into a DomainReport, leaving out what VirusTotal leaves out", () => {
    expect(
      readDomain({
        data: {
          id: "Invoice-Portal.biz",
          type: "domain",
          attributes: {
            last_analysis_stats: { malicious: 7, suspicious: 1, undetected: 25, harmless: 60, timeout: 0 },
            last_analysis_results: {
              Fortinet: { category: "malicious", engine_name: "Fortinet", result: "phishing" },
              BitDefender: { category: "malicious", engine_name: "BitDefender", result: "phishing" },
              Avira: { category: "harmless", engine_name: "Avira", result: "clean" },
            },
            categories: { "Forcepoint ThreatSeeker": "phishing and other frauds", Sophos: "Phishing", BitDefender: "phishing", Webroot: "Business" },
            creation_date: 1793952000,
            registrar: "NameCheap, Inc.",
            reputation: -21,
            total_votes: { harmless: 0, malicious: 4 },
            tags: ["dga"],
            last_dns_records: [
              { type: "NS", value: "dns1.registrar-servers.com", ttl: 1800 },
              { type: "A", value: "198.51.100.7", ttl: 300 },
              { type: "TXT", value: "v=spf1 -all", ttl: 300 },
              { type: "MX", value: "mail.invoice-portal.biz", ttl: 300, priority: 10 },
            ],
            last_https_certificate: {
              issuer: { O: "Let's Encrypt", CN: "R11", C: "US" },
              subject: { CN: "invoice-portal.biz" },
              validity: { not_before: "2026-11-03 10:00:00", not_after: "2027-02-01 10:00:00" },
            },
            popularity_ranks: { Tranco: { rank: 912345, timestamp: 1 }, "Cisco Umbrella": { rank: 40210, timestamp: 1 } },
            last_analysis_date: 1794000000,
          },
        },
      }),
    ).toEqual({
      domain: "invoice-portal.biz",
      stats: { malicious: 7, suspicious: 1, undetected: 25, harmless: 60, unsupported: 0, failed: 0 },
      detections: [
        { engine: "BitDefender", result: "phishing" },
        { engine: "Fortinet", result: "phishing" },
      ],
      categories: ["phishing", "business", "phishing and other frauds"],
      reputation: -21,
      votes: { harmless: 0, malicious: 4 },
      tags: ["dga"],
      registeredAt: new Date(1793952000 * 1000).toISOString(),
      registrar: "NameCheap, Inc.",
      dns: [
        { type: "A", value: "198.51.100.7" },
        { type: "MX", value: "mail.invoice-portal.biz" },
        { type: "NS", value: "dns1.registrar-servers.com" },
      ],
      certificate: { issuer: "Let's Encrypt", subject: "invoice-portal.biz", validFrom: "2026-11-03T10:00:00.000Z", validUntil: "2027-02-01T10:00:00.000Z" },
      popularity: [
        { list: "Cisco Umbrella", rank: 40210 },
        { list: "Tranco", rank: 912345 },
      ],
      lastAnalysisAt: new Date(1794000000 * 1000).toISOString(),
    });
    expect(readDomain({ data: { id: "x.example", attributes: {} } })).toMatchObject({ registeredAt: null, certificate: null, dns: [], categories: [], stats: { malicious: 0 } });
  });

  test("a URL object is read into a UrlReport", () => {
    expect(
      readUrl({
        data: {
          id: "b".repeat(64),
          type: "url",
          attributes: {
            url: PHISH_URL,
            last_final_url: "https://invoice-portal.biz/m365/",
            redirection_chain: [PHISH_URL, "https://invoice-portal.biz/m365"],
            title: "Sign in to your account",
            last_http_response_code: 200,
            last_analysis_stats: { malicious: 9, suspicious: 0, undetected: 50, harmless: 30, timeout: 0 },
            last_analysis_results: { Sophos: { category: "malicious", engine_name: "Sophos", result: "phishing" } },
            categories: { Sophos: "phishing" },
            threat_names: ["Mal/HTMLGen-A"],
            first_submission_date: 1793952000,
            times_submitted: 2,
          },
        },
      }),
    ).toMatchObject({
      id: "b".repeat(64),
      url: PHISH_URL,
      finalUrl: "https://invoice-portal.biz/m365/",
      redirects: [PHISH_URL, "https://invoice-portal.biz/m365"],
      title: "Sign in to your account",
      httpStatus: 200,
      detections: [{ engine: "Sophos", result: "phishing" }],
      categories: ["phishing"],
      threatNames: ["Mal/HTMLGen-A"],
      firstSubmittedAt: new Date(1793952000 * 1000).toISOString(),
      lastSubmittedAt: null,
      timesSubmitted: 2,
    });
    // The final URL is left out when it is the URL itself.
    expect(readUrl({ data: { attributes: { url: PHISH_URL, last_final_url: PHISH_URL } } })).toMatchObject({ finalUrl: null });
  });

  test("a URL's identifier is it in unpadded base64url", () => {
    expect(urlIdentifier("http://www.example.com/?a=1")).toBe("aHR0cDovL3d3dy5leGFtcGxlLmNvbS8_YT0x");
  });
});
