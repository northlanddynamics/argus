import { describe, expect, test } from "bun:test";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import epp from "./crowdstrike/fixtures/epp-detection.json";
import idp from "./crowdstrike/fixtures/idp-detection.json";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const PROD = "falcon-client-0001";
const EU = "falcon-client-0002";
const AID = "8f1c2b3a4d5e6f708192a3b4c5d6e7f8";
const OTHER_AID = "0123456789abcdef0123456789abcdef";
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: the Owner and Ben (an Analyst), signed in; two CrowdStrike Integrations, one on
 * US-1 and one on EU-1, delivering the fixture detections.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ben@acme.example", role: "analyst" } });
  const ben = await t.acceptInvite("ben@acme.example", PASSWORD, "Ben Analyst");
  type Session = ReturnType<typeof t.session>;

  await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: PROD, clientSecret: "falcon-secret" } });
  await owner.api.integrations.$post({ json: { name: "CrowdStrike — EU", cloud: "eu-1", clientId: EU, clientSecret: "falcon-secret" } });
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();

  const alertsNamed = async () => {
    const lists = await Promise.all(
      (["new", "attached"] as const).map(async (status) => {
        const body = await (await owner.api.alerts.$get({ query: { status } })).json();
        if (!("alerts" in body)) throw new Error("No Alert queue");
        return body.alerts;
      }),
    );
    return lists.flat();
  };
  /** Delivers a fixture detection (with `fields` changed) through `clientId`'s stream and returns its Alert's id. */
  const detect = async (name: "epp" | "idp", fields: Record<string, unknown> = {}, clientId = PROD) => {
    const [eventType, event] = name === "epp" ? (["EppDetectionSummaryEvent", epp] as const) : (["IdpDetectionSummaryEvent", idp] as const);
    const payload: Record<string, unknown> = { ...event, ...fields };
    for (const [key, value] of Object.entries(fields)) if (value === undefined) delete payload[key];
    const stream = falcon.tenant(clientId);
    stream.emit(eventType, payload);
    await stream.drained();
    return (await alertsNamed()).find((a) => a.externalId === payload.CompositeId)!.id;
  };
  /** The id of the host this Alert names. */
  const host = async (alertId: string, value: string) => {
    const body = await (await owner.api.alerts[":id"].$get({ param: { id: alertId } })).json();
    if (!("alert" in body)) throw new Error("No Alert");
    const found = body.alert.indicators.assets.find((i) => i.value === value);
    if (!found) throw new Error(`The Alert doesn't name ${value}`);
    return found.id;
  };
  const page = async (as: Session, id: string) => {
    const res = await as.api.assets[":id"].$get({ param: { id } });
    const body = await res.json();
    if (!("item" in body)) throw new Error(`No page: ${res.status}`);
    return body.item;
  };
  /** The devices on the host's page, as "<Integration> <aid> <console link>", and where it is ambiguous. */
  const devices = async (as: Session, id: string) => {
    const item = await page(as, id);
    return {
      devices: item.falconDevices.flatMap((g) => g.devices.map((d) => `${g.integration.name} ${d.deviceId} ${d.consoleUrl}`)),
      ambiguous: item.falconDevices.filter((g) => g.ambiguous).map((g) => g.integration.name),
    };
  };

  return { t, owner, ben, detect, host, page, devices };
}

describe("Falcon devices recorded on hosts", () => {
  test("a detection's aid is recorded on its host for its Integration and listed with a console link", async () => {
    const a = await acme();
    const alert = await a.detect("epp");
    const host = await a.host(alert, "FIN-LT-0231");
    expect(await a.devices(a.ben, host)).toEqual({
      devices: [`CrowdStrike — Prod ${AID} https://falcon.crowdstrike.com/hosts/hosts/host/${AID}`],
      ambiguous: [],
    });

    // The same device again, from another detection on the same Integration, is recorded only once.
    await a.detect("epp", { CompositeId: "acme:ind:again" });
    await a.detect("idp");
    expect((await a.devices(a.ben, host)).devices).toHaveLength(1);
  });

  test("a detection without an aid records nothing, and the hostname stays the match key", async () => {
    const a = await acme();
    const alert = await a.detect("epp", { AgentId: undefined });
    const host = await a.host(alert, "FIN-LT-0231");
    expect(await a.devices(a.ben, host)).toEqual({ devices: [], ambiguous: [] });

    // Detections with an aid then name the same host Asset.
    const later = await a.detect("epp", { CompositeId: "acme:ind:later", Hostname: "fin-lt-0231" });
    expect(await a.host(later, "FIN-LT-0231")).toBe(host);
    expect((await a.devices(a.ben, host)).devices).toHaveLength(1);
  });

  test("one host holds several devices; several for one Integration make it ambiguous there", async () => {
    const a = await acme();
    const host = await a.host(await a.detect("epp"), "FIN-LT-0231");
    await a.detect("epp", { CompositeId: "eu:ind:1" }, EU);
    expect(await a.devices(a.ben, host)).toEqual({
      devices: [
        `CrowdStrike — Prod ${AID} https://falcon.crowdstrike.com/hosts/hosts/host/${AID}`,
        `CrowdStrike — EU ${AID} https://falcon.eu-1.crowdstrike.com/hosts/hosts/host/${AID}`,
      ],
      ambiguous: [],
    });

    // A reimaged laptop under the same name: a second device on the same Integration.
    await a.detect("epp", { CompositeId: "acme:ind:reimaged", AgentId: OTHER_AID.toUpperCase() });
    expect(await a.devices(a.ben, host)).toEqual({
      devices: [
        `CrowdStrike — Prod ${AID} https://falcon.crowdstrike.com/hosts/hosts/host/${AID}`,
        `CrowdStrike — Prod ${OTHER_AID} https://falcon.crowdstrike.com/hosts/hosts/host/${OTHER_AID}`,
        `CrowdStrike — EU ${AID} https://falcon.eu-1.crowdstrike.com/hosts/hosts/host/${AID}`,
      ],
      ambiguous: ["CrowdStrike — Prod"],
    });
  });

  test("Guests see no devices, and accounts have none", async () => {
    const a = await acme();
    const alert = await a.detect("epp");
    const host = await a.host(alert, "FIN-LT-0231");
    const account = await a.host(alert, "d.howe");
    const created = await (await a.owner.api.cases.$post({ json: { title: "Encoded PowerShell", caseType: "malware", severity: "high" } })).json();
    if (!("case" in created)) throw new Error("Could not open a Case");
    const number = created.case.number;
    const alerts = await (await a.owner.api.alerts.$get({ query: { status: "new" } })).json();
    if (!("alerts" in alerts)) throw new Error("No Alert queue");
    const version = alerts.alerts.find((x) => x.id === alert)!.version;
    await a.owner.api.alerts.attach.$post({ json: { case: number, alerts: [{ id: alert, version }] } });
    await a.owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: "k.patel@lawfirm.example", name: "Kim Patel", expiresAt: null } });
    const guest = await a.t.guestSignIn("k.patel@lawfirm.example");

    expect((await a.page(guest, host)).falconDevices).toEqual([]);
    expect((await a.devices(a.ben, host)).devices).toHaveLength(1);
    expect((await a.page(a.ben, account)).falconDevices).toEqual([]);
  });
});
