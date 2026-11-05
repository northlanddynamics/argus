import { describe, expect, test } from "bun:test";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import epp from "./crowdstrike/fixtures/epp-detection.json";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const COUNSEL = "k.patel@lawfirm.example";
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: the Owner, Adam (an Admin) and Ana (an Analyst), signed in, and a CrowdStrike
 * Integration whose stream delivers the endpoint detection in `crowdstrike/fixtures/`. It names
 * IP 185.220.101.4, Domain invoice-portal.biz, two hashes, Host FIN-LT-0231 and Account d.howe.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  const join = async (email: string, role: "admin" | "analyst", name: string) => {
    await owner.api.organization.invitations.$post({ json: { email, role } });
    return t.acceptInvite(email, PASSWORD, name);
  };
  const admin = await join("adam@acme.example", "admin", "Adam Admin");
  const ana = await join("ana@acme.example", "analyst", "Ana Analyst");
  type Session = ReturnType<typeof t.session>;

  await owner.api.integrations.$post({ json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret" } });
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const stream = falcon.tenant(CLIENT_ID);

  let detections = 0;
  /** Delivers the endpoint detection as a new Alert and returns its id. */
  const detect = async () => {
    const payload = { ...epp, CompositeId: `${epp.CompositeId}-${++detections}` };
    stream.emit("EppDetectionSummaryEvent", payload);
    await stream.drained();
    const body = await (await owner.api.alerts.$get({ query: {} })).json();
    if (!("alerts" in body)) throw new Error("No Alert queue");
    const found = body.alerts.find((a) => a.externalId === payload.CompositeId);
    if (!found) throw new Error("No Alert");
    return found.id;
  };
  const alert = async (id: string) => {
    const body = await (await owner.api.alerts[":id"].$get({ param: { id } })).json();
    if (!("alert" in body)) throw new Error(`Could not read Alert ${id}`);
    return body.alert;
  };
  const open = async (title: string, as: Session = ana) => {
    const body = await (await as.api.cases.$post({ json: { title, caseType: "malware", severity: "high" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    return body.case.number;
  };
  const observe = async (number: number, type: "ip" | "domain", value: string, as: Session = owner) => {
    const body = await (await as.api.cases[":number"].observables.$post({ param: param(number), json: { type, value } })).json();
    if (!("observable" in body)) throw new Error(`Could not link ${value}`);
    return body.observable.id;
  };
  const hold = async (number: number, value: string) => {
    const body = await (await owner.api.cases[":number"].assets.$post({ param: param(number), json: { type: "host", value } })).json();
    if (!("asset" in body)) throw new Error(`Could not link ${value}`);
    return body.asset.id;
  };
  const correlations = async (id: string, as: Session = ana) => {
    const res = await as.api.alerts[":id"].correlations.$get({ param: { id } });
    const body = await res.json();
    if (!("correlations" in body)) throw new Error(`Could not read Correlations: ${res.status}`);
    return body.correlations;
  };
  /** Correlations as "C-<n> <count>: values", strongest first. */
  const suggested = async (id: string, as: Session = ana) =>
    (await correlations(id, as)).map((c) => `C-${c.case.number} ${c.sharedCount}: ${c.shared.map((s) => s.value).join(", ")}`);
  const attach = (as: Session, number: number, id: string, version: number, reopen?: boolean) =>
    as.api.alerts.attach.$post({ json: { case: number, alerts: [{ id, version }], reopen } });
  const close = (number: number) => owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "true_positive" } });
  const caseStatus = async (number: number) => {
    const body = await (await owner.api.cases[":number"].$get({ param: param(number) })).json();
    if (!("case" in body)) throw new Error("No Case");
    return body.case.status;
  };

  return { t, owner, admin, ana, detect, alert, open, observe, hold, correlations, suggested, attach, close, caseStatus };
}

describe("Correlation on the Alert page", () => {
  test("lists the Cases sharing the Alert's Observables or Assets, most shared first, with the shared values", async () => {
    const a = await acme();
    const one = await a.open("Tor exit traffic");
    await a.observe(one, "ip", "185.220.101.4");
    const three = await a.open("Invoice phishing");
    await a.observe(three, "domain", "invoice-portal.biz");
    await a.hold(three, "fin-lt-0231");
    await a.observe(three, "ip", "185.220.101.4");
    const unrelated = await a.open("Lost laptop");
    await a.observe(unrelated, "ip", "10.0.0.1");
    const id = await a.detect();

    expect(await a.suggested(id)).toEqual([
      `C-${three} 3: 185.220.101.4, invoice-portal.biz, fin-lt-0231`,
      `C-${one} 1: 185.220.101.4`,
    ]);
    const [best] = await a.correlations(id);
    expect(best!.case).toMatchObject({ number: three, title: "Invoice phishing", status: "new", severity: "high", restricted: false });
    expect(best!.shared.map((s) => [s.kind, s.type])).toEqual([
      ["observable", "ip"],
      ["observable", "domain"],
      ["asset", "host"],
    ]);
    expect(best!.attach).toBe("attach");
  });

  test("the Case the Alert is on isn't suggested", async () => {
    const a = await acme();
    const on = await a.open("Invoice phishing");
    const other = await a.open("Tor exit traffic");
    await a.observe(other, "ip", "185.220.101.4");
    const id = await a.detect();
    expect((await a.attach(a.ana, on, id, (await a.alert(id)).version)).status).toBe(200);
    expect(await a.suggested(id)).toEqual([`C-${other} 1: 185.220.101.4`]);
  });

  test("Ignored Observables and Assets never cause or count towards a suggestion", async () => {
    const a = await acme();
    const ipOnly = await a.open("Tor exit traffic");
    const ip = await a.observe(ipOnly, "ip", "185.220.101.4");
    const both = await a.open("Invoice phishing");
    await a.observe(both, "ip", "185.220.101.4");
    const host = await a.hold(both, "FIN-LT-0231");
    const id = await a.detect();
    expect(await a.suggested(id)).toEqual([`C-${both} 2: 185.220.101.4, FIN-LT-0231`, `C-${ipOnly} 1: 185.220.101.4`]);

    await a.admin.api.observables[":id"].ignored.$put({ param: { id: ip } });
    expect(await a.suggested(id)).toEqual([`C-${both} 1: FIN-LT-0231`]);
    await a.admin.api.assets[":id"].ignored.$put({ param: { id: host } });
    expect(await a.suggested(id)).toEqual([]);

    await a.admin.api.observables[":id"].ignored.$delete({ param: { id: ip } });
    expect(await a.suggested(id)).toEqual([`C-${both} 1: 185.220.101.4`, `C-${ipOnly} 1: 185.220.101.4`]);
  });

  test("Cases the viewer can't see are never suggested", async () => {
    const a = await acme();
    const secret = await a.open("Insider investigation", a.owner);
    await a.observe(secret, "ip", "185.220.101.4");
    await a.owner.api.cases[":number"].$patch({ param: param(secret), json: { restricted: true } });
    const open = await a.open("Tor exit traffic");
    await a.observe(open, "ip", "185.220.101.4");
    const id = await a.detect();

    expect(await a.suggested(id, a.ana)).toEqual([`C-${open} 1: 185.220.101.4`]);
    expect((await a.suggested(id, a.admin)).toSorted()).toEqual([`C-${open} 1: 185.220.101.4`, `C-${secret} 1: 185.220.101.4`].toSorted());

    // Assigned to it, the Analyst sees it, and so its suggestion.
    const me = await (await a.ana.api.me.$get()).json();
    if (!("user" in me)) throw new Error("No user");
    await a.owner.api.cases[":number"].$patch({ param: param(secret), json: { assigneeId: me.user.id } });
    expect(await a.suggested(id, a.ana)).toHaveLength(2);
  });

  test("Cases in every Status are suggested", async () => {
    const a = await acme();
    const resolved = await a.open("Resolved last month");
    await a.observe(resolved, "ip", "185.220.101.4");
    await a.ana.api.cases[":number"].$patch({ param: param(resolved), json: { status: "resolved" } });
    const closed = await a.open("Closed last year");
    await a.observe(closed, "ip", "185.220.101.4");
    await a.close(closed);
    const id = await a.detect();

    const found = await a.correlations(id);
    expect(found.map((c) => `C-${c.case.number} ${c.case.status} ${c.attach}`).toSorted()).toEqual(
      [`C-${resolved} resolved attach`, `C-${closed} closed null`].toSorted(),
    );
  });

  test("attaching from a suggestion attaches the Alert to an open Case", async () => {
    const a = await acme();
    const number = await a.open("Tor exit traffic");
    await a.observe(number, "ip", "185.220.101.4");
    const id = await a.detect();
    const [suggestion] = await a.correlations(id);
    expect(suggestion!.attach).toBe("attach");

    const res = await a.attach(a.ana, suggestion!.case.number, id, (await a.alert(id)).version);
    expect(await res.json()).toEqual({ applied: [id], refused: [] });
    expect((await a.alert(id)).attached?.case.number).toBe(number);
  });

  test("for a Closed Case, Admins Reopen and attach in one action; Analysts only get a link", async () => {
    const a = await acme();
    const number = await a.open("Closed last year");
    await a.observe(number, "ip", "185.220.101.4");
    await a.close(number);
    const id = await a.detect();

    expect((await a.correlations(id, a.ana))[0]!.attach).toBeNull();
    expect((await a.correlations(id, a.admin))[0]!.attach).toBe("reopen_and_attach");
    expect((await a.correlations(id, a.owner))[0]!.attach).toBe("reopen_and_attach");

    const version = (await a.alert(id)).version;
    expect((await a.attach(a.ana, number, id, version)).status).toBe(409);
    expect((await a.attach(a.ana, number, id, version, true)).status).toBe(403);
    expect((await a.attach(a.admin, number, id, version)).status).toBe(409);
    expect(await a.caseStatus(number)).toBe("closed");
    expect((await a.alert(id)).status).toBe("new");

    const res = await a.attach(a.admin, number, id, version, true);
    expect(await res.json()).toEqual({ applied: [id], refused: [] });
    expect(await a.caseStatus(number)).toBe("in_progress");
    expect((await a.alert(id)).attached?.case.number).toBe(number);
    const log = await (await a.owner.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in log)) throw new Error("No Audit Log");
    const actions = log.entries.map((e) => [e.action, e.actor.name]);
    expect(actions).toContainEqual(["case.reopened", "Adam Admin"]);
    expect(actions).toContainEqual(["alert.attached", "Adam Admin"]);
  });

  test("asking to reopen a Case that isn't Closed just attaches", async () => {
    const a = await acme();
    const number = await a.open("Tor exit traffic");
    const id = await a.detect();
    const res = await a.attach(a.ana, number, id, (await a.alert(id)).version, true);
    expect(await res.json()).toEqual({ applied: [id], refused: [] });
    expect(await a.caseStatus(number)).toBe("new");
  });

  test("nothing is attachable from a suggestion while the Alert is on a Closed Case", async () => {
    const a = await acme();
    const on = await a.open("Invoice phishing");
    const other = await a.open("Tor exit traffic");
    await a.observe(other, "ip", "185.220.101.4");
    const id = await a.detect();
    await a.attach(a.ana, on, id, (await a.alert(id)).version);
    await a.close(on);
    expect((await a.correlations(id, a.admin)).map((c) => [c.case.number, c.attach])).toEqual([[other, null]]);
  });

  test("Alerts are never attached without a Member's action", async () => {
    const a = await acme();
    const number = await a.open("Tor exit traffic");
    await a.observe(number, "ip", "185.220.101.4");
    const id = await a.detect();
    await a.correlations(id);
    // A Case linking more of what the Alert names doesn't attach it either.
    await a.observe(number, "domain", "invoice-portal.biz");
    await a.correlations(id);
    const later = await a.detect();

    for (const alertId of [id, later]) expect((await a.alert(alertId)).status).toBe("new");
    const onCase = await (await a.ana.api.cases[":number"].alerts.$get({ param: param(number) })).json();
    expect(onCase).toEqual({ alerts: [] });
    expect(await a.suggested(later)).toEqual([`C-${number} 2: 185.220.101.4, invoice-portal.biz`]);
  });

  test("Members only: Guests never see Correlations, and an Alert on a Case the Member can't see is not found", async () => {
    const a = await acme();
    const number = await a.open("Tor exit traffic", a.owner);
    await a.observe(number, "ip", "185.220.101.4");
    const id = await a.detect();
    await a.owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel", expiresAt: null } });
    const guest = await a.t.guestSignIn(COUNSEL);
    expect((await guest.api.alerts[":id"].correlations.$get({ param: { id } })).status as number).toBe(403);

    await a.attach(a.owner, number, id, (await a.alert(id)).version);
    await a.owner.api.cases[":number"].$patch({ param: param(number), json: { restricted: true } });
    expect((await a.ana.api.alerts[":id"].correlations.$get({ param: { id } })).status).toBe(404);
    expect((await a.ana.api.alerts[":id"].correlations.$get({ param: { id: "no-such-alert" } })).status).toBe(404);
  });
});
