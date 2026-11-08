import { describe, expect, test } from "bun:test";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import epp from "./crowdstrike/fixtures/epp-detection.json";
import idp from "./crowdstrike/fixtures/idp-detection.json";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const COUNSEL = "k.patel@lawfirm.example";
const HOUR = 60 * 60 * 1000;
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: the Owner, Ana (an Analyst, assigned to the Restricted Case) and Ben (an Analyst
 * who isn't), signed in; a CrowdStrike Integration delivering the fixture detections.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  const join = async (email: string, name: string) => {
    await owner.api.organization.invitations.$post({ json: { email, role: "analyst" } });
    return t.acceptInvite(email, PASSWORD, name);
  };
  const ana = await join("ana@acme.example", "Ana Analyst");
  const ben = await join("ben@acme.example", "Ben Analyst");
  type Session = ReturnType<typeof t.session>;
  const anaId = await (async () => {
    const me = await (await ana.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  })();

  await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret" } });
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const stream = falcon.tenant(CLIENT_ID);
  /** Every Alert, whatever its status. */
  const queue = async () => {
    const lists = await Promise.all(
      (["new", "attached", "dismissed"] as const).map(async (status) => {
        const body = await (await owner.api.alerts.$get({ query: { status } })).json();
        if (!("alerts" in body)) throw new Error("No Alert queue");
        return body.alerts;
      }),
    );
    return lists.flat();
  };
  /** Delivers a fixture detection (with `fields` changed) and returns its Alert's id. */
  const detect = async (name: "epp" | "idp", fields: Record<string, unknown> = {}) => {
    const [eventType, event] = name === "epp" ? (["EppDetectionSummaryEvent", epp] as const) : (["IdpDetectionSummaryEvent", idp] as const);
    const payload = { ...event, ...fields };
    stream.emit(eventType, payload);
    await stream.drained();
    return (await queue()).find((a) => a.externalId === payload.CompositeId)!.id;
  };
  const version = async (id: string) => (await queue()).find((a) => a.id === id)!.version;

  const open = async (title: string, options: { restricted?: boolean; assignee?: string; severity?: "low" | "high" } = {}) => {
    const body = await (await owner.api.cases.$post({ json: { title, caseType: "malware", severity: options.severity ?? "high" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    const number = body.case.number;
    if (options.restricted) await owner.api.cases[":number"].$patch({ param: param(number), json: { assigneeId: anaId, restricted: true } });
    else if (options.assignee) await owner.api.cases[":number"].$patch({ param: param(number), json: { assigneeId: options.assignee } });
    return number;
  };
  /** Links an Observable to Case `number` and returns its id. */
  const observe = async (number: number, type: "ip" | "domain" | "url" | "email", value: string) => {
    const res = await owner.api.cases[":number"].observables.$post({ param: param(number), json: { type, value } });
    const body = await res.json();
    if (!("observable" in body)) throw new Error(`Could not link ${value}: ${res.status}`);
    return body.observable.id;
  };
  const attach = async (number: number, id: string) => {
    const res = await owner.api.alerts.attach.$post({ json: { case: number, alerts: [{ id, version: await version(id) }] } });
    if (res.status !== 200) throw new Error(`Could not attach: ${res.status}`);
  };
  const dismiss = async (id: string) => {
    const res = await owner.api.alerts.dismiss.$post({ json: { reason: "false_positive", alerts: [{ id, version: await version(id) }] } });
    if (res.status !== 200) throw new Error(`Could not dismiss: ${res.status}`);
  };
  /** The id of the Observable or Asset with this value that Alert `alertId` names. */
  const named = async (alertId: string, value: string) => {
    const body = await (await owner.api.alerts[":id"].$get({ param: { id: alertId } })).json();
    if (!("alert" in body)) throw new Error("No Alert");
    const found = [...body.alert.indicators.observables, ...body.alert.indicators.assets].find((i) => i.value === value);
    if (!found) throw new Error(`The Alert doesn't name ${value}`);
    return found.id;
  };
  const observable = async (as: Session, id: string) => {
    const res = await as.api.observables[":id"].$get({ param: { id } });
    const body = await res.json();
    return "item" in body ? body.item : res.status;
  };
  const asset = async (as: Session, id: string) => {
    const res = await as.api.assets[":id"].$get({ param: { id } });
    const body = await res.json();
    return "item" in body ? body.item : res.status;
  };
  const inviteGuest = async (number: number) => {
    const res = await owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel", expiresAt: null } });
    if (res.status !== 201) throw new Error(`Could not invite the Guest: ${res.status}`);
    return t.guestSignIn(COUNSEL);
  };

  return { t, owner, ana, ben, anaId, open, observe, detect, attach, dismiss, named, observable, asset, inviteGuest };
}

describe("Observable and Asset pages", () => {
  test("show the value, first and last seen, every linked Case and every Alert naming it, whatever its status", async () => {
    const a = await acme();
    const start = a.t.clock.now();
    const newAlert = await a.detect("epp");
    const ip = await a.named(newAlert, "185.220.101.4");

    a.t.clock.advance(HOUR);
    const attached = await a.detect("epp", { CompositeId: "acme:ind:attached" });
    const onCase = await a.open("Beaconing from FIN-LT-0231", { assignee: a.anaId });
    await a.attach(onCase, attached);

    a.t.clock.advance(HOUR);
    const dismissed = await a.detect("epp", { CompositeId: "acme:ind:dismissed" });
    await a.dismiss(dismissed);

    a.t.clock.advance(HOUR);
    const byHand = await a.open("Tor exit node traffic", { severity: "low" });
    expect(await a.observe(byHand, "ip", "185.220.101.004")).toBe(ip);

    const page = await a.observable(a.ben, ip);
    if (typeof page === "number") throw new Error(`No page: ${page}`);
    expect(page).toMatchObject({ id: ip, type: "ip", value: "185.220.101.4" });
    expect(page.firstSeen).toBe(start.toISOString());
    expect(page.lastSeen).toBe(new Date(start.getTime() + 3 * HOUR).toISOString());
    expect(page.cases.map((c) => [c.number, c.status, c.severity, c.assignee?.name ?? null])).toEqual([
      [byHand, "new", "low", null],
      [onCase, "new", "high", "Ana Analyst"],
    ]);
    expect(page.alerts.map((x) => [x.id, x.status, x.case?.number ?? null])).toEqual([
      [dismissed, "dismissed", null],
      [attached, "attached", onCase],
      [newAlert, "new", null],
    ]);

    // Assets have the same page.
    const host = await a.named(newAlert, "FIN-LT-0231");
    const hostPage = await a.asset(a.ben, host);
    if (typeof hostPage === "number") throw new Error(`No page: ${hostPage}`);
    expect(hostPage).toMatchObject({ type: "host", value: "FIN-LT-0231" });
    expect(hostPage.cases.map((c) => c.number)).toEqual([onCase]);
    expect(hostPage.alerts).toHaveLength(3);

    // An Observable's id is not an Asset's.
    expect(await a.asset(a.ben, ip)).toBe(404);
    expect(await a.observable(a.ben, "no-such-id")).toBe(404);
  });

  test("an Alert's host and user lead to their Asset pages, from its page's Alerts and from the queue", async () => {
    const a = await acme();
    const alert = await a.detect("epp");
    const ip = await a.named(alert, "185.220.101.4");
    const host = await a.named(alert, "FIN-LT-0231");
    const account = await a.named(alert, "d.howe");

    const page = await a.observable(a.ben, ip);
    if (typeof page === "number") throw new Error(`No page: ${page}`);
    expect(page.alerts.map((x) => [x.host, x.hostAsset])).toEqual([["FIN-LT-0231", { id: host }]]);

    const body = await (await a.ben.api.alerts.$get({ query: { status: "new" } })).json();
    if (!("alerts" in body)) throw new Error("No Alert queue");
    expect(body.alerts.map((x) => [x.host, x.hostAsset, x.userName, x.userAsset])).toEqual([["FIN-LT-0231", { id: host }, "d.howe", { id: account }]]);

    // A detection naming no host has nothing to lead to.
    await a.detect("epp", { CompositeId: "acme:ind:no-host", Hostname: undefined, UserName: undefined });
    const again = await (await a.ben.api.alerts.$get({ query: { status: "new" } })).json();
    if (!("alerts" in again)) throw new Error("No Alert queue");
    const bare = again.alerts.find((x) => x.externalId === "acme:ind:no-host")!;
    expect([bare.host, bare.hostAsset, bare.userAsset]).toEqual([null, null, null]);
  });

  test("Restricted Cases the viewer can't see are neither shown nor counted, nor are their Alerts", async () => {
    const a = await acme();
    const start = a.t.clock.now();
    const shared = await a.open("Phishing wave");
    const domain = await a.observe(shared, "domain", "invoice-portal.biz");
    a.t.clock.advance(HOUR);
    const secret = await a.open("Insider exfiltration", { restricted: true });
    await a.observe(secret, "domain", "invoice-portal.biz");
    const onlySecret = await a.observe(secret, "domain", "exfil-drop.example");
    const alert = await a.detect("epp");
    await a.attach(secret, alert);

    const asBen = await a.observable(a.ben, domain);
    if (typeof asBen === "number") throw new Error(`No page: ${asBen}`);
    expect(asBen.cases.map((c) => c.number)).toEqual([shared]);
    expect(asBen.alerts).toEqual([]);
    expect([asBen.firstSeen, asBen.lastSeen]).toEqual([start.toISOString(), start.toISOString()]);
    expect(await a.observable(a.ben, onlySecret)).toBe(404);

    const asAna = await a.observable(a.ana, domain);
    if (typeof asAna === "number") throw new Error(`No page: ${asAna}`);
    expect(asAna.cases.map((c) => [c.number, c.restricted])).toEqual([
      [secret, true],
      [shared, false],
    ]);
    expect(asAna.alerts.map((x) => [x.id, x.case?.number])).toEqual([[alert, secret]]);
    expect(asAna.lastSeen).toBe(new Date(start.getTime() + HOUR).toISOString());
    expect(await a.observable(a.ana, onlySecret)).toMatchObject({ value: "exfil-drop.example" });
  });

  test("Guests see only the Cases they've been granted and no Alerts", async () => {
    const a = await acme();
    const theirs = await a.open("Phishing of the CFO");
    const other = await a.open("Phishing of the CEO");
    const ip = await a.observe(theirs, "ip", "203.0.113.7");
    await a.observe(other, "ip", "203.0.113.7");
    const notTheirs = await a.observe(other, "domain", "ceo-lure.example");
    const alert = await a.detect("epp");
    await a.attach(theirs, alert);
    const host = await a.named(alert, "FIN-LT-0231");
    const onlyAlert = await a.named(await a.detect("idp", { SourceAccountName: "j.reyes" }), "j.reyes");
    const guest = await a.inviteGuest(theirs);

    const page = await a.observable(guest, ip);
    if (typeof page === "number") throw new Error(`No page: ${page}`);
    expect(page.cases.map((c) => c.number)).toEqual([theirs]);
    expect(page.alerts).toEqual([]);
    const hostPage = await a.asset(guest, host);
    if (typeof hostPage === "number") throw new Error(`No page: ${hostPage}`);
    expect(hostPage.cases.map((c) => c.number)).toEqual([theirs]);
    expect(hostPage.alerts).toEqual([]);

    expect(await a.observable(guest, notTheirs)).toBe(404);
    expect(await a.asset(guest, onlyAlert)).toBe(404);
    // Members see what only an Alert names.
    expect(await a.asset(a.ben, onlyAlert)).toMatchObject({ value: "j.reyes", cases: [] });
  });

  test("viewers hear when a Case links it or an Alert names it", async () => {
    const a = await acme();
    const number = await a.open("Phishing wave");
    const live = await a.t.connect(a.ben);
    await a.observe(number, "ip", "185.220.101.4");
    expect(await live.next()).toEqual({ type: "case", number });
    await a.detect("epp");
    expect(await live.next()).toEqual({ type: "alerts" });
  });
});
