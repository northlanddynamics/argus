import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import epp from "./crowdstrike/fixtures/epp-detection.json";
import idp from "./crowdstrike/fixtures/idp-detection.json";
import mobile from "./crowdstrike/fixtures/mobile-detection.json";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const COUNSEL = "k.patel@lawfirm.example";
const param = (number: number) => ({ number: String(number) });

async function dbError(query: PromiseLike<unknown>) {
  try {
    await query;
    return null;
  } catch (e) {
    return String((e as { cause?: unknown }).cause ?? e);
  }
}

/**
 * Acme Security: the Owner and Ana (an Analyst) signed in, a CrowdStrike Integration whose stream
 * delivers the real-shaped endpoint, identity and mobile detections in `crowdstrike/fixtures/`.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Session = ReturnType<typeof t.session>;

  await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret" } });
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const stream = falcon.tenant(CLIENT_ID);

  const FIXTURES = {
    epp: ["EppDetectionSummaryEvent", epp],
    idp: ["IdpDetectionSummaryEvent", idp],
    mobile: ["MobileDetectionSummaryEvent", mobile],
  } as const;
  /** Delivers fixture `name` (with `fields` changed) and waits for its Alert; returns the Alert's id. */
  const detect = async (name: keyof typeof FIXTURES, fields: Record<string, unknown> = {}) => {
    const [eventType, event] = FIXTURES[name];
    const payload = { ...event, ...fields };
    stream.emit(eventType, payload);
    await stream.drained();
    const body = await (await owner.api.alerts.$get({ query: {} })).json();
    if (!("alerts" in body)) throw new Error("No Alert queue");
    const found = body.alerts.find((a) => a.externalId === payload.CompositeId);
    if (!found) throw new Error(`No Alert for ${name}`);
    return found.id;
  };
  const version = async (id: string) => {
    const body = await (await owner.api.alerts.$get({ query: {} })).json();
    if (!("alerts" in body)) throw new Error("No Alert queue");
    return body.alerts.find((a) => a.id === id)!.version;
  };
  const detail = async (id: string) => {
    const body = await (await ana.api.alerts[":id"].$get({ param: { id } })).json();
    if (!("alert" in body)) throw new Error(`Could not read Alert ${id}`);
    return body.alert;
  };
  const open = async (title = "Suspicious PowerShell on FIN-LT-0231") => {
    const body = await (await ana.api.cases.$post({ json: { title, caseType: "malware", severity: "high" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    return body.case.number;
  };
  const attach = async (number: number, ...ids: string[]) => {
    const alerts = await Promise.all(ids.map(async (id) => ({ id, version: await version(id) })));
    const res = await ana.api.alerts.attach.$post({ json: { case: number, alerts } });
    if (res.status !== 200) throw new Error(`Could not attach: ${res.status}`);
  };
  const detach = async (id: string) => {
    const res = await ana.api.alerts[":id"].detach.$post({ param: { id }, json: { version: await version(id) } });
    if (res.status !== 200) throw new Error(`Could not detach: ${res.status}`);
  };
  const move = async (id: string, to: number) => {
    const res = await ana.api.alerts[":id"].move.$post({ param: { id }, json: { case: to, version: await version(id) } });
    if (res.status !== 200) throw new Error(`Could not move: ${res.status}`);
  };
  const observables = async (number: number, as: Session = ana) => {
    const body = await (await as.api.cases[":number"].observables.$get({ param: param(number) })).json();
    if (!("observables" in body)) throw new Error("Could not list Observables");
    return body.observables;
  };
  const assets = async (number: number, as: Session = ana) => {
    const body = await (await as.api.cases[":number"].assets.$get({ param: param(number) })).json();
    if (!("assets" in body)) throw new Error("Could not list Assets");
    return body.assets;
  };
  /** What is linked to Case `number`, as "type value" with where each came from. */
  const linked = async (number: number) => [
    ...(await observables(number)).map((o) => `${o.type} ${o.value} · ${o.fromAlert ? `Alert ${o.fromAlert.alert?.externalId.slice(-4)}` : "by hand"}`),
    ...(await assets(number)).map((a) => `${a.type} ${a.value} · ${a.fromAlert ? `Alert ${a.fromAlert.alert?.externalId.slice(-4)}` : "by hand"}`),
  ];
  const auditLog = async (number: number) => {
    const body = await (await owner.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries.map((e) => [e.action, e.target]);
  };

  return { t, owner, ana, stream, detect, detail, open, attach, detach, move, observables, assets, linked, auditLog };
}

const EPP_OBSERVABLES = [
  "sha256 7f3a9c0e5b2d4a6f8e1c3b5d7a9f0e2c4b6d8a0f1e3c5b7d9a1f3e5c7b9d1c91",
  "md5 7353f60b1739074eb17c5f4dddefe239",
  "ip 185.220.101.4",
  "domain invoice-portal.biz",
];

describe("Observables and Assets extracted from Alerts", () => {
  test("an ingested Alert names the Observables and Assets in its detection", async () => {
    const a = await acme();
    const id = await a.detect("epp");
    const { indicators } = await a.detail(id);
    expect(indicators.observables.map((o) => `${o.type} ${o.value}`)).toEqual(EPP_OBSERVABLES);
    expect(indicators.assets.map((x) => `${x.type} ${x.value}`)).toEqual(["host FIN-LT-0231", "account d.howe"]);
  });

  test("each is held once per Organization, however many Alerts name it, and is the same one added by hand", async () => {
    const a = await acme();
    const number = await a.open();
    const handAdded = await (
      await a.ana.api.cases[":number"].observables.$post({ param: param(number), json: { type: "ip", value: "185.220.101.4" } })
    ).json();
    if (!("observable" in handAdded)) throw new Error("Not added");

    const fromEpp = (await a.detail(await a.detect("epp"))).indicators;
    const fromIdp = (await a.detail(await a.detect("idp"))).indicators;
    const ip = (list: typeof fromEpp.observables) => list.find((o) => o.value === "185.220.101.4")?.id;
    expect(ip(fromEpp.observables)).toBe(handAdded.observable.id);
    expect(ip(fromIdp.observables)).toBe(handAdded.observable.id);
    const host = (list: typeof fromEpp.assets) => list.find((x) => x.value === "FIN-LT-0231")?.id;
    expect(host(fromEpp.assets)).toBe(host(fromIdp.assets)!);

    const [{ count }] = (await a.t.deps.db.execute(sql`SELECT count(*)::int AS count FROM observables WHERE value = '185.220.101.4'`)) as unknown as [
      { count: number },
    ];
    expect(count).toBe(1);
  });

  test("an updated detection adds what it now names, and keeps what it named before", async () => {
    const a = await acme();
    const id = await a.detect("mobile");
    await a.detect("mobile", { MobileDnsRequests: [{ DomainName: "c2.flashlight-pro.app" }] });
    expect((await a.detail(id)).indicators.observables.map((o) => o.value)).toEqual([
      "c4d8e2f6a0b4c8d2e6f0a4b8c2d6e0f4a8b2c6d0e4f8a2b6c0d4e8f2a6b0c4d8",
      "cdn.flashlight-pro.app",
      "203.0.113.50",
      "c2.flashlight-pro.app",
    ]);
  });

  test("attaching an Alert links what it names to the Case, recorded in its Audit Log", async () => {
    const a = await acme();
    const number = await a.open();
    const id = await a.detect("epp");
    await a.attach(number, id);

    expect(await a.linked(number)).toEqual([
      ...EPP_OBSERVABLES.map((o) => `${o} · Alert 4032`),
      "host FIN-LT-0231 · Alert 4032",
      "account d.howe · Alert 4032",
    ]);
    const [observable] = await a.observables(number);
    expect(observable).toMatchObject({ linkedBy: { name: "Ana Analyst" }, fromAlert: { alert: { id, title: "EncodedPowerShellFromOffice" } } });
    expect((await a.auditLog(number)).filter(([action]) => action !== "case.opened")).toEqual([
      ["asset.linked", "Account d.howe"],
      ["asset.linked", "Host FIN-LT-0231"],
      ["observable.linked", "Domain invoice-portal.biz"],
      ["observable.linked", "IP 185.220.101.4"],
      ["observable.linked", "MD5 7353f60b1739074eb17c5f4dddefe239"],
      ["observable.linked", "SHA-256 7f3a9c0e5b2d4a6f8e1c3b5d7a9f0e2c4b6d8a0f1e3c5b7d9a1f3e5c7b9d1c91"],
      ["alert.attached", "EncodedPowerShellFromOffice (f6f3c1d2e9a84b6c9d0e1f2a3b4c5d6e:ind:8f1c2b3a4d5e6f708192a3b4c5d6e7f8:12884902012-10197-6604032)"],
    ]);
  });

  test("what is already linked stays as it was: by hand, or by the Alert that linked it first", async () => {
    const a = await acme();
    const number = await a.open();
    await a.ana.api.cases[":number"].assets.$post({ param: param(number), json: { type: "host", value: "fin-lt-0231" } });
    await a.attach(number, await a.detect("epp"));
    await a.attach(number, await a.detect("idp"));

    expect(await a.linked(number)).toEqual([
      ...EPP_OBSERVABLES.map((o) => `${o} · Alert 4032`),
      "host fin-lt-0231 · by hand",
      "account d.howe · Alert 4032",
      "host DC01.acme.corp · Alert 4B1F",
      "account svc-backup · Alert 4B1F",
    ]);
  });

  test("detaching unlinks what the Alert linked, but not what was added by hand", async () => {
    const a = await acme();
    const number = await a.open();
    const id = await a.detect("epp");
    await a.ana.api.cases[":number"].observables.$post({ param: param(number), json: { type: "ip", value: "185.220.101.4" } });
    await a.attach(number, id);
    await a.detach(id);

    expect(await a.linked(number)).toEqual(["ip 185.220.101.4 · by hand"]);
    expect((await a.auditLog(number)).slice(0, 6).map(([action]) => action)).toEqual([
      "asset.unlinked",
      "asset.unlinked",
      "observable.unlinked",
      "observable.unlinked",
      "observable.unlinked",
      "alert.detached",
    ]);
  });

  test("an Alert-linked item added again by hand becomes hand-added, and stays when the Alert is detached", async () => {
    const a = await acme();
    const number = await a.open();
    const id = await a.detect("epp");
    await a.attach(number, id);
    const res = await a.ana.api.cases[":number"].assets.$post({ param: param(number), json: { type: "account", value: "D.Howe" } });
    expect(res.status).toBe(201);
    await a.detach(id);
    expect(await a.linked(number)).toEqual(["account d.howe · by hand"]);
  });

  test("detaching leaves what another Alert on the Case still names, held by that Alert", async () => {
    const a = await acme();
    const number = await a.open();
    const endpoint = await a.detect("epp");
    const identity = await a.detect("idp");
    await a.attach(number, endpoint, identity);
    await a.detach(endpoint);

    expect(await a.linked(number)).toEqual([
      "ip 185.220.101.4 · Alert 4B1F",
      "host FIN-LT-0231 · Alert 4B1F",
      "account d.howe · Alert 4B1F",
      "host DC01.acme.corp · Alert 4B1F",
      "account svc-backup · Alert 4B1F",
    ]);
    await a.detach(identity);
    expect(await a.linked(number)).toEqual([]);
  });

  test("moving an Alert takes what it linked to the other Case, and shows each Case in the other's Seen in", async () => {
    const a = await acme();
    const from = await a.open("Phishing wave");
    const to = await a.open("Beaconing host");
    const id = await a.detect("mobile");
    await a.attach(from, id);
    await a.move(id, to);
    expect(await a.linked(from)).toEqual([]);
    expect(await a.linked(to)).toHaveLength(5);

    await a.ana.api.cases[":number"].observables.$post({ param: param(from), json: { type: "ip", value: "203.0.113.50" } });
    const ip = (await a.observables(to)).find((o) => o.value === "203.0.113.50");
    expect(ip?.seenIn).toEqual([{ number: from, title: "Phishing wave" }]);
  });

  test("a Guest on the Case sees what an Alert linked, but not which Alert", async () => {
    const a = await acme();
    const number = await a.open();
    await a.owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel" } });
    const guest = await a.t.guestSignIn(COUNSEL);
    await a.attach(number, await a.detect("epp"));
    const [first] = await a.observables(number, guest);
    expect(first).toMatchObject({ type: "sha256", fromAlert: { alert: null } });
  });

  test("the database refuses to alter or delete what an Alert names", async () => {
    const a = await acme();
    await a.detect("epp");
    for (const table of ["alert_observables", "alert_assets"]) {
      expect(await dbError(a.t.deps.db.execute(sql.raw(`UPDATE ${table} SET seq = seq + 1`)))).toMatch(/cannot be altered or deleted/);
      expect(await dbError(a.t.deps.db.execute(sql.raw(`DELETE FROM ${table}`)))).toMatch(/cannot be altered or deleted/);
      expect(await dbError(a.t.deps.db.execute(sql.raw(`TRUNCATE ${table}`)))).toMatch(/cannot be altered or deleted/);
    }
  });
});
