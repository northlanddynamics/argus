import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security with its Owner and two Analysts signed in, a CrowdStrike Integration and a worker
 * reading its stream, ready for detections.
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
  type Member = typeof owner;

  const added = await owner.api.integrations.$post({
    json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret" },
  });
  if (added.status !== 201) throw new Error(`Could not add an Integration: ${added.status}`);
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const stream = falcon.tenant(CLIENT_ID);

  type Severity = "Critical" | "High" | "Medium" | "Low" | "Informational";
  /** Delivers a detection and waits for its Alert. */
  const detect = async (compositeId: string, name: string, severity: Severity = "Medium") => {
    stream.detection("EppDetectionSummaryEvent", compositeId, { Name: name, SeverityName: severity, Hostname: "FIN-LT-0231" });
    await stream.drained();
  };

  type QueueQuery = Parameters<Member["api"]["alerts"]["$get"]>[0]["query"];
  const queue = async (as: Member = ana, query: QueueQuery = {}) => {
    const res = await as.api.alerts.$get({ query });
    const body = await res.json();
    if (!("alerts" in body)) throw new Error(`Could not list Alerts: ${res.status}`);
    return body.alerts;
  };
  /** The Alert from detection `compositeId`, as the queue shows it. */
  const alert = async (compositeId: string, as: Member = ana) => {
    const found = (await queue(as)).find((a) => a.externalId === compositeId);
    if (!found) throw new Error(`No Alert ${compositeId}`);
    return found;
  };
  /** Selects Alerts as the queue shows them now: ids with their versions. */
  const select = async (...compositeIds: string[]) =>
    Promise.all(compositeIds.map(async (id) => ({ id: (await alert(id)).id, version: (await alert(id)).version })));
  const detail = async (id: string, as: Member = ana) => {
    const res = await as.api.alerts[":id"].$get({ param: { id } });
    const body = await res.json();
    if (!("alert" in body)) throw new Error(`Could not read Alert ${id}: ${res.status}`);
    return body.alert;
  };

  const open = async (as: Member = ana, title = "Credential theft on FIN-LT-0231") => {
    const res = await as.api.cases.$post({ json: { title, caseType: "malware", severity: "low" } });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case.number;
  };
  const view = async (number: number, as: Member = ana) => {
    const body = await (await as.api.cases[":number"].$get({ param: param(number) })).json();
    if (!("case" in body)) throw new Error(`Could not view C-${number}`);
    return body.case;
  };
  const caseAudit = async (number: number, as: Member = owner) => {
    const body = await (await as.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error(`Could not read the Audit Log of C-${number}`);
    return body.entries.map((e) => [e.action, e.target, e.before, e.after]);
  };

  type OpenJson = Parameters<Member["api"]["alerts"]["cases"]["$post"]>[0]["json"];
  const openFrom = async (alerts: OpenJson["alerts"], json: Partial<OpenJson> = {}, as: Member = ana) => {
    const res = await as.api.alerts.cases.$post({ json: { title: "Suspicious PowerShell on FIN-LT-0231", caseType: "malware", alerts, ...json } });
    return { status: res.status, body: await res.json() };
  };
  type Selection = OpenJson["alerts"];
  const attach = async (number: number, alerts: Selection, as: Member = ana) => {
    const res = await as.api.alerts.attach.$post({ json: { case: number, alerts } });
    return { status: res.status, body: await res.json() };
  };
  type DismissJson = Parameters<Member["api"]["alerts"]["dismiss"]["$post"]>[0]["json"];
  const dismiss = async (alerts: Selection, reason: DismissJson["reason"] = "false_positive", as: Member = ana, comment?: string) => {
    const res = await as.api.alerts.dismiss.$post({ json: { alerts, reason, comment } });
    return { status: res.status, body: await res.json() };
  };
  const move = async (id: string, version: number, number: number, as: Member = ana) => {
    const res = await as.api.alerts[":id"].move.$post({ param: { id }, json: { case: number, version } });
    return { status: res.status, body: await res.json() };
  };
  const detach = async (id: string, version: number, as: Member = ana) => {
    const res = await as.api.alerts[":id"].detach.$post({ param: { id }, json: { version } });
    return { status: res.status, body: await res.json() };
  };

  return { t, owner, ana, ben, stream, detect, queue, alert, select, detail, open, view, caseAudit, openFrom, attach, dismiss, move, detach };
}

describe("Opening a Case from Alerts", () => {
  test("one Case opens from the selected Alerts, with the highest of their Severities, and they become Attached", async () => {
    const a = await acme();
    await a.detect("ldt:1", "Encoded PowerShell from Office process", "High");
    await a.detect("ldt:2", "Credential dumping attempt", "Critical");
    await a.detect("ldt:3", "PUP installer blocked", "Low");

    const { status, body } = await a.openFrom(await a.select("ldt:1", "ldt:2"));
    expect(status).toBe(201);
    if (!("case" in body)) throw new Error("No Case opened");
    expect(body.refused).toEqual([]);
    expect(body.applied).toHaveLength(2);
    const c = await a.view(body.case.number);
    expect([c.title, c.severity, c.status]).toEqual(["Suspicious PowerShell on FIN-LT-0231", "critical", "new"]);

    expect((await a.queue()).map((x) => [x.externalId, x.status, x.version, x.case?.number ?? null])).toEqual([
      ["ldt:3", "new", 1, null],
      ["ldt:2", "attached", 2, body.case.number],
      ["ldt:1", "attached", 2, body.case.number],
    ]);
    expect((await a.queue(a.ana, { case: String(body.case.number) })).map((x) => x.externalId)).toEqual(["ldt:2", "ldt:1"]);
    expect((await a.caseAudit(body.case.number)).toSorted()).toEqual([
      ["alert.attached", "Credential dumping attempt (ldt:2)", null, `C-${body.case.number}`],
      ["alert.attached", "Encoded PowerShell from Office process (ldt:1)", null, `C-${body.case.number}`],
      ["case.opened", null, null, "Suspicious PowerShell on FIN-LT-0231"],
    ]);
    const attached = await a.detail(body.applied[0]!);
    expect(attached.attached).toMatchObject({ case: { number: body.case.number }, by: { name: "Ana Analyst" } });
  });

  test("the Severity stays editable: one given when opening wins, and the Case's can be changed later", async () => {
    const a = await acme();
    await a.detect("ldt:1", "Credential dumping attempt", "Critical");
    const { body } = await a.openFrom(await a.select("ldt:1"), { severity: "medium" });
    if (!("case" in body)) throw new Error("No Case opened");
    expect((await a.view(body.case.number)).severity).toBe("medium");
    await a.ana.api.cases[":number"].$patch({ param: param(body.case.number), json: { severity: "high" } });
    expect((await a.view(body.case.number)).severity).toBe("high");
  });

  test("no Case opens when none of the selected Alerts can be attached", async () => {
    const a = await acme();
    await a.detect("ldt:1", "Credential dumping attempt");
    const selected = await a.select("ldt:1");
    await a.detect("ldt:1", "Credential dumping attempt (updated)");

    const { status, body } = await a.openFrom(selected);
    expect(status).toBe(409);
    expect(body).toMatchObject({ refused: [{ id: selected[0]!.id, reason: "changed" }] });
    const cases = await (await a.ana.api.cases.$get({ query: {} })).json();
    expect("cases" in cases && cases.cases).toEqual([]);
  });
});

describe("Attaching Alerts to a Case", () => {
  test("selected Alerts attach to an existing Case, recorded in its Audit Log", async () => {
    const a = await acme();
    const number = await a.open();
    await a.detect("ldt:1", "Credential dumping attempt");
    await a.detect("ldt:2", "Suspicious outbound connection");

    const { status, body } = await a.attach(number, await a.select("ldt:1", "ldt:2"));
    expect(status).toBe(200);
    expect(body).toMatchObject({ refused: [] });
    expect((await a.queue(a.ana, { status: "attached" })).map((x) => x.externalId)).toEqual(["ldt:2", "ldt:1"]);
    expect((await a.caseAudit(number)).filter(([action]) => action === "alert.attached")).toHaveLength(2);
  });

  test("Alerts that changed since they were selected are refused one by one, saying how; the rest attach", async () => {
    const a = await acme();
    const number = await a.open();
    await a.detect("ldt:1", "Encoded PowerShell from Office process");
    await a.detect("ldt:2", "Credential dumping attempt");
    await a.detect("ldt:3", "Unusual sign-in location");
    await a.detect("ldt:4", "Suspicious outbound connection");
    const selected = await a.select("ldt:1", "ldt:2", "ldt:3", "ldt:4");

    // Meanwhile Ben dismisses one and Falcon updates another.
    await a.dismiss(await a.select("ldt:2"), "benign", a.ben);
    await a.detect("ldt:3", "Unusual sign-in location", "High");

    const { body } = await a.attach(number, selected);
    if (!("applied" in body)) throw new Error("Attach failed");
    expect(body.applied.toSorted()).toEqual([selected[0]!.id, selected[3]!.id].toSorted());
    expect(body.refused).toEqual([
      {
        id: selected[1]!.id,
        externalId: "ldt:2",
        title: "Credential dumping attempt",
        reason: "changed",
        detail: "changed since you selected it: it was dismissed by Ben Analyst",
      },
      {
        id: selected[2]!.id,
        externalId: "ldt:3",
        title: "Unusual sign-in location",
        reason: "changed",
        detail: "changed since you selected it: it was updated from Falcon",
      },
    ]);
    expect((await a.queue(a.ana, { status: "attached" })).map((x) => x.externalId)).toEqual(["ldt:4", "ldt:1"]);
    expect((await a.alert("ldt:2")).status).toBe("dismissed");
  });

  test("a Closed Case gains no Alerts", async () => {
    const a = await acme();
    const number = await a.open();
    await a.ana.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "benign" } });
    await a.detect("ldt:1", "Credential dumping attempt");
    const { status } = await a.attach(number, await a.select("ldt:1"));
    expect(status).toBe(409);
    expect((await a.alert("ldt:1")).status).toBe("new");
  });

  test("a Case the Member can't see is not found", async () => {
    const a = await acme();
    const number = await a.open(a.owner);
    await a.owner.api.cases[":number"].$patch({ param: param(number), json: { restricted: true } });
    await a.detect("ldt:1", "Credential dumping attempt");
    expect((await a.attach(number, await a.select("ldt:1"))).status).toBe(404);
    expect((await a.attach(9999, await a.select("ldt:1"))).status).toBe(404);
  });

  test("an Alert on a Restricted Case is shown without its Case to those who can't see it, and they can't move it", async () => {
    const a = await acme();
    const hidden = await a.open(a.owner, "Insider matter");
    await a.owner.api.cases[":number"].$patch({ param: param(hidden), json: { restricted: true } });
    const mine = await a.open(a.ana);
    await a.detect("ldt:1", "Credential dumping attempt");
    await a.attach(hidden, await a.select("ldt:1"), a.owner);

    const seen = await a.alert("ldt:1");
    expect([seen.status, seen.case]).toEqual(["attached", null]);
    expect((await a.detail(seen.id)).attached).toMatchObject({ case: null });
    const { body } = await a.attach(mine, [{ id: seen.id, version: seen.version }]);
    expect(body).toMatchObject({ applied: [], refused: [{ reason: "on_hidden_case", detail: "is attached to a Case you can't see" }] });
    expect((await a.detach(seen.id, seen.version)).status).toBe(409);
    expect((await a.alert("ldt:1", a.owner)).case?.number).toBe(hidden);
  });

  test("an Alert is on at most one Case", async () => {
    const a = await acme();
    await a.detect("ldt:1", "Credential dumping attempt");
    const id = (await a.alert("ldt:1")).id;
    expect(
      await a.t.deps.db
        .execute(sql`UPDATE alerts SET status = 'attached' WHERE id = ${id}`)
        .then(() => "updated")
        .catch(() => "refused"),
    ).toBe("refused");
  });
});

describe("Moving and detaching an Alert", () => {
  test("moving an Alert to another Case records it in both Cases' Audit Logs", async () => {
    const a = await acme();
    const from = await a.open(a.ana, "Impossible travel — svc-backup");
    const to = await a.open(a.ana, "Suspicious PowerShell on FIN-LT-0231");
    await a.detect("ldt:1", "Credential dumping attempt");
    await a.attach(from, await a.select("ldt:1"));

    const { id, version } = await a.alert("ldt:1");
    const { status, body } = await a.move(id, version, to);
    expect(status).toBe(200);
    expect(body).toMatchObject({ alert: { status: "attached", attached: { case: { number: to } } } });
    expect((await a.caseAudit(from))[0]).toEqual(["alert.detached", "Credential dumping attempt (ldt:1)", `C-${from}`, `C-${to}`]);
    expect((await a.caseAudit(to))[0]).toEqual(["alert.attached", "Credential dumping attempt (ldt:1)", `C-${from}`, `C-${to}`]);
    expect((await a.queue(a.ana, { case: String(from) })).length).toBe(0);

    // Bulk attaching moves too.
    const back = await a.attach(from, await a.select("ldt:1"));
    expect(back.body).toMatchObject({ refused: [] });
    expect((await a.alert("ldt:1")).case?.number).toBe(from);
  });

  test("moving with a stale version is refused and changes nothing", async () => {
    const a = await acme();
    const from = await a.open();
    const to = await a.open();
    await a.detect("ldt:1", "Credential dumping attempt");
    await a.attach(from, await a.select("ldt:1"));
    const { id, version } = await a.alert("ldt:1");
    await a.detect("ldt:1", "Credential dumping attempt", "Critical");

    const { status, body } = await a.move(id, version, to);
    expect(status).toBe(409);
    expect(body).toMatchObject({ refusal: { reason: "changed" } });
    expect((await a.alert("ldt:1")).case?.number).toBe(from);
  });

  test("detaching returns an Alert to the queue as New, recorded in the Case's Audit Log", async () => {
    const a = await acme();
    const number = await a.open();
    await a.detect("ldt:1", "Credential dumping attempt");
    await a.attach(number, await a.select("ldt:1"));
    const { id, version } = await a.alert("ldt:1");

    const { status, body } = await a.detach(id, version);
    expect(status).toBe(200);
    expect(body).toMatchObject({ alert: { status: "new", attached: null } });
    expect((await a.caseAudit(number))[0]).toEqual(["alert.detached", "Credential dumping attempt (ldt:1)", `C-${number}`, null]);
    expect((await a.detach(id, version + 1)).body).toMatchObject({ refusal: { reason: "not_attached" } });
  });

  test("an Alert on a Closed Case stays there", async () => {
    const a = await acme();
    const closed = await a.open();
    const other = await a.open();
    await a.detect("ldt:1", "Credential dumping attempt");
    await a.attach(closed, await a.select("ldt:1"));
    await a.ana.api.cases[":number"].close.$post({ param: param(closed), json: { resolution: "true_positive" } });
    const { id, version } = await a.alert("ldt:1");

    expect((await a.move(id, version, other)).body).toMatchObject({ refusal: { reason: "on_closed_case" } });
    expect((await a.detach(id, version)).status).toBe(409);
    expect((await a.alert("ldt:1")).case?.number).toBe(closed);
  });
});

describe("Dismissing Alerts", () => {
  test("Alerts are dismissed with a Dismissal Reason, each recorded in the Organization Audit Log", async () => {
    const a = await acme();
    await a.detect("ldt:1", "PUP installer blocked", "Low");
    await a.detect("ldt:2", "Admin tool executed", "Informational");

    const { status, body } = await a.dismiss(await a.select("ldt:1", "ldt:2"), "benign", a.ana, "Known IT tooling");
    expect(status).toBe(200);
    expect(body).toMatchObject({ refused: [] });
    const dismissed = await a.queue(a.ana, { status: "dismissed" });
    expect(dismissed.map((x) => [x.externalId, x.dismissalReason])).toEqual([
      ["ldt:2", "benign"],
      ["ldt:1", "benign"],
    ]);
    expect((await a.detail(dismissed[0]!.id)).dismissed).toMatchObject({
      reason: "benign",
      comment: "Known IT tooling",
      by: { name: "Ana Analyst" },
    });
    const log = await (await a.owner.api.organization["audit-log"].$get({ query: { category: "alerts" } })).json();
    if (!("entries" in log)) throw new Error("No Organization Audit Log");
    expect(log.entries.map((e) => [e.action, e.actor.name, e.target, e.after]).toSorted()).toEqual([
      ["alert.dismissed", "Ana Analyst", "Admin tool executed (ldt:2)", "Benign: Known IT tooling"],
      ["alert.dismissed", "Ana Analyst", "PUP installer blocked (ldt:1)", "Benign: Known IT tooling"],
    ]);
  });

  test("a Dismissal Reason is required", async () => {
    const a = await acme();
    await a.detect("ldt:1", "PUP installer blocked");
    const alerts = await a.select("ldt:1");
    const res = await a.ana.api.alerts.dismiss.$post({ json: { alerts } as never });
    expect(res.status).toBe(400);
    expect((await a.alert("ldt:1")).status).toBe("new");
  });

  test("Attached and already dismissed Alerts are refused; a dismissed Alert can still be attached later", async () => {
    const a = await acme();
    const number = await a.open();
    await a.detect("ldt:1", "Credential dumping attempt");
    await a.detect("ldt:2", "PUP installer blocked");
    await a.attach(number, await a.select("ldt:1"));
    await a.dismiss(await a.select("ldt:2"), "duplicate");

    const { body } = await a.dismiss(await a.select("ldt:1", "ldt:2"), "other");
    expect(body).toMatchObject({
      applied: [],
      refused: [
        { externalId: "ldt:1", reason: "attached", detail: `is attached to C-${number}; detach it before dismissing it` },
        { externalId: "ldt:2", reason: "dismissed" },
      ],
    });

    await a.attach(number, await a.select("ldt:2"));
    const attached = await a.alert("ldt:2");
    expect([attached.status, attached.dismissalReason]).toEqual(["attached", null]);
  });
});

describe("Live updates", () => {
  test("attaching, detaching and dismissing reach Members' live sockets as Alert queue and Case changes", async () => {
    const a = await acme();
    const number = await a.open(a.ana);
    await a.detect("ldt:1", "Credential dumping attempt");
    await a.detect("ldt:2", "PUP installer blocked");
    const socket = await a.t.connect(a.ben);

    await a.attach(number, await a.select("ldt:1"));
    await socket.next((m) => m.type === "alerts");
    await socket.next((m) => m.type === "case" && m.number === number);

    await a.dismiss(await a.select("ldt:2"), "benign");
    await socket.next((m) => m.type === "alerts");
  });
});
