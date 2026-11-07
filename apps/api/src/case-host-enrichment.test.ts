import { describe, expect, test } from "bun:test";
import { createHostEnricher } from "./crowdstrike/host-enrichment";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import epp from "./crowdstrike/fixtures/epp-detection.json";
import { fakeFalcon, fakeHost } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const PROD = "falcon-client-0001";
const AID = "8f1c2b3a4d5e6f708192a3b4c5d6e7f8";
const COUNSEL = "k.patel@lawfirm.example";
const MINUTE = 60_000;
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: the Owner, Ada (an Admin) and Ben (an Analyst), signed in; a CrowdStrike Integration
 * on US-1 delivering the endpoint fixture detection for FIN-LT-0231, attached to a Case with outside
 * counsel on it as a Guest, and a worker fetching Enrichment, on a fake Falcon that knows the laptop.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ada@acme.example", role: "admin" } });
  const ada = await t.acceptInvite("ada@acme.example", PASSWORD, "Ada Admin");
  await owner.api.organization.invitations.$post({ json: { email: "ben@acme.example", role: "analyst" } });
  const ben = await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");
  type Session = ReturnType<typeof t.session>;

  const added = await (
    await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: PROD, clientSecret: "falcon-secret" } })
  ).json();
  if (!("integration" in added)) throw new Error("Could not add an Integration");
  const falcon = fakeFalcon();
  const tenant = falcon.tenant(PROD);
  tenant.hosts.set(AID, fakeHost(AID, { containment: "contained" }));
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const enricher = createHostEnricher(t.deps, { connect: falcon.connect });

  tenant.emit("EppDetectionSummaryEvent", epp);
  await tenant.drained();
  const queue = await (await owner.api.alerts.$get({ query: {} })).json();
  if (!("alerts" in queue)) throw new Error("No Alert queue");
  const alert = queue.alerts.find((a) => a.externalId === epp.CompositeId)!;

  const opened = await (await owner.api.cases.$post({ json: { title: "Encoded PowerShell", caseType: "malware", severity: "high" } })).json();
  if (!("case" in opened)) throw new Error("Could not open a Case");
  const number = opened.case.number;
  await owner.api.alerts.attach.$post({ json: { case: number, alerts: [{ id: alert.id, version: alert.version }] } });
  await owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel", expiresAt: null } });
  const guest = await t.guestSignIn(COUNSEL);

  /** The Case's Assets as `as` opens them. */
  const assets = async (as: Session) => {
    const res = await as.api.cases[":number"].assets.$get({ param: param(number) });
    const body = await res.json();
    if (!("assets" in body)) throw new Error(`No Assets: ${res.status}`);
    return body.assets;
  };
  /** The host as the Case lists it to `as`; undefined when they don't see it. */
  const host = async (as: Session) => (await assets(as)).find((a) => a.value === "FIN-LT-0231");
  const hostId = (await host(owner))!.id;
  const mark = (as: Session, internal: boolean) =>
    as.api.cases[":number"].internal.$put({ param: param(number), json: { item: { kind: "asset", id: hostId }, internal } });

  return { t, owner, ada, ben, guest, tenant, enricher, number, integrationId: added.integration.id, assets, host, hostId, mark };
}

describe("Host Enrichment on the Case", () => {
  test("opening the Case fetches each linked host's Enrichment; it shows OS, last seen and containment, as of when it was fetched", async () => {
    const a = await acme();
    expect((await a.host(a.ben))!.falcon).toEqual([
      {
        integration: { id: a.integrationId, name: "CrowdStrike — Prod", enrichmentUnavailable: null },
        ambiguous: false,
        devices: [
          {
            deviceId: AID,
            consoleUrl: expect.stringContaining(AID),
            refreshing: true,
            fetchedAt: null,
            notFound: false,
            error: null,
            platform: null,
            osVersion: null,
            lastSeen: null,
            containment: null,
          },
        ],
        lookup: null,
      },
    ]);

    await a.enricher.tick();
    const fetchedAt = a.t.clock.now().toISOString();
    expect((await a.host(a.ben))!.falcon[0]!.devices[0]).toMatchObject({
      refreshing: false,
      fetchedAt,
      platform: "Windows",
      osVersion: "Windows 11",
      lastSeen: "2026-01-01T08:55:00.000Z",
      containment: "contained",
    });
    expect(a.tenant.hostReads).toEqual([[AID]]);
  });

  test("the Case reuses Enrichment younger than 15 minutes, as the host's page does", async () => {
    const a = await acme();
    await a.assets(a.ben);
    await a.enricher.tick();

    a.t.clock.advance(14 * MINUTE);
    expect((await a.host(a.ben))!.falcon[0]!.devices[0]!.refreshing).toBe(false);
    // The host's page reuses what the Case fetched.
    const page = await (await a.ben.api.assets[":id"].$get({ param: { id: a.hostId } })).json();
    if (!("item" in page)) throw new Error("No page");
    expect(page.item.falconDevices[0]!.devices[0]!.enrichment.refreshing).toBe(false);
    await a.enricher.tick();
    expect(a.tenant.hostReads).toHaveLength(1);

    a.t.clock.advance(2 * MINUTE);
    expect((await a.host(a.ben))!.falcon[0]!.devices[0]!.refreshing).toBe(true);
    await a.enricher.tick();
    expect(a.tenant.hostReads).toHaveLength(2);
  });

  test("Analysts and Admins see the same facts, with the Integration and console link", async () => {
    const a = await acme();
    await a.assets(a.ada);
    await a.enricher.tick();
    const asAnalyst = (await a.host(a.ben))!.falcon;
    expect(asAnalyst[0]!.integration).toMatchObject({ name: "CrowdStrike — Prod" });
    expect(asAnalyst[0]!.devices[0]!.consoleUrl).toContain(AID);
    expect((await a.host(a.ada))!.falcon).toEqual(asAnalyst);
    expect((await a.host(a.owner))!.falcon).toEqual(asAnalyst);
  });

  test("Guests see the facts, but no console link, Integration, error or health", async () => {
    const a = await acme();
    await a.assets(a.guest);
    await a.enricher.tick();
    const fetchedAt = a.t.clock.now().toISOString();
    expect((await a.host(a.guest))!.falcon).toEqual([
      {
        integration: null,
        ambiguous: false,
        devices: [
          {
            deviceId: AID,
            consoleUrl: null,
            refreshing: false,
            fetchedAt,
            notFound: false,
            error: null,
            platform: "Windows",
            osVersion: "Windows 11",
            lastSeen: "2026-01-01T08:55:00.000Z",
            containment: "contained",
          },
        ],
        lookup: null,
      },
    ]);

    // A failed fetch says why to Members, and nothing to Guests.
    a.tenant.failNextHostReads = 1;
    a.t.clock.advance(16 * MINUTE);
    await a.assets(a.guest);
    await a.enricher.tick();
    expect((await a.host(a.ben))!.falcon[0]!.devices[0]!.error).toBe("Reading hosts from Falcon failed: 503");
    expect((await a.host(a.guest))!.falcon[0]!.devices[0]).toMatchObject({ error: null, fetchedAt, containment: "contained" });

    // Nor are they told the Integration lacks Hosts: Read.
    a.tenant.refuseHosts = "access denied, authorization failed";
    await a.ben.api.assets[":id"].enrichment.$post({ param: { id: a.hostId } });
    await a.enricher.tick();
    expect((await a.host(a.ben))!.falcon[0]!.integration!.enrichmentUnavailable).not.toBeNull();
    const forGuest = (await a.host(a.guest))!.falcon[0]!;
    expect(forGuest.integration).toBeNull();
    expect(forGuest.devices[0]!.error).toBeNull();
  });

  test("a host looked up by hostname shows the lookup to Members, and to Guests without its error", async () => {
    const a = await acme();
    const res = await a.ben.api.cases[":number"].assets.$post({ param: param(a.number), json: { type: "host", value: "FIN-DT-0007" } });
    expect(res.status).toBe(201);
    const desktop = async (as: Parameters<typeof a.assets>[0]) => (await a.assets(as)).find((x) => x.value === "FIN-DT-0007")!;
    expect((await desktop(a.ben)).falcon).toEqual([
      {
        integration: { id: a.integrationId, name: "CrowdStrike — Prod", enrichmentUnavailable: null },
        ambiguous: false,
        devices: [],
        lookup: { refreshing: true, checkedAt: null, notFound: false, error: null },
      },
    ]);
    a.tenant.refuseHosts = "access denied, authorization failed";
    await a.enricher.tick();
    expect((await desktop(a.ben)).falcon[0]!.lookup!.error).not.toBeNull();
    expect((await desktop(a.guest)).falcon[0]!.lookup).toMatchObject({ error: null, refreshing: false });
  });

  test("an account Asset has no Enrichment on the Case", async () => {
    const a = await acme();
    await a.ben.api.cases[":number"].assets.$post({ param: param(a.number), json: { type: "account", value: "d.howe" } });
    expect((await a.assets(a.ben)).find((x) => x.value === "d.howe")!.falcon).toEqual([]);
  });
});

describe("An Internal host link", () => {
  test("hides the host and its Enrichment from Guests, and only from them", async () => {
    const a = await acme();
    await a.assets(a.ben);
    await a.enricher.tick();
    expect((await a.mark(a.ben, true)).status).toBe(200);

    expect(await a.host(a.guest)).toBeUndefined();
    for (const member of [a.ben, a.ada, a.owner]) {
      expect(await a.host(member)).toMatchObject({ internal: true, falcon: [{ devices: [{ containment: "contained" }] }] });
    }
    // Nor can the Guest open the host's page, or find it.
    expect((await a.guest.api.assets[":id"].$get({ param: { id: a.hostId } })).status).toBe(404);
    const found = await (await a.guest.api.search.$get({ query: { q: "FIN-LT-0231" } })).json();
    if (!("results" in found)) throw new Error("No search");
    expect(found.results.hits.filter((h) => h.kind === "assets")).toEqual([]);
    const forMember = await (await a.ben.api.search.$get({ query: { q: "FIN-LT-0231" } })).json();
    if (!("results" in forMember)) throw new Error("No search");
    expect(forMember.results.hits.filter((h) => h.kind === "assets")).toHaveLength(1);

    // Shown to Guests again, it comes back with its Enrichment.
    expect((await a.mark(a.ada, false)).status).toBe(200);
    expect(await a.host(a.guest)).toMatchObject({ internal: false, falcon: [{ integration: null, devices: [{ containment: "contained" }] }] });
  });

  test("Guests can't mark one, and a Guest doesn't hear of its Enrichment arriving", async () => {
    const a = await acme();
    expect((await a.mark(a.guest, true)).status).toBe(403);
    await a.mark(a.ben, true);

    const guestLive = await a.t.connect(a.guest);
    const memberLive = await a.t.connect(a.ben);
    await a.assets(a.ben);
    await a.enricher.tick();
    expect(await memberLive.next((m) => m.type === "case")).toEqual({ type: "case", number: a.number });
    // Then something the Guest does see.
    await a.owner.api.cases[":number"].$patch({ param: param(a.number), json: { severity: "critical" } });
    // The Guest is told of the raise first (in the same transaction), so this is that change's signal.
    await guestLive.next((m) => m.type === "notifications");
    await guestLive.next((m) => m.type === "case");
    expect(guestLive.messages.filter((m) => m.type === "case")).toEqual([{ type: "case", number: a.number }]);
  });

  test("a Guest hears of a visible host's Enrichment arriving", async () => {
    const a = await acme();
    const guestLive = await a.t.connect(a.guest);
    await a.assets(a.guest);
    await a.enricher.tick();
    expect(await guestLive.next((m) => m.type === "case")).toEqual({ type: "case", number: a.number });
  });
});
