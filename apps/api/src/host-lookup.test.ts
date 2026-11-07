import { describe, expect, test } from "bun:test";
import { createHostEnricher, HOST_ENRICHMENT_UNAVAILABLE } from "./crowdstrike/host-enrichment";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import epp from "./crowdstrike/fixtures/epp-detection.json";
import { fakeFalcon, fakeHost } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const PROD = "falcon-client-0001";
const AID = "8f1c2b3a4d5e6f708192a3b4c5d6e7f8";
const OTHER_AID = "0123456789abcdef0123456789abcdef";
const MINUTE = 60_000;
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: the Owner and Ben (an Analyst), signed in; a CrowdStrike Integration on US-1, a
 * worker fetching Enrichment, and a Case to which Ben adds hosts by hand, all on a fake Falcon.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ben@acme.example", role: "analyst" } });
  const ben = await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");

  await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: PROD, clientSecret: "falcon-secret" } });
  const falcon = fakeFalcon();
  const tenant = falcon.tenant(PROD);
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const enricher = createHostEnricher(t.deps, { connect: falcon.connect });

  const created = await (await ben.api.cases.$post({ json: { title: "Lateral movement", caseType: "malware", severity: "high" } })).json();
  if (!("case" in created)) throw new Error("Could not open a Case");
  const number = created.case.number;

  /** Adds host `value` to the Case by hand and returns its id. */
  const addHost = async (value: string) => {
    const body = await (await ben.api.cases[":number"].assets.$post({ param: param(number), json: { type: "host", value } })).json();
    if (!("asset" in body)) throw new Error("Could not add the host");
    return body.asset.id;
  };
  /** Delivers the endpoint fixture (with `fields` changed; undefined removes one) and returns the id of the host it names. */
  const detect = async (fields: Record<string, unknown>) => {
    const payload: Record<string, unknown> = { ...epp, ...fields };
    for (const [key, value] of Object.entries(fields)) if (value === undefined) delete payload[key];
    tenant.emit("EppDetectionSummaryEvent", payload);
    await tenant.drained();
    const list = await (await owner.api.alerts.$get({ query: {} })).json();
    if (!("alerts" in list)) throw new Error("No Alert queue");
    const alertId = list.alerts.find((a) => a.externalId === payload.CompositeId)!.id;
    const body = await (await owner.api.alerts[":id"].$get({ param: { id: alertId } })).json();
    if (!("alert" in body)) throw new Error("No Alert");
    return body.alert.indicators.assets.find((i) => i.type === "host")!.id;
  };
  /** The host's page as Ben opens it. */
  const open = async (id: string) => {
    const res = await ben.api.assets[":id"].$get({ param: { id } });
    const page = await res.json();
    if (!("item" in page)) throw new Error(`No page: ${res.status}`);
    return page.item;
  };
  const refresh = (id: string) => ben.api.assets[":id"].enrichment.$post({ param: { id } });
  const integration = async () => {
    const list = await (await owner.api.integrations.$get()).json();
    if (!("integrations" in list)) throw new Error("No Integrations");
    return list.integrations[0]!;
  };

  return { t, owner, tenant, enricher, addHost, detect, open, refresh, integration };
}

describe("Finding a host in Falcon by hostname", () => {
  test("a hand-added host with one match records that device, then shows its Enrichment", async () => {
    const a = await acme();
    a.tenant.hosts.set(AID, fakeHost(AID, { hostname: "FIN-LT-0231" }));
    const host = await a.addHost("fin-lt-0231");

    const before = await a.open(host);
    expect(before.falconDevices).toEqual([
      {
        integration: { id: (await a.integration()).id, name: "CrowdStrike — Prod", enrichmentUnavailable: null },
        ambiguous: false,
        devices: [],
        lookup: { refreshing: true, checkedAt: null, notFound: false, error: null },
      },
    ]);

    await a.enricher.tick();
    expect(a.tenant.hostSearches).toEqual(["fin-lt-0231"]);
    const [group] = (await a.open(host)).falconDevices;
    expect(group).toMatchObject({ ambiguous: false, lookup: null });
    expect(group!.devices.map((d) => [d.deviceId, d.enrichment.host])).toEqual([[AID, fakeHost(AID, { hostname: "FIN-LT-0231" })]]);
  });

  test("several matches are all recorded and the host is marked ambiguous", async () => {
    const a = await acme();
    a.tenant.hosts.set(AID, fakeHost(AID));
    a.tenant.hosts.set(OTHER_AID, fakeHost(OTHER_AID, { lastSeen: "2025-06-01T10:00:00.000Z" }));
    const host = await a.addHost("FIN-LT-0231");
    await a.open(host);
    await a.enricher.tick();

    const [group] = (await a.open(host)).falconDevices;
    expect(group!.ambiguous).toBe(true);
    expect(group!.devices.map((d) => d.deviceId).toSorted()).toEqual([OTHER_AID, AID].toSorted());
    expect(group!.devices.every((d) => d.enrichment.host !== null)).toBe(true);
  });

  test("no match shows not found in Falcon, and is tried again on the next fetch", async () => {
    const a = await acme();
    const host = await a.addHost("FIN-LT-0231");
    await a.open(host);
    await a.enricher.tick();
    const checkedAt = a.t.clock.now().toISOString();
    expect((await a.open(host)).falconDevices[0]).toMatchObject({ devices: [], lookup: { refreshing: false, checkedAt, notFound: true, error: null } });

    // Within 15 minutes, opening the page reuses the answer; Refresh asks again.
    a.t.clock.advance(5 * MINUTE);
    await a.open(host);
    await a.enricher.tick();
    expect(a.tenant.hostSearches).toHaveLength(1);
    expect((await a.refresh(host)).status).toBe(200);
    await a.enricher.tick();
    expect(a.tenant.hostSearches).toHaveLength(2);

    // Once the sensor is installed, the next fetch finds it.
    a.tenant.hosts.set(AID, fakeHost(AID));
    a.t.clock.advance(16 * MINUTE);
    expect((await a.open(host)).falconDevices[0]!.lookup!.refreshing).toBe(true);
    await a.enricher.tick();
    expect(a.tenant.hostSearches).toHaveLength(3);
    expect((await a.open(host)).falconDevices[0]!.devices.map((d) => d.deviceId)).toEqual([AID]);
  });

  test("once a device is recorded, later fetches use its aid and not the hostname", async () => {
    const a = await acme();
    a.tenant.hosts.set(AID, fakeHost(AID));
    const host = await a.addHost("FIN-LT-0231");
    await a.open(host);
    await a.enricher.tick();
    expect(a.tenant.hostSearches).toHaveLength(1);
    expect(a.tenant.hostReads).toEqual([[AID]]);

    await a.refresh(host);
    await a.enricher.tick();
    a.t.clock.advance(16 * MINUTE);
    await a.open(host);
    await a.enricher.tick();
    expect(a.tenant.hostSearches).toHaveLength(1);
    expect(a.tenant.hostReads).toEqual([[AID], [AID], [AID]]);
  });

  test("a host named by a detection without an aid is looked up; one with an aid never is", async () => {
    const a = await acme();
    a.tenant.hosts.set(AID, fakeHost(AID));
    const withAid = await a.detect({ CompositeId: "acme:ind:with-aid" });
    const withoutAid = await a.detect({ CompositeId: "acme:ind:no-aid", Hostname: "FIN-LT-0999", AgentId: undefined, AggregateId: undefined });
    a.tenant.hosts.set(OTHER_AID, fakeHost(OTHER_AID, { hostname: "FIN-LT-0999" }));

    await a.open(withAid);
    await a.open(withoutAid);
    await a.enricher.tick();
    expect(a.tenant.hostSearches).toEqual(["FIN-LT-0999"]);
    expect((await a.open(withoutAid)).falconDevices[0]!.devices.map((d) => d.deviceId)).toEqual([OTHER_AID]);
    expect((await a.open(withAid)).falconDevices[0]!.devices.map((d) => d.deviceId)).toEqual([AID]);
  });

  test("a failed lookup says why, and a missing Hosts: Read scope shows in Integration health", async () => {
    const a = await acme();
    const host = await a.addHost("FIN-LT-0231");
    a.tenant.failNextHostReads = 1;
    await a.open(host);
    await a.enricher.tick();
    expect((await a.open(host)).falconDevices[0]!.lookup).toMatchObject({ notFound: false, error: "Finding hosts in Falcon failed: 503" });
    expect((await a.integration()).hostEnrichmentError).toBeNull();

    a.tenant.refuseHosts = "access denied, authorization failed";
    await a.refresh(host);
    await a.enricher.tick();
    expect((await a.integration()).hostEnrichmentError).toBe(HOST_ENRICHMENT_UNAVAILABLE);
    expect((await a.open(host)).falconDevices[0]!.lookup).toMatchObject({ notFound: false, error: HOST_ENRICHMENT_UNAVAILABLE });

    a.tenant.refuseHosts = null;
    await a.refresh(host);
    await a.enricher.tick();
    expect((await a.integration()).hostEnrichmentError).toBeNull();
    expect((await a.open(host)).falconDevices[0]!.lookup).toMatchObject({ notFound: true, error: null });
  });

  test("a paused Integration's lookups wait", async () => {
    const a = await acme();
    const { id } = await a.integration();
    await a.owner.api.integrations[":id"].pause.$post({ param: { id } });
    const host = await a.addHost("FIN-LT-0231");
    await a.open(host);
    await a.enricher.tick();
    expect(a.tenant.hostSearches).toEqual([]);
    expect((await a.open(host)).falconDevices[0]!.lookup!.refreshing).toBe(true);
  });
});
