import { describe, expect, test } from "bun:test";
import { createHostEnricher, HOST_ENRICHMENT_UNAVAILABLE } from "./crowdstrike/host-enrichment";
import { IP_HOST_LOOKUP_RETRY_MS } from "./crowdstrike/ip-host-lookups";
import { fakeHost } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const PROD = "falcon-client-0001";
const EU = "falcon-client-0002";
const AID = "8f1c2b3a4d5e6f708192a3b4c5d6e7f8";
const OTHER_AID = "0123456789abcdef0123456789abcdef";
const IP = "10.20.4.17";
const MINUTE = 60_000;
const param = (number: number) => ({ number: String(number) });
const aid = (n: number) => n.toString(16).padStart(32, "0");

/** Acme Security: its Owner and Ben (an Analyst), and a CrowdStrike Integration on US-1, on the fake Falcon the `web` process asks. */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ben@acme.example", role: "analyst" } });
  const ben = await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");
  type Session = ReturnType<typeof t.session>;

  const addCrowdStrike = async (name: string, clientId: string) => {
    const body = await (await owner.api.integrations.$post({ json: { name, cloud: "us-1", clientId, clientSecret: "falcon-secret" } })).json();
    if (!("integration" in body)) throw new Error("Could not add the Integration");
    return body.integration.id;
  };
  const integrationId = await addCrowdStrike("CrowdStrike — Prod", PROD);
  const tenant = t.falcon.tenant(PROD);

  const lookup = async (ip: string, as: Session = ben) => {
    const res = await as.api["ip-lookups"].$get({ query: { ip } });
    const body = await res.json();
    if (!("lookup" in body)) throw new Error(`No lookup: ${res.status}`);
    return body.lookup;
  };
  const refresh = async (ip: string) => {
    const body = await (await ben.api["ip-lookups"].refresh.$post({ json: { ip } })).json();
    if (!("lookup" in body)) throw new Error("No lookup");
    return body.lookup;
  };
  const integration = async (id = integrationId) => {
    const list = await (await owner.api.integrations.$get()).json();
    if (!("integrations" in list)) throw new Error("No Integrations");
    return list.integrations.find((i) => i.id === id)!;
  };
  return { t, owner, ben, tenant, integrationId, addCrowdStrike, lookup, refresh, integration };
}

describe("Looking an internal IP up in Falcon", () => {
  test("shows the host that last reported it, fetched once and then served from the cache for 15 minutes", async () => {
    const a = await acme();
    a.tenant.hosts.set(AID, fakeHost(AID, { hostname: "WS-FIN-0412", localIp: IP }));
    a.tenant.hosts.set(OTHER_AID, fakeHost(OTHER_AID, { hostname: "WS-FIN-0413", localIp: "10.20.4.18" }));

    const first = await a.lookup("10.20.4[.]17");
    expect(first).toMatchObject({ ip: IP, state: "reserved", reserved: { range: "10.0.0.0/8", label: "Private", internal: true } });
    expect(first.falcon).toEqual([
      {
        integration: { id: a.integrationId, name: "CrowdStrike — Prod" },
        state: "found",
        hosts: [
          {
            deviceId: AID,
            consoleUrl: `https://falcon.crowdstrike.com/hosts/hosts/host/${AID}`,
            host: fakeHost(AID, { hostname: "WS-FIN-0412", localIp: IP }),
            asset: null,
          },
        ],
        total: 1,
        fetchedAt: a.t.clock.now().toISOString(),
        error: null,
      },
    ]);
    expect(a.tenant.ipSearches).toEqual([IP]);
    expect(a.tenant.hostReads).toEqual([[AID]]);
    // IPinfo is never asked.
    expect(a.t.ipinfo.lookups).toHaveLength(0);

    a.t.clock.advance(10 * MINUTE);
    expect((await a.lookup(IP)).falcon![0]!.hosts.map((h) => h.deviceId)).toEqual([AID]);
    expect(a.tenant.ipSearches).toHaveLength(1);

    // The lease moved: once stale, Falcon is asked again.
    a.tenant.hosts.set(AID, fakeHost(AID, { hostname: "WS-FIN-0412", localIp: "10.20.4.99" }));
    a.tenant.hosts.set(OTHER_AID, fakeHost(OTHER_AID, { hostname: "WS-FIN-0413", localIp: IP }));
    a.t.clock.advance(6 * MINUTE);
    expect((await a.lookup(IP)).falcon![0]!.hosts.map((h) => h.host?.hostname)).toEqual(["WS-FIN-0413"]);
    expect(a.tenant.ipSearches).toHaveLength(2);

    // Refresh always asks.
    await a.refresh(IP);
    expect(a.tenant.ipSearches).toHaveLength(3);
  });

  test("lists every host that last reported it, newest first, at most 50, with Falcon's total", async () => {
    const a = await acme();
    for (let n = 1; n <= 52; n++) {
      a.tenant.hosts.set(aid(n), fakeHost(aid(n), { hostname: `BUILD-${n}`, localIp: "172.17.0.1", lastSeen: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString() }));
    }
    const [falcon] = (await a.lookup("172.17.0.1")).falcon!;
    expect(falcon!.total).toBe(52);
    expect(falcon!.hosts).toHaveLength(50);
    expect(falcon!.hosts.slice(0, 3).map((h) => h.host?.hostname)).toEqual(["BUILD-52", "BUILD-51", "BUILD-50"]);
  });

  test("no host in Falcon last reported it", async () => {
    const a = await acme();
    expect((await a.lookup("192.168.1.20")).falcon).toMatchObject([{ state: "found", hosts: [], total: 0, error: null }]);
    expect(a.tenant.hostReads).toEqual([]);
  });

  test("shared and unique-local addresses are looked up; loopback, link-local and public ones never reach Falcon", async () => {
    const a = await acme();
    expect((await a.lookup("100.64.3.2")).falcon).toHaveLength(1);
    expect((await a.lookup("fd12:3456::1")).falcon).toHaveLength(1);
    expect((await a.lookup("127.0.0.1")).falcon).toBeNull();
    expect((await a.lookup("169.254.1.1")).falcon).toBeNull();
    expect((await a.lookup("185.220.101.4")).falcon).toBeNull();
    expect(a.tenant.ipSearches).toEqual(["100.64.3.2", "fd12:3456::1"]);
  });

  test("a host Argus holds links to its Asset, and the lookup's snapshot is the one its page shows", async () => {
    const a = await acme();
    a.tenant.hosts.set(AID, fakeHost(AID, { hostname: "WS-FIN-0412", localIp: IP }));
    const created = await (await a.ben.api.cases.$post({ json: { title: "Lateral movement", caseType: "malware", severity: "high" } })).json();
    if (!("case" in created)) throw new Error("Could not open a Case");
    const added = await (await a.ben.api.cases[":number"].assets.$post({ param: param(created.case.number), json: { type: "host", value: "WS-FIN-0412" } })).json();
    if (!("asset" in added)) throw new Error("Could not add the host");
    await a.ben.api.assets[":id"].$get({ param: { id: added.asset.id } });
    await createHostEnricher(a.t.deps, { connect: a.t.falcon.connect }).tick();

    a.tenant.hosts.set(AID, fakeHost(AID, { hostname: "WS-FIN-0412", localIp: IP, lastLoggedOnUser: "ACME\\j.doe" }));
    const [falcon] = (await a.lookup(IP)).falcon!;
    expect(falcon!.hosts[0]!.asset).toEqual({ id: added.asset.id, value: "WS-FIN-0412" });

    const page = await (await a.ben.api.assets[":id"].$get({ param: { id: added.asset.id } })).json();
    if (!("item" in page)) throw new Error("No page");
    expect(page.item.falconDevices[0]!.devices[0]!.enrichment).toMatchObject({
      fetchedAt: a.t.clock.now().toISOString(),
      host: { lastLoggedOnUser: "ACME\\j.doe" },
    });
  });

  test("a refusal for want of Hosts: Read keeps the last answer, says why, waits a minute, and shows in the Integration's health", async () => {
    const a = await acme();
    a.tenant.hosts.set(AID, fakeHost(AID, { localIp: IP }));
    await a.lookup(IP);
    const fetchedAt = a.t.clock.now().toISOString();

    a.t.clock.advance(20 * MINUTE);
    a.tenant.refuseHosts = "access denied, authorization failed";
    expect((await a.lookup(IP)).falcon).toMatchObject([{ state: "failed", error: HOST_ENRICHMENT_UNAVAILABLE, fetchedAt, hosts: [{ deviceId: AID }] }]);
    expect(await a.integration()).toMatchObject({ hostEnrichmentError: HOST_ENRICHMENT_UNAVAILABLE });

    // Not asked again within the minute, unless refreshed.
    a.tenant.refuseHosts = null;
    expect((await a.lookup(IP)).falcon![0]!.state).toBe("failed");
    expect(a.tenant.ipSearches).toHaveLength(1);
    a.t.clock.advance(IP_HOST_LOOKUP_RETRY_MS);
    expect((await a.lookup(IP)).falcon).toMatchObject([{ state: "found", error: null }]);
    expect(await a.integration()).toMatchObject({ hostEnrichmentError: null });
  });

  test("any other failure says why and leaves the Integration's health alone", async () => {
    const a = await acme();
    const before = await a.integration();
    a.tenant.failNextHostReads = 1;
    expect((await a.lookup(IP)).falcon).toMatchObject([{ state: "failed", error: "Finding hosts by IP in Falcon failed: 503", hosts: [], fetchedAt: null }]);
    expect(await a.integration()).toMatchObject({ health: before.health, hostEnrichmentError: null });
  });

  test("a paused Integration serves what is cached and asks nothing", async () => {
    const a = await acme();
    a.tenant.hosts.set(AID, fakeHost(AID, { localIp: IP }));
    await a.lookup(IP);
    await a.owner.api.integrations[":id"].pause.$post({ param: { id: a.integrationId } });
    a.t.clock.advance(60 * MINUTE);
    expect((await a.refresh(IP)).falcon).toMatchObject([{ state: "paused", hosts: [{ deviceId: AID }] }]);
    expect(a.tenant.ipSearches).toHaveLength(1);
  });

  test("each CrowdStrike Integration answers separately, one failing without hiding the other", async () => {
    const a = await acme();
    const euId = await a.addCrowdStrike("CrowdStrike — EU", EU);
    a.tenant.hosts.set(AID, fakeHost(AID, { hostname: "US-HOST", localIp: IP }));
    a.t.falcon.tenant(EU).failNextHostReads = 1;
    const falcon = (await a.lookup(IP)).falcon!;
    const list = await (await a.owner.api.integrations.$get()).json();
    if (!("integrations" in list)) throw new Error("No Integrations");
    // In the order Settings lists them.
    expect(falcon.map((f) => f.integration.id)).toEqual(list.integrations.filter((i) => i.provider === "crowdstrike").map((i) => i.id));
    const byId = new Map(falcon.map((f) => [f.integration.id, [f.state, f.hosts.map((h) => h.host?.hostname)]]));
    expect(byId.get(a.integrationId)).toEqual(["found", ["US-HOST"]]);
    expect(byId.get(euId)).toEqual(["failed", []]);
  });
});
