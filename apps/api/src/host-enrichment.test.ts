import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createHostEnricher, HOST_ENRICHMENT_UNAVAILABLE } from "./crowdstrike/host-enrichment";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import epp from "./crowdstrike/fixtures/epp-detection.json";
import { falconHostSnapshots } from "./db/schema";
import { fakeFalcon, fakeHost } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const PROD = "falcon-client-0001";
const AID = "8f1c2b3a4d5e6f708192a3b4c5d6e7f8";
const OTHER_AID = "0123456789abcdef0123456789abcdef";
const MINUTE = 60_000;
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: the Owner and Ben (an Analyst), signed in; a CrowdStrike Integration on US-1
 * delivering the endpoint fixture detection for FIN-LT-0231, and a worker fetching Enrichment, all
 * on a fake Falcon that knows the laptop's device.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ben@acme.example", role: "analyst" } });
  const ben = await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");
  type Session = ReturnType<typeof t.session>;

  await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: PROD, clientSecret: "falcon-secret" } });
  const falcon = fakeFalcon();
  const tenant = falcon.tenant(PROD);
  tenant.hosts.set(AID, fakeHost(AID));
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const enricher = createHostEnricher(t.deps, { connect: falcon.connect });

  const alerts = async () => {
    const body = await (await owner.api.alerts.$get({ query: {} })).json();
    if (!("alerts" in body)) throw new Error("No Alert queue");
    return body.alerts;
  };
  /** Delivers the endpoint fixture (with `fields` changed) and returns its Alert's id. */
  const detect = async (fields: Record<string, unknown> = {}) => {
    const payload = { ...epp, ...fields };
    tenant.emit("EppDetectionSummaryEvent", payload);
    await tenant.drained();
    return (await alerts()).find((a) => a.externalId === payload.CompositeId)!.id;
  };
  const alertId = await detect();
  const body = await (await owner.api.alerts[":id"].$get({ param: { id: alertId } })).json();
  if (!("alert" in body)) throw new Error("No Alert");
  const host = body.alert.indicators.assets.find((i) => i.value === "FIN-LT-0231")!.id;

  /** The host's page as `as` opens it. */
  const open = async (as: Session = ben) => {
    const res = await as.api.assets[":id"].$get({ param: { id: host } });
    const page = await res.json();
    if (!("item" in page)) throw new Error(`No page: ${res.status}`);
    return page.item;
  };
  /** Refresh on the host's page. */
  const refresh = async (as: Session = ben) => as.api.assets[":id"].enrichment.$post({ param: { id: host } });
  /** The Enrichment of each device on the page, by `aid`. */
  const enrichment = async (as: Session = ben) =>
    Object.fromEntries((await open(as)).falconDevices.flatMap((g) => g.devices.map((d) => [d.deviceId, d.enrichment])));
  const integration = async () => {
    const list = await (await owner.api.integrations.$get()).json();
    if (!("integrations" in list)) throw new Error("No Integrations");
    return list.integrations[0]!;
  };

  return { t, owner, ben, tenant, enricher, detect, alerts, host, alertId, open, refresh, enrichment, integration };
}

describe("Host Enrichment on the host's page", () => {
  test("opening the page fetches what Falcon reports about each device, shown as of when it was fetched", async () => {
    const a = await acme();
    expect((await a.enrichment())[AID]).toMatchObject({ refreshing: true, fetchedAt: null, host: null });

    await a.enricher.tick();
    const fetchedAt = a.t.clock.now().toISOString();
    expect((await a.enrichment())[AID]).toEqual({ refreshing: false, fetchedAt, notFound: false, error: null, host: fakeHost(AID) });
    expect(a.tenant.hostReads).toEqual([[AID]]);
  });

  test("a snapshot younger than 15 minutes is reused, an older one is refetched, and Refresh always refetches", async () => {
    const a = await acme();
    await a.open();
    await a.enricher.tick();

    a.t.clock.advance(14 * MINUTE);
    expect((await a.enrichment())[AID]!.refreshing).toBe(false);
    await a.enricher.tick();
    expect(a.tenant.hostReads).toHaveLength(1);

    expect((await a.refresh()).status).toBe(200);
    await a.enricher.tick();
    expect(a.tenant.hostReads).toHaveLength(2);

    a.t.clock.advance(16 * MINUTE);
    expect((await a.enrichment())[AID]!.refreshing).toBe(true);
    await a.enricher.tick();
    expect(a.tenant.hostReads).toHaveLength(3);
  });

  test("only the latest snapshot is kept", async () => {
    const a = await acme();
    await a.open();
    await a.enricher.tick();

    a.tenant.hosts.set(AID, fakeHost(AID, { containment: "contained", lastSeen: "2026-01-01T09:10:00.000Z" }));
    a.t.clock.advance(MINUTE);
    await a.refresh();
    await a.enricher.tick();
    expect((await a.enrichment())[AID]).toMatchObject({
      fetchedAt: a.t.clock.now().toISOString(),
      host: { containment: "contained", lastSeen: "2026-01-01T09:10:00.000Z" },
    });
    const rows = await a.t.deps.db.select().from(falconHostSnapshots).where(eq(falconHostSnapshots.deviceId, AID));
    expect(rows).toHaveLength(1);
  });

  test("an aid Falcon doesn't know shows as not found, and an ambiguous host shows each device", async () => {
    const a = await acme();
    await a.detect({ CompositeId: "acme:ind:reimaged", AgentId: OTHER_AID });
    await a.open();
    await a.enricher.tick();

    const page = await a.open();
    expect(page.falconDevices).toHaveLength(1);
    expect(page.falconDevices[0]!.ambiguous).toBe(true);
    expect(await a.enrichment()).toEqual({
      [AID]: { refreshing: false, fetchedAt: a.t.clock.now().toISOString(), notFound: false, error: null, host: fakeHost(AID) },
      [OTHER_AID]: { refreshing: false, fetchedAt: a.t.clock.now().toISOString(), notFound: true, error: null, host: null },
    });
  });

  test("a failed fetch keeps the last snapshot and says why", async () => {
    const a = await acme();
    await a.open();
    await a.enricher.tick();
    const fetchedAt = a.t.clock.now().toISOString();

    a.tenant.failNextHostReads = 1;
    a.t.clock.advance(MINUTE);
    await a.refresh();
    await a.enricher.tick();
    expect((await a.enrichment())[AID]).toEqual({
      refreshing: false,
      fetchedAt,
      notFound: false,
      error: "Reading hosts from Falcon failed: 503",
      host: fakeHost(AID),
    });
    expect((await a.integration()).hostEnrichmentError).toBeNull();
  });

  test("a missing Hosts: Read scope shows in Integration health and breaks neither the page nor the stream", async () => {
    const a = await acme();
    a.tenant.refuseHosts = "access denied, authorization failed";
    await a.open();
    await a.enricher.tick();

    const integration = await a.integration();
    expect(integration.hostEnrichmentError).toBe(HOST_ENRICHMENT_UNAVAILABLE);
    expect(integration.health).toBe("connected");
    const page = await a.open();
    expect(page.falconDevices[0]!.integration.enrichmentUnavailable).toBe(HOST_ENRICHMENT_UNAVAILABLE);
    expect(page.falconDevices[0]!.devices[0]!.enrichment).toMatchObject({ host: null, error: HOST_ENRICHMENT_UNAVAILABLE });

    // Detections still arrive.
    await a.detect({ CompositeId: "acme:ind:after" });
    expect((await a.alerts()).map((x) => x.externalId)).toContain("acme:ind:after");

    // Once the scope is granted, the next fetch works and the health clears.
    a.tenant.refuseHosts = null;
    await a.refresh();
    await a.enricher.tick();
    expect((await a.integration()).hostEnrichmentError).toBeNull();
    expect((await a.enrichment())[AID]!.host).toEqual(fakeHost(AID));
  });

  test("a paused Integration's snapshots wait", async () => {
    const a = await acme();
    const { id } = await a.integration();
    await a.owner.api.integrations[":id"].pause.$post({ param: { id } });
    await a.open();
    await a.enricher.tick();
    expect(a.tenant.hostReads).toEqual([]);
    expect((await a.enrichment())[AID]!.refreshing).toBe(true);
  });

  test("Guests neither see Enrichment nor ask for it, and only Members may refresh", async () => {
    const a = await acme();
    const created = await (await a.owner.api.cases.$post({ json: { title: "Encoded PowerShell", caseType: "malware", severity: "high" } })).json();
    if (!("case" in created)) throw new Error("Could not open a Case");
    const number = created.case.number;
    const version = (await a.alerts()).find((x) => x.id === a.alertId)!.version;
    await a.owner.api.alerts.attach.$post({ json: { case: number, alerts: [{ id: a.alertId, version }] } });
    await a.owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: "k.patel@lawfirm.example", name: "Kim Patel", expiresAt: null } });
    const guest = await a.t.guestSignIn("k.patel@lawfirm.example");

    expect((await a.open(guest)).falconDevices).toEqual([]);
    expect((await a.refresh(guest)).status as number).toBe(403);
    expect(await a.t.deps.db.select().from(falconHostSnapshots)).toEqual([]);
  });
});
