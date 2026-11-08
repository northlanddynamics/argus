import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { virustotalKeys } from "./db/schema";
import { HASH_LOOKUP_FRESH_MS, HASH_LOOKUP_NOT_FOUND_FRESH_MS, HASH_LOOKUP_RETRY_MS, VIRUSTOTAL_CHECK_HASH } from "./virustotal/hash-lookups";
import { readFile } from "./virustotal/virustotal-http";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const ANA_KEY = "ana-virustotal-key-0000000000000a1b2";
const OLIVE_KEY = "olive-virustotal-key-000000000000c3d4";
const COUNSEL = "kim@counsel.example";
const SHA256 = "a3f5c8e1d2b4a6f8e0c2d4b6a8f0e2c4d6b8a0f2e4c6d8b0a2f4e6c8d0b2a4f6";
const MD5 = "9e107d9d372bb6826bd81d3542a419d6";
const SHA1 = "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12";

/** Acme Security: its Owner Olive and Ana (an Analyst), neither with a VirusTotal key yet. */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Session = ReturnType<typeof t.session>;

  const setKey = async (apiKey: string, as: Session = ana) => {
    const res = await as.api["virustotal-key"].$put({ json: { apiKey } });
    const body = await res.json();
    return { status: res.status, body: body as Record<string, unknown> };
  };
  const key = async (as: Session = ana) => {
    const body = await (await as.api["virustotal-key"].$get()).json();
    if (!("key" in body)) throw new Error("Could not read the key");
    return body.key;
  };
  const lookup = async (hash: string, as: Session = ana) => {
    const res = await as.api["hash-lookups"].$get({ query: { hash } });
    const body = await res.json();
    return { status: res.status, lookup: "lookup" in body ? body.lookup : null };
  };
  const refresh = async (hash: string, as: Session = ana) => {
    const res = await as.api["hash-lookups"].refresh.$post({ json: { hash } });
    const body = await res.json();
    return { status: res.status, lookup: "lookup" in body ? body.lookup : null };
  };
  /** Lookups other than the check made when a key is set. */
  const lookups = () => t.virustotal.lookups.filter((l) => l.hash !== VIRUSTOTAL_CHECK_HASH);
  return { t, owner, ana, setKey, key, lookup, refresh, lookups };
}

describe("a Member's VirusTotal key", () => {
  test("each Member sets their own; it is checked first, and only its last four characters are ever shown", async () => {
    const a = await acme();
    expect(await a.key()).toBeNull();
    const set = await a.setKey(ANA_KEY);
    expect(set.status).toBe(200);
    expect(a.t.virustotal.lookups).toEqual([{ apiKey: ANA_KEY, hash: VIRUSTOTAL_CHECK_HASH }]);
    expect(await a.key()).toMatchObject({ hint: "…a1b2", error: null, lastUsedAt: a.t.clock.now().toISOString() });
    expect(JSON.stringify(await a.key())).not.toContain(ANA_KEY);

    // It is Ana's alone: the Owner has none.
    expect(await a.key(a.owner)).toBeNull();
    const [row] = await a.t.deps.db.select().from(virustotalKeys);
    expect(row!.key).not.toContain(ANA_KEY);
  });

  test("a key VirusTotal refuses is not saved", async () => {
    const a = await acme();
    a.t.virustotal.refused.add(ANA_KEY);
    const set = await a.setKey(ANA_KEY);
    expect(set.status).toBe(422);
    expect(set.body.error).toBe("VirusTotal refused your API key");
    expect(await a.key()).toBeNull();
  });

  test("a key whose quota is used up, or that couldn't be checked, is saved and says so", async () => {
    const a = await acme();
    a.t.virustotal.exhausted.add(ANA_KEY);
    expect((await a.setKey(ANA_KEY)).status).toBe(200);
    expect(await a.key()).toMatchObject({ hint: "…a1b2", error: "Your VirusTotal API key's lookup quota is used up for now", lastUsedAt: null });
  });

  test("it is replaced and removed by its Member", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    await a.setKey("ana-replacement-key-00000000000000e5f6");
    expect(await a.key()).toMatchObject({ hint: "…e5f6" });
    expect(await a.t.deps.db.select().from(virustotalKeys)).toHaveLength(1);
    expect((await a.ana.api["virustotal-key"].$delete()).status).toBe(200);
    expect(await a.key()).toBeNull();
    expect((await a.ana.api["virustotal-key"].$delete()).status as number).toBe(404);
  });

  test("too short a key is refused before VirusTotal is asked", async () => {
    const a = await acme();
    expect((await a.setKey("short")).status).toBe(400);
    expect(a.t.virustotal.lookups).toHaveLength(0);
  });

  test("it goes when its Member leaves the Organization", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    const members = await (await a.owner.api.organization.members.$get()).json();
    if (!("members" in members)) throw new Error("Could not list Members");
    const id = members.members.find((m) => m.email === "ana@acme.example")!.id;
    await a.owner.api.organization.members[":id"].$delete({ param: { id } });
    expect(await a.t.deps.db.select().from(virustotalKeys)).toHaveLength(0);
  });

  test("Guests have none", async () => {
    const a = await acme();
    const body = await (await a.ana.api.cases.$post({ json: { title: "Invoice malware", caseType: "malware", severity: "high" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    await a.owner.api.cases[":number"].guests.$post({ param: { number: String(body.case.number) }, json: { email: COUNSEL, name: "Kim Patel", expiresAt: null } });
    const guest = await a.t.guestSignIn(COUNSEL);
    expect((await guest.api["virustotal-key"].$put({ json: { apiKey: ANA_KEY } })).status as number).toBe(403);
    expect((await a.lookup(SHA256, guest)).status as number).toBe(403);
    expect(a.t.virustotal.lookups).toHaveLength(0);
  });
});

describe("hash lookups", () => {
  test("a Member with a key looks a file up: fetched once with their key, then served from the cache for a day", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    a.t.virustotal.files.set(SHA256, { md5: MD5, sha1: SHA1, name: "invoice_0423.exe" });

    const first = await a.lookup(SHA256.toUpperCase());
    expect(first.status).toBe(200);
    expect(first.lookup).toMatchObject({
      hash: SHA256,
      hashType: "sha256",
      state: "found",
      error: null,
      hasKey: true,
      fetchedAt: a.t.clock.now().toISOString(),
      report: { sha256: SHA256, md5: MD5, name: "invoice_0423.exe", threatLabel: "trojan.emotet/generic", stats: { malicious: 61 } },
    });
    expect(a.lookups()).toEqual([{ apiKey: ANA_KEY, hash: SHA256 }]);

    a.t.clock.advance(HASH_LOOKUP_FRESH_MS - 1);
    expect((await a.lookup(SHA256)).lookup).toMatchObject({ state: "found", fetchedAt: first.lookup!.fetchedAt });
    expect(a.lookups()).toHaveLength(1);

    a.t.clock.advance(2);
    expect((await a.lookup(SHA256)).lookup).toMatchObject({ state: "found", fetchedAt: a.t.clock.now().toISOString() });
    expect(a.lookups()).toHaveLength(2);
  });

  test("the report is cached under each of the file's hashes", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    a.t.virustotal.files.set(SHA256, { md5: MD5, sha1: SHA1 });
    await a.lookup(SHA256);
    expect((await a.lookup(MD5)).lookup).toMatchObject({ hash: MD5, hashType: "md5", state: "found", report: { sha256: SHA256 } });
    expect((await a.lookup(SHA1)).lookup).toMatchObject({ hashType: "sha1", state: "found" });
    expect(a.lookups()).toHaveLength(1);
  });

  test("the cache is the Organization's: a Member without a key reads what another's key fetched, but can't fetch", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    await a.lookup(SHA256);
    expect((await a.lookup(SHA256, a.owner)).lookup).toMatchObject({ state: "found", hasKey: false });

    // Stale, it is still shown to the Owner, who can't refresh it.
    a.t.clock.advance(HASH_LOOKUP_FRESH_MS * 2);
    expect((await a.refresh(SHA256, a.owner)).lookup).toMatchObject({ state: "found", hasKey: false });
    // Never looked up, there is nothing to show.
    expect((await a.lookup(MD5, a.owner)).lookup).toMatchObject({ state: "no_key", report: null, fetchedAt: null, hasKey: false });
    expect(a.lookups()).toHaveLength(1);

    // With a key of her own, the Owner's lookups use it, never Ana's.
    await a.setKey(OLIVE_KEY, a.owner);
    await a.lookup(MD5, a.owner);
    expect(a.lookups().at(-1)).toEqual({ apiKey: OLIVE_KEY, hash: MD5 });
  });

  test("a file VirusTotal hasn't seen is believed for an hour", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    a.t.virustotal.unknown.add(MD5);
    expect((await a.lookup(MD5)).lookup).toMatchObject({ state: "not_found", report: null, fetchedAt: a.t.clock.now().toISOString() });
    await a.lookup(MD5);
    expect(a.lookups()).toHaveLength(1);
    a.t.virustotal.unknown.delete(MD5);
    a.t.clock.advance(HASH_LOOKUP_NOT_FOUND_FRESH_MS);
    expect((await a.lookup(MD5)).lookup).toMatchObject({ state: "found" });
  });

  test("Refresh always fetches", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    await a.lookup(SHA256);
    a.t.virustotal.files.set(SHA256, { threatLabel: "ransomware.lockbit/generic" });
    a.t.clock.advance(1000);
    expect((await a.refresh(SHA256)).lookup).toMatchObject({ state: "found", report: { threatLabel: "ransomware.lockbit/generic" } });
    expect(a.lookups()).toHaveLength(2);
  });

  test("a failed lookup keeps the cached report, records why on the key, and isn't retried for a minute", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    await a.lookup(SHA256);
    a.t.clock.advance(HASH_LOOKUP_FRESH_MS + 1);
    a.t.virustotal.exhausted.add(ANA_KEY);

    const failed = await a.lookup(SHA256);
    expect(failed.lookup).toMatchObject({ state: "failed", error: "Your VirusTotal API key's lookup quota is used up for now", report: { stats: { malicious: 61 } } });
    expect(await a.key()).toMatchObject({ error: "Your VirusTotal API key's lookup quota is used up for now" });

    // Hovering again, even another hash, doesn't spend a call.
    await a.lookup(SHA256);
    expect((await a.lookup(MD5)).lookup).toMatchObject({ state: "failed", report: null });
    expect(a.lookups()).toHaveLength(2);

    // Another Member's lookups are unaffected.
    await a.setKey(OLIVE_KEY, a.owner);
    expect((await a.lookup(MD5, a.owner)).lookup).toMatchObject({ state: "found" });

    a.t.virustotal.exhausted.delete(ANA_KEY);
    a.t.clock.advance(HASH_LOOKUP_RETRY_MS);
    expect((await a.lookup(SHA1)).lookup).toMatchObject({ state: "found", error: null });
    expect(await a.key()).toMatchObject({ error: null });
  });

  test("a refused key says so, until it is replaced", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    a.t.virustotal.refused.add(ANA_KEY);
    expect((await a.lookup(SHA256)).lookup).toMatchObject({ state: "failed", error: "VirusTotal refused your API key", report: null });
    await a.setKey("ana-replacement-key-00000000000000e5f6");
    expect((await a.lookup(SHA256)).lookup).toMatchObject({ state: "found" });
  });

  test("a burst of lookups of one hash costs one call", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    await Promise.all([a.lookup(SHA256), a.lookup(SHA256), a.lookup(SHA256)]);
    expect(a.lookups()).toHaveLength(1);
  });

  test("anything that isn't an MD5, SHA-1 or SHA-256 is refused", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    expect((await a.lookup("185.220.101.4")).status).toBe(422);
    expect((await a.lookup("abc123")).status).toBe(422);
    expect((await a.lookup(`${SHA256.slice(0, 63)}z`)).status).toBe(422);
    expect(a.lookups()).toHaveLength(0);
  });

  test("each Organization keeps its own cache", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    await a.lookup(SHA256);
    await a.t.inviteOwner("Globex", "owner@globex.example");
    const globex = await a.t.acceptInvite("owner@globex.example", PASSWORD, "Gus Globex");
    expect((await a.lookup(SHA256, globex)).lookup).toMatchObject({ state: "no_key" });
  });

  test("Removing a key leaves what it looked up cached", async () => {
    const a = await acme();
    await a.setKey(ANA_KEY);
    await a.lookup(SHA256);
    await a.ana.api["virustotal-key"].$delete();
    expect((await a.lookup(SHA256)).lookup).toMatchObject({ state: "found", hasKey: false });
    const [row] = await a.t.deps.db.select().from(virustotalKeys).where(eq(virustotalKeys.hint, "…a1b2"));
    expect(row).toBeUndefined();
  });
});

describe("VirusTotal v3 file objects", () => {
  test("are read into a FileReport, leaving out what VirusTotal leaves out", () => {
    expect(
      readFile({
        data: {
          id: SHA256,
          type: "file",
          attributes: {
            md5: MD5.toUpperCase(),
            sha1: SHA1,
            sha256: SHA256,
            meaningful_name: "invoice_0423.exe",
            names: ["invoice_0423.exe", "a.exe", "b.exe"],
            size: 482304,
            type_description: "Win32 EXE",
            last_analysis_date: 1793520000,
            first_submission_date: 1793433600,
            times_submitted: 3,
            reputation: -5,
            tags: ["peexe", "signed"],
            last_analysis_stats: { malicious: 2, suspicious: 1, undetected: 60, harmless: 0, "type-unsupported": 4, timeout: 1, failure: 1 },
            last_analysis_results: {
              Zillya: { category: "malicious", engine_name: "Zillya", result: "Trojan.Agent" },
              Avast: { category: "malicious", engine_name: "Avast", result: "Win32:Malware-gen" },
              Bkav: { category: "undetected", engine_name: "Bkav", result: null },
            },
            popular_threat_classification: {
              suggested_threat_label: "trojan.agent/malware",
              popular_threat_category: [
                { value: "downloader", count: 2 },
                { value: "trojan", count: 9 },
              ],
              popular_threat_name: [{ value: "agent", count: 4 }],
            },
            total_votes: { harmless: 0, malicious: 3 },
            signature_info: { signers: "Fake Corp; DigiCert", verified: "A certificate was explicitly revoked by its issuer." },
          },
        },
      }),
    ).toEqual({
      md5: MD5,
      sha1: SHA1,
      sha256: SHA256,
      name: "invoice_0423.exe",
      names: ["a.exe", "b.exe"],
      size: 482304,
      typeDescription: "Win32 EXE",
      stats: { malicious: 2, suspicious: 1, undetected: 60, harmless: 0, unsupported: 4, failed: 2 },
      lastAnalysisAt: new Date(1793520000 * 1000).toISOString(),
      firstSubmittedAt: new Date(1793433600 * 1000).toISOString(),
      lastSubmittedAt: null,
      timesSubmitted: 3,
      reputation: -5,
      threatLabel: "trojan.agent/malware",
      threatCategories: ["trojan", "downloader"],
      threatNames: ["agent"],
      tags: ["peexe", "signed"],
      votes: { harmless: 0, malicious: 3 },
      signature: { signers: "Fake Corp; DigiCert", verified: "A certificate was explicitly revoked by its issuer." },
      detections: [
        { engine: "Avast", result: "Win32:Malware-gen" },
        { engine: "Zillya", result: "Trojan.Agent" },
      ],
    });
    expect(readFile({ data: { attributes: {} } })).toMatchObject({ md5: null, names: [], signature: null, detections: [], stats: { malicious: 0 } });
  });
});
