import { describe, expect, test } from "bun:test";
import { IPINFO_RECHECK_MS, createIpinfoHealthChecker } from "./ipinfo/health";
import { IP_LOOKUP_FRESH_MS, IP_LOOKUP_RETRY_MS } from "./ipinfo/ip-lookups";
import { EMPTY_IP_DETAILS, reservedRange } from "./ipinfo/ipinfo";
import { readLookup } from "./ipinfo/ipinfo-http";
import { eq } from "drizzle-orm";
import { integrations, ipLookups } from "./db/schema";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const TOKEN = "ipinfo-token-7f3a";
const COUNSEL = "kim@counsel.example";
const param = (number: number) => ({ number: String(number) });

/** Acme Security: its Owner and Ana (an Analyst), with no IPinfo Integration yet. */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Session = ReturnType<typeof t.session>;

  const addIpinfo = async (json: Record<string, unknown> = {}, as: Session = owner) => {
    const res = await as.api.integrations.$post({ json: { provider: "ipinfo", name: "IPinfo", token: TOKEN, ...json } as never });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { integration?: { id: string } } };
  };
  const integration = async () => {
    const body = await (await owner.api.integrations.$get()).json();
    if (!("integrations" in body)) throw new Error("Could not list Integrations");
    return body.integrations.find((i) => i.provider === "ipinfo")!;
  };
  const orgAudit = async () => {
    const body = await (await owner.api.organization["audit-log"].$get({ query: { category: "integrations" } })).json();
    if (!("entries" in body)) throw new Error("Could not read the Organization Audit Log");
    return body.entries;
  };
  const lookup = async (ip: string, as: Session = ana) => {
    const res = await as.api["ip-lookups"].$get({ query: { ip } });
    const body = await res.json();
    return { status: res.status, lookup: "lookup" in body ? body.lookup : null };
  };
  const refresh = async (ip: string, as: Session = ana) => {
    const res = await as.api["ip-lookups"].refresh.$post({ json: { ip } });
    const body = await res.json();
    return { status: res.status, lookup: "lookup" in body ? body.lookup : null };
  };
  const health = createIpinfoHealthChecker(t.deps, { connect: t.ipinfo.connect });
  return { t, owner, ana, addIpinfo, integration, orgAudit, lookup, refresh, health };
}

describe("IPinfo Integration", () => {
  test("an Admin adds one with an API token; it only looks IPs up, and its token is never shown", async () => {
    const a = await acme();
    expect((await a.addIpinfo({}, a.ana)).status).toBe(403);
    expect((await a.addIpinfo()).status).toBe(201);
    const i = await a.integration();
    expect(i).toMatchObject({
      provider: "ipinfo",
      name: "IPinfo",
      cloud: null,
      writeBack: false,
      responseActions: false,
      health: "connecting",
      capabilities: { receivesAlerts: false, writesBack: false, responseActions: false, looksUpIps: true },
      credentials: { clientIdHint: "…7f3a" },
    });
    expect(JSON.stringify(i)).not.toContain(TOKEN);
    expect((await a.orgAudit()).find((e) => e.target === "IPinfo")).toMatchObject({ action: "integration.created", after: "IPinfo · token …7f3a" });

    // No cloud, client credentials, Response Actions or write-back.
    expect((await a.addIpinfo({ name: "IPinfo 2", cloud: "us-1" })).status).toBe(400);
    expect((await a.addIpinfo({ name: "IPinfo 3", responseActions: true })).status).toBe(400);
    const put = await a.owner.api.integrations[":id"]["response-actions"].$put({ param: { id: i.id }, json: { enabled: true } });
    expect(put.status).toBe(422);

    // One per Organization.
    const second = await a.addIpinfo({ name: "IPinfo again", token: "another-token-0000" });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("already has an IPinfo Integration");
  });

  test("its token is rotated with a token, not client credentials, and checked afresh", async () => {
    const a = await acme();
    const id = (await a.addIpinfo()).body.integration!.id;
    await a.health.tick();
    expect(await a.integration()).toMatchObject({ health: "connected" });

    const wrong = await a.owner.api.integrations[":id"].credentials.$put({ param: { id }, json: { clientId: "x", clientSecret: "y" } });
    expect(wrong.status).toBe(422);
    const res = await a.owner.api.integrations[":id"].credentials.$put({ param: { id }, json: { token: "rotated-token-9b2c" } });
    expect(res.status).toBe(200);
    expect(await a.integration()).toMatchObject({ health: "connecting", credentials: { clientIdHint: "…9b2c" } });
    expect((await a.orgAudit()).find((e) => e.action === "integration.credentials_rotated")).toMatchObject({ before: "token …7f3a", after: "token …9b2c" });

    await a.health.tick();
    expect(a.t.ipinfo.lookups.at(-1)).toEqual({ token: "rotated-token-9b2c", ip: "8.8.8.8" });
    expect(await a.integration()).toMatchObject({ health: "connected" });
  });

  test("the health check is made once when added, not on a schedule, and a refused token shows as an error", async () => {
    const a = await acme();
    a.t.ipinfo.refused.add(TOKEN);
    await a.addIpinfo();
    await a.health.tick();
    expect(await a.integration()).toMatchObject({ health: "error", healthDetail: "IPinfo refused the API token" });
    a.t.clock.advance(IPINFO_RECHECK_MS * 100);
    await a.health.tick();
    expect(a.t.ipinfo.lookups).toHaveLength(1);
  });

  test("an unreachable IPinfo is checked again a minute later", async () => {
    const a = await acme();
    a.t.ipinfo.unreachable = "connect ECONNREFUSED";
    await a.addIpinfo();
    await a.health.tick();
    expect(await a.integration()).toMatchObject({ health: "disconnected" });
    a.t.ipinfo.unreachable = null;
    await a.health.tick();
    expect(a.t.ipinfo.lookups).toHaveLength(1);
    a.t.clock.advance(IPINFO_RECHECK_MS + 1);
    await a.health.tick();
    expect(await a.integration()).toMatchObject({ health: "connected" });
  });
});

describe("Deleting the IPinfo Integration", () => {
  test("IPs are no longer looked up, and another IPinfo Integration can be added in its place", async () => {
    const a = await acme();
    const id = (await a.addIpinfo()).body.integration!.id;
    expect((await a.owner.api.integrations[":id"].$delete({ param: { id } })).status).toBe(200);
    expect((await a.lookup("185.220.101.4")).lookup).toMatchObject({ state: "unconfigured" });
    expect(a.t.ipinfo.lookups).toEqual([]);

    const replacement = await a.addIpinfo({ token: "another-token-0000" });
    expect(replacement.status).toBe(201);
    await a.health.tick();
    expect(a.t.ipinfo.lookups).toEqual([{ token: "another-token-0000", ip: "8.8.8.8" }]);
  });
});

describe("IP lookups", () => {
  test("a Member looks up any IP: fetched from IPinfo once, then served from the cache until it is a week old", async () => {
    const a = await acme();
    await a.addIpinfo();
    a.t.ipinfo.details.set("185.220.101.4", { hostname: "tor-exit.example.net", anonymous: true });

    const first = await a.lookup("185.220.101[.]4");
    expect(first.status).toBe(200);
    expect(first.lookup).toMatchObject({
      ip: "185.220.101.4",
      state: "found",
      reserved: null,
      error: null,
      fetchedAt: a.t.clock.now().toISOString(),
      details: { hostname: "tor-exit.example.net", country: "Germany", countryCode: "DE", asn: "AS60729", asType: "hosting", anonymous: true, hosting: true },
    });
    expect(a.t.ipinfo.lookups).toEqual([{ token: TOKEN, ip: "185.220.101.4" }]);
    // A lookup also says the token works.
    expect(await a.integration()).toMatchObject({ health: "connected" });

    // Anyone in the Organization reads the same cached answer.
    a.t.clock.advance(IP_LOOKUP_FRESH_MS - 1);
    expect((await a.lookup("185.220.101.4", a.owner)).lookup).toMatchObject({ state: "found", fetchedAt: first.lookup!.fetchedAt });
    expect(a.t.ipinfo.lookups).toHaveLength(1);

    // Stale, it is fetched again.
    a.t.clock.advance(2);
    expect((await a.lookup("185.220.101.4")).lookup).toMatchObject({ state: "found", fetchedAt: a.t.clock.now().toISOString() });
    expect(a.t.ipinfo.lookups).toHaveLength(2);
  });

  test("Refresh always fetches", async () => {
    const a = await acme();
    await a.addIpinfo();
    await a.lookup("8.8.4.4");
    a.t.ipinfo.details.set("8.8.4.4", { city: "Mountain View" });
    a.t.clock.advance(1000);
    const { lookup } = await a.refresh("8.8.4.4");
    expect(lookup).toMatchObject({ state: "found", details: { city: "Mountain View" }, fetchedAt: a.t.clock.now().toISOString() });
    expect(a.t.ipinfo.lookups).toHaveLength(2);
  });

  test("details cached from IPinfo Core are fetched again for the Plus fields, however fresh", async () => {
    const a = await acme();
    await a.addIpinfo();
    await a.lookup("8.8.4.4");
    // As Argus cached it before it used Plus: no VPN, Tor, carrier or accuracy fields.
    const [row] = await a.t.deps.db.select().from(ipLookups).where(eq(ipLookups.ip, "8.8.4.4"));
    const { vpn: _vpn, proxy: _proxy, tor: _tor, relay: _relay, anonymousService: _service, carrier: _carrier, mcc: _mcc, mnc: _mnc, ...core } = row!.details!;
    await a.t.deps.db.update(ipLookups).set({ details: core as NonNullable<typeof row>["details"] }).where(eq(ipLookups.id, row!.id));

    a.t.ipinfo.details.set("8.8.4.4", { vpn: true, anonymous: true, anonymousService: "ExampleVPN" });
    a.t.clock.advance(1000);
    expect((await a.lookup("8.8.4.4")).lookup).toMatchObject({ state: "found", details: { vpn: true, anonymousService: "ExampleVPN" } });
    expect(a.t.ipinfo.lookups).toHaveLength(2);
  });

  test("a Core-era answer served while paused has every Plus field, empty", async () => {
    const a = await acme();
    const { body } = await a.addIpinfo();
    await a.lookup("8.8.4.4");
    const [row] = await a.t.deps.db.select().from(ipLookups).where(eq(ipLookups.ip, "8.8.4.4"));
    const { vpn: _vpn, carrier: _carrier, accuracyRadius: _radius, ...core } = row!.details!;
    await a.t.deps.db.update(ipLookups).set({ details: core as NonNullable<typeof row>["details"] }).where(eq(ipLookups.id, row!.id));
    await a.t.deps.db.update(integrations).set({ paused: true }).where(eq(integrations.id, body.integration!.id));

    const { lookup } = await a.lookup("8.8.4.4");
    expect(lookup).toMatchObject({ state: "paused", details: { city: "Frankfurt am Main", vpn: false, carrier: null, accuracyRadius: null } });
    expect(a.t.ipinfo.lookups).toHaveLength(1);
  });

  test("IPv6 is looked up in canonical form", async () => {
    const a = await acme();
    await a.addIpinfo();
    expect((await a.lookup("2001:4860:4860:0:0:0:0:8888")).lookup).toMatchObject({ ip: "2001:4860:4860::8888", state: "found" });
    expect(a.t.ipinfo.lookups).toEqual([{ token: TOKEN, ip: "2001:4860:4860::8888" }]);
  });

  test("reserved addresses are never sent to IPinfo, and anything else that isn't an IP is refused", async () => {
    const a = await acme();
    await a.addIpinfo();
    expect((await a.lookup("10.20.4.17")).lookup).toEqual({
      ip: "10.20.4.17",
      state: "reserved",
      reserved: { range: "10.0.0.0/8", label: "Private", internal: true },
      details: null,
      fetchedAt: null,
      error: null,
      // Internal: looked up in Falcon instead, and there is no CrowdStrike Integration.
      falcon: [],
    });
    expect((await a.lookup("fe80::1")).lookup).toMatchObject({ state: "reserved", reserved: { label: "Link-local", internal: false }, falcon: null });
    expect(a.t.ipinfo.lookups).toHaveLength(0);
    expect((await a.lookup("example.com")).status).toBe(422);
  });

  test("an address IPinfo calls a bogon reads as reserved", async () => {
    const a = await acme();
    await a.addIpinfo();
    a.t.ipinfo.bogons.add("192.88.99.1");
    expect((await a.lookup("192.88.99.1")).lookup).toMatchObject({ state: "reserved", reserved: { range: null, label: "Reserved" } });
    await a.lookup("192.88.99.1");
    expect(a.t.ipinfo.lookups).toHaveLength(1);
  });

  test("without an IPinfo Integration nothing is looked up", async () => {
    const a = await acme();
    expect((await a.lookup("185.220.101.4")).lookup).toMatchObject({ state: "unconfigured", details: null });
  });

  test("a paused Integration serves what is cached and fetches nothing", async () => {
    const a = await acme();
    const id = (await a.addIpinfo()).body.integration!.id;
    await a.lookup("185.220.101.4");
    await a.owner.api.integrations[":id"].pause.$post({ param: { id } });
    a.t.clock.advance(IP_LOOKUP_FRESH_MS * 2);
    expect((await a.refresh("185.220.101.4")).lookup).toMatchObject({ state: "paused", details: { country: "Germany" } });
    expect((await a.lookup("1.1.1.1")).lookup).toMatchObject({ state: "paused", details: null });
    expect(a.t.ipinfo.lookups).toHaveLength(1);
  });

  test("a failed lookup keeps the cached details, says why, sets the Integration's health, and isn't retried for a minute", async () => {
    const a = await acme();
    await a.addIpinfo();
    await a.lookup("185.220.101.4");
    a.t.clock.advance(IP_LOOKUP_FRESH_MS + 1);
    a.t.ipinfo.quotaExceeded = true;

    const failed = await a.lookup("185.220.101.4");
    expect(failed.lookup).toMatchObject({ state: "failed", error: "IPinfo's lookup quota for this token is used up", details: { country: "Germany" } });
    expect(await a.integration()).toMatchObject({ health: "error", healthDetail: "IPinfo's lookup quota for this token is used up" });

    // Hovering again doesn't hammer IPinfo.
    await a.lookup("185.220.101.4");
    expect(a.t.ipinfo.lookups).toHaveLength(2);

    a.t.ipinfo.quotaExceeded = false;
    a.t.clock.advance(IP_LOOKUP_RETRY_MS);
    expect((await a.lookup("185.220.101.4")).lookup).toMatchObject({ state: "found", error: null });
    expect(await a.integration()).toMatchObject({ health: "connected", healthDetail: null });
  });

  test("a burst of lookups of one address costs one call", async () => {
    const a = await acme();
    await a.addIpinfo();
    await Promise.all([a.lookup("9.9.9.9"), a.lookup("9.9.9.9"), a.lookup("9.9.9.9")]);
    expect(a.t.ipinfo.lookups.filter((l) => l.ip === "9.9.9.9").length).toBeLessThanOrEqual(1);
  });

  test("each Organization uses its own token and its own cache", async () => {
    const a = await acme();
    await a.addIpinfo();
    await a.lookup("185.220.101.4");
    await a.t.inviteOwner("Globex", "owner@globex.example");
    const globex = await a.t.acceptInvite("owner@globex.example", PASSWORD, "Gus Globex");
    expect((await a.lookup("185.220.101.4", globex)).lookup).toMatchObject({ state: "unconfigured" });
    await globex.api.integrations.$post({ json: { provider: "ipinfo", name: "IPinfo", token: "globex-token-1111" } });
    await a.lookup("185.220.101.4", globex);
    expect(a.t.ipinfo.lookups).toEqual([
      { token: TOKEN, ip: "185.220.101.4" },
      { token: "globex-token-1111", ip: "185.220.101.4" },
    ]);
  });

  test("Guests can't look IPs up", async () => {
    const a = await acme();
    await a.addIpinfo();
    const body = await (await a.ana.api.cases.$post({ json: { title: "Tor traffic", caseType: "other", severity: "low" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    await a.owner.api.cases[":number"].guests.$post({ param: param(body.case.number), json: { email: COUNSEL, name: "Kim Patel", expiresAt: null } });
    const guest = await a.t.guestSignIn(COUNSEL);
    expect((await a.lookup("185.220.101.4", guest)).status as number).toBe(403);
    expect(a.t.ipinfo.lookups).toHaveLength(0);
  });
});

describe("reserved ranges", () => {
  test.each([
    ["10.0.0.1", "Private"],
    ["172.31.255.255", "Private"],
    ["192.168.1.1", "Private"],
    ["127.0.0.1", "Loopback"],
    ["169.254.10.10", "Link-local"],
    ["100.64.0.1", "Shared (carrier-grade NAT)"],
    ["192.0.2.55", "Documentation"],
    ["224.0.0.251", "Multicast"],
    ["255.255.255.255", "Reserved"],
    ["::1", "Loopback"],
    ["fd12:3456::1", "Unique local"],
    ["2001:db8::1", "Documentation"],
    ["::ffff:10.1.2.3", "Private"],
    ["::ffff:a01:203", "Private"],
  ])("%s is %s", (ip, label) => {
    expect(reservedRange(ip)?.label).toBe(label);
  });

  test.each([
    ["10.0.0.1", true],
    ["172.16.0.1", true],
    ["192.168.1.1", true],
    ["100.64.0.1", true],
    ["fd12:3456::1", true],
    ["::ffff:10.1.2.3", true],
    ["127.0.0.1", false],
    ["169.254.10.10", false],
    ["fe80::1", false],
    ["192.0.2.55", false],
    ["224.0.0.251", false],
  ])("%s is internal: %p", (ip, internal) => {
    expect(reservedRange(ip)?.internal).toBe(internal);
  });

  test.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "185.220.101.4", "2001:4860:4860::8888", "::ffff:8.8.8.8"])("%s is public", (ip) => {
    expect(reservedRange(ip)).toBeNull();
  });
});

describe("IPinfo responses", () => {
  test("Plus answers are read into IpDetails, every field of them", () => {
    expect(
      readLookup({
        ip: "185.220.101.4",
        hostname: "tor-exit-04.example-relay.net",
        geo: {
          city: "Frankfurt am Main",
          region: "Hesse",
          region_code: "HE",
          country: "Germany",
          country_code: "de",
          continent: "Europe",
          continent_code: "eu",
          latitude: 50.1155,
          longitude: 8.6842,
          timezone: "Europe/Berlin",
          postal_code: "60306",
          dma_code: "",
          geoname_id: 2925533,
          radius: 20,
          last_changed: "2025-03-14",
        },
        as: { asn: "AS60729", name: "Stiftung Erneuerbare Freiheit", domain: "stiftung-erneuerbare-freiheit.de", type: "hosting", last_changed: "2024-11-02" },
        mobile: { name: "Telekom", mcc: "262", mnc: 1 },
        anonymous: { is_proxy: false, is_relay: false, is_tor: true, is_vpn: true, name: "ExampleVPN" },
        is_anonymous: true,
        is_anycast: false,
        is_hosting: true,
        is_mobile: true,
        is_satellite: false,
      }),
    ).toEqual({
      bogon: false,
      details: {
        hostname: "tor-exit-04.example-relay.net",
        city: "Frankfurt am Main",
        region: "Hesse",
        regionCode: "HE",
        country: "Germany",
        countryCode: "DE",
        continent: "Europe",
        continentCode: "EU",
        latitude: 50.1155,
        longitude: 8.6842,
        accuracyRadius: 20,
        timezone: "Europe/Berlin",
        postalCode: "60306",
        dmaCode: null,
        geonameId: "2925533",
        locationChangedOn: "2025-03-14",
        asn: "AS60729",
        asName: "Stiftung Erneuerbare Freiheit",
        asDomain: "stiftung-erneuerbare-freiheit.de",
        asType: "hosting",
        asChangedOn: "2024-11-02",
        anonymous: true,
        vpn: true,
        proxy: false,
        tor: true,
        relay: false,
        anonymousService: "ExampleVPN",
        hosting: true,
        anycast: false,
        mobile: true,
        satellite: false,
        carrier: "Telekom",
        mcc: "262",
        mnc: "1",
      },
    });
    expect(readLookup({ ip: "10.0.0.1", bogon: true })).toEqual({ bogon: true });
  });

  test("a Core answer reads too, leaving out what Core leaves out", () => {
    expect(
      readLookup({
        ip: "8.8.8.8",
        hostname: "dns.google",
        geo: { city: "Mountain View", region: "California", country: "United States", country_code: "us", continent: "North America", latitude: 37.4, longitude: -122.07, timezone: "America/Los_Angeles" },
        as: { asn: "AS15169", name: "Google LLC", domain: "google.com", type: "hosting" },
        is_anonymous: false,
        is_anycast: true,
        is_hosting: true,
        is_mobile: false,
        is_satellite: false,
      }),
    ).toEqual({
      bogon: false,
      details: {
        ...EMPTY_IP_DETAILS,
        hostname: "dns.google",
        city: "Mountain View",
        region: "California",
        country: "United States",
        countryCode: "US",
        continent: "North America",
        latitude: 37.4,
        longitude: -122.07,
        timezone: "America/Los_Angeles",
        asn: "AS15169",
        asName: "Google LLC",
        asDomain: "google.com",
        asType: "hosting",
        hosting: true,
        anycast: true,
      },
    });
  });
});
