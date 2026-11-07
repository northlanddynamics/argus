import { describe, expect, test } from "bun:test";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import epp from "./crowdstrike/fixtures/epp-detection.json";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const COUNSEL = "k.patel@lawfirm.example";
/** Devices other than the fixture's, for detections on other hosts. */
const HR_0007 = "a0000000000000000000000000000007";
const HR_0008 = "a0000000000000000000000000000008";
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
  /** Delivers the endpoint detection, with `overrides`, as a new Alert and returns its id. */
  const detect = async (overrides: Partial<typeof epp> = {}) => {
    const payload = { ...epp, ...overrides, CompositeId: `${epp.CompositeId}-${++detections}` };
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

  /** The Alert queue's Correlation marker for each of `ids`, as "C-<n> +<others>", or null. */
  const marked = async (ids: string[], as: Session = ana) => {
    const body = await (await as.api.alerts.$get({ query: { status: undefined } })).json();
    if (!("alerts" in body)) throw new Error("No Alert queue");
    return ids.map((id) => {
      const row = body.alerts.find((a) => a.id === id);
      if (!row) throw new Error(`Alert ${id} not in the queue`);
      return row.correlation ? `C-${row.correlation.case.number} +${row.correlation.others}` : null;
    });
  };
  const onCase = async (number: number, as: Session = ana) => {
    const res = await as.api.cases[":number"].correlations.$get({ param: param(number) });
    const body = await res.json();
    if (!("alerts" in body)) throw new Error(`Could not read the Case's Correlations: ${res.status}`);
    return body;
  };
  /** A Case's Correlations as "<alert id> <count>: values", strongest first. */
  const related = async (number: number, as: Session = ana) =>
    (await onCase(number, as)).alerts.map((c) => `${c.alert.id} ${c.sharedCount}: ${c.shared.map((s) => s.value).join(", ")}`);

  return { t, owner, admin, ana, detect, alert, open, observe, hold, correlations, suggested, attach, close, caseStatus, marked, onCase, related };
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

describe("Correlation in the Alert queue", () => {
  test("marks each matching Alert with its best visible Case and how many others it matches", async () => {
    const a = await acme();
    const one = await a.open("Tor exit traffic");
    await a.observe(one, "ip", "185.220.101.4");
    const two = await a.open("Invoice phishing");
    await a.observe(two, "ip", "185.220.101.4");
    await a.hold(two, "FIN-LT-0231");
    const both = await a.detect();
    const ipOnly = await a.detect({ Hostname: "HR-LT-0007", AgentId: HR_0007 });
    const neither = await a.detect({ Hostname: "HR-LT-0008", AgentId: HR_0008, NetworkAccesses: [] });

    const [best, tied, none] = await a.marked([both, ipOnly, neither]);
    expect(best).toBe(`C-${two} +1`);
    // Sharing one item with each, either may be named; the other is counted.
    expect([`C-${one} +1`, `C-${two} +1`]).toContain(tied!);
    expect(none).toBeNull();
  });

  test("the Alert's own Case doesn't count", async () => {
    const a = await acme();
    const on = await a.open("Invoice phishing");
    const id = await a.detect();
    await a.attach(a.ana, on, id, (await a.alert(id)).version);
    expect(await a.marked([id])).toEqual([null]);
    const other = await a.open("Tor exit traffic");
    await a.observe(other, "ip", "185.220.101.4");
    expect(await a.marked([id])).toEqual([`C-${other} +0`]);
  });

  test("Ignored items and Cases the viewer can't see never mark an Alert", async () => {
    const a = await acme();
    const secret = await a.open("Insider investigation", a.owner);
    await a.hold(secret, "FIN-LT-0231");
    await a.owner.api.cases[":number"].$patch({ param: param(secret), json: { restricted: true } });
    const open = await a.open("Tor exit traffic");
    const ip = await a.observe(open, "ip", "185.220.101.4");
    const id = await a.detect();

    expect(await a.marked([id], a.ana)).toEqual([`C-${open} +0`]);
    expect((await a.marked([id], a.admin))[0]).toEndWith(" +1");
    await a.admin.api.observables[":id"].ignored.$put({ param: { id: ip } });
    expect(await a.marked([id], a.ana)).toEqual([null]);
    expect(await a.marked([id], a.admin)).toEqual([`C-${secret} +0`]);
  });
});

describe("Correlation on the Case", () => {
  test("lists the New Alerts sharing its Observables or Assets, most shared first, with the shared values", async () => {
    const a = await acme();
    const number = await a.open("Invoice phishing");
    await a.observe(number, "ip", "185.220.101.4");
    await a.hold(number, "FIN-LT-0231");
    const ipOnly = await a.detect({ Hostname: "HR-LT-0007", AgentId: HR_0007 });
    const both = await a.detect();
    const neither = await a.detect({ Hostname: "HR-LT-0008", AgentId: HR_0008, NetworkAccesses: [] });

    expect(await a.related(number)).toEqual([`${both} 2: 185.220.101.4, FIN-LT-0231`, `${ipOnly} 1: 185.220.101.4`]);
    const found = await a.onCase(number);
    expect(found.attach).toBe("attach");
    expect(found.alerts[0]!.alert).toMatchObject({ id: both, severity: "high", host: "FIN-LT-0231", integration: { name: "CrowdStrike — Prod" } });
    expect(found.alerts[0]!.shared.map((s) => [s.kind, s.type])).toEqual([
      ["observable", "ip"],
      ["asset", "host"],
    ]);
    expect(found.alerts.map((c) => c.alert.id)).not.toContain(neither);
  });

  test("only New Alerts are listed, and attaching from the list attaches the Alert", async () => {
    const a = await acme();
    const number = await a.open("Tor exit traffic");
    await a.observe(number, "ip", "185.220.101.4");
    const elsewhere = await a.open("Invoice phishing");
    const attached = await a.detect();
    await a.attach(a.ana, elsewhere, attached, (await a.alert(attached)).version);
    const dismissed = await a.detect();
    await a.ana.api.alerts.dismiss.$post({ json: { reason: "benign", alerts: [{ id: dismissed, version: (await a.alert(dismissed)).version }] } });
    const fresh = await a.detect();

    expect(await a.related(number)).toEqual([`${fresh} 1: 185.220.101.4`]);
    const [suggestion] = (await a.onCase(number)).alerts;
    const res = await a.attach(a.ana, number, suggestion!.alert.id, suggestion!.alert.version);
    expect(await res.json()).toEqual({ applied: [fresh], refused: [] });
    expect((await a.alert(fresh)).attached?.case.number).toBe(number);
    expect(await a.related(number)).toEqual([]);
  });

  test("Ignored items don't count, and a Case the viewer can't see is not found", async () => {
    const a = await acme();
    const number = await a.open("Invoice phishing", a.owner);
    const ip = await a.observe(number, "ip", "185.220.101.4");
    const host = await a.hold(number, "FIN-LT-0231");
    const id = await a.detect();
    expect(await a.related(number)).toEqual([`${id} 2: 185.220.101.4, FIN-LT-0231`]);

    await a.admin.api.observables[":id"].ignored.$put({ param: { id: ip } });
    expect(await a.related(number)).toEqual([`${id} 1: FIN-LT-0231`]);
    await a.admin.api.assets[":id"].ignored.$put({ param: { id: host } });
    expect(await a.related(number)).toEqual([]);

    await a.owner.api.cases[":number"].$patch({ param: param(number), json: { restricted: true } });
    expect((await a.ana.api.cases[":number"].correlations.$get({ param: param(number) })).status).toBe(404);
    expect((await a.ana.api.cases[":number"].correlations.$get({ param: param(99999) })).status).toBe(404);
  });

  test("on a Closed Case, Admins Reopen and attach; Analysts can't attach", async () => {
    const a = await acme();
    const number = await a.open("Closed last year");
    await a.observe(number, "ip", "185.220.101.4");
    await a.close(number);
    const id = await a.detect();

    expect(await a.onCase(number, a.ana)).toMatchObject({ attach: null, alerts: [{ alert: { id } }] });
    expect((await a.onCase(number, a.admin)).attach).toBe("reopen_and_attach");
    const res = await a.attach(a.admin, number, id, (await a.alert(id)).version, true);
    expect(await res.json()).toEqual({ applied: [id], refused: [] });
    expect(await a.caseStatus(number)).toBe("in_progress");
  });

  test("Alerts are never attached without a Member's action", async () => {
    const a = await acme();
    const number = await a.open("Tor exit traffic");
    await a.observe(number, "ip", "185.220.101.4");
    const id = await a.detect();
    await a.related(number);
    await a.marked([id]);
    expect((await a.alert(id)).status).toBe("new");
  });

  test("Guests see neither the Case's Correlations nor the queue", async () => {
    const a = await acme();
    const number = await a.open("Tor exit traffic", a.owner);
    await a.observe(number, "ip", "185.220.101.4");
    await a.detect();
    await a.owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel", expiresAt: null } });
    const guest = await a.t.guestSignIn(COUNSEL);
    expect((await guest.api.cases[":number"].correlations.$get({ param: param(number) })).status as number).toBe(403);
    expect((await guest.api.alerts.$get({ query: {} })).status as number).toBe(403);
  });
});

/** A Case holding host FIN-LT-0231, whose `aid` an earlier detection recorded, and an Alert naming that device as FIN-LT-0231-R. */
async function renamed() {
  const a = await acme();
  const number = await a.open("Invoice phishing");
  const host = await a.hold(number, "FIN-LT-0231");
  const before = await a.detect();
  const id = await a.detect({ Hostname: "FIN-LT-0231-R" });
  const renamedHost = (await a.alert(id)).indicators.assets.find((x) => x.value === "FIN-LT-0231-R");
  if (!renamedHost) throw new Error("The renamed host isn't named");
  return { ...a, number, host, renamedHost: renamedHost.id, before, id };
}

describe("Correlation by Falcon device", () => {
  test("an Alert whose aid is on a linked host correlates despite a different hostname", async () => {
    const a = await renamed();
    expect(await a.suggested(a.id)).toEqual([`C-${a.number} 1: FIN-LT-0231`]);
    expect(await a.marked([a.id])).toEqual([`C-${a.number} +0`]);
    expect(await a.related(a.number)).toContain(`${a.id} 1: FIN-LT-0231`);
  });

  test("a host matched by both name and aid counts once", async () => {
    const a = await renamed();
    expect(await a.suggested(a.before)).toEqual([`C-${a.number} 1: FIN-LT-0231`]);
  });

  test("an Alert naming another device under a new name doesn't correlate", async () => {
    const a = await renamed();
    const other = await a.detect({ Hostname: "FIN-LT-0231-R", AgentId: "0123456789abcdef0123456789abcdef" });
    expect(await a.suggested(other)).toEqual([]);
  });

  test("an Ignored host never produces a Correlation, by name or by aid", async () => {
    const a = await renamed();
    await a.admin.api.assets[":id"].ignored.$put({ param: { id: a.host } });
    expect(await a.suggested(a.id)).toEqual([]);
    expect(await a.suggested(a.before)).toEqual([]);
    expect(await a.marked([a.id, a.before])).toEqual([null, null]);
    expect(await a.related(a.number)).toEqual([]);

    await a.admin.api.assets[":id"].ignored.$delete({ param: { id: a.host } });
    await a.admin.api.assets[":id"].ignored.$put({ param: { id: a.renamedHost } });
    expect(await a.suggested(a.id)).toEqual([]);
    expect(await a.related(a.number)).toEqual([`${a.before} 1: FIN-LT-0231`]);
  });

  test("Assets are never merged", async () => {
    const a = await renamed();
    const indicators = (await a.alert(a.id)).indicators.assets.map((x) => x.value);
    expect(indicators).toContain("FIN-LT-0231-R");
    expect(indicators).not.toContain("FIN-LT-0231");
  });
});
