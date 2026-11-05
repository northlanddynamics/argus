import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const OWNER = "owner@acme.example";
const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const CLIENT_SECRET = "s3cr3t-falcon-secret-value";
const MINUTE = 60_000;

/** Acme Security with its Owner, an Admin and an Analyst signed in, a fake Falcon and workers to run against it. */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", OWNER);
  const owner = await t.acceptInvite(OWNER, PASSWORD, "Olive Owner");
  const join = async (email: string, role: "admin" | "analyst", name: string) => {
    await owner.api.organization.invitations.$post({ json: { email, role } });
    return t.acceptInvite(email, PASSWORD, name);
  };
  const admin = await join("adam@acme.example", "admin", "Adam Admin");
  const ana = await join("ana@acme.example", "analyst", "Ana Analyst");
  type Session = typeof owner;
  const falcon = fakeFalcon();

  const worker = (workerId = "worker-1") => {
    const w = createStreamWorker(t.deps, { connect: falcon.connect, workerId });
    t.onCleanup(w.close);
    return w;
  };

  type CreateJson = Parameters<Session["api"]["integrations"]["$post"]>[0]["json"];
  const add = async (as: Session = admin, json: Partial<CreateJson> = {}) => {
    const res = await as.api.integrations.$post({
      json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, ...json },
    });
    return { status: res.status, body: await res.json() };
  };
  /** Adds the usual Integration as the Admin and returns its id. */
  const addProd = async (json: Partial<CreateJson> = {}) => {
    const { status, body } = await add(admin, json);
    if (status !== 201 || !("integration" in body)) throw new Error(`Could not add an Integration: ${status} ${JSON.stringify(body)}`);
    return body.integration.id;
  };
  const integrations = async (as: Session = admin) => {
    const body = await (await as.api.integrations.$get()).json();
    if (!("integrations" in body)) throw new Error("Could not list Integrations");
    return body.integrations;
  };
  const integration = async (id: string, as: Session = admin) => (await integrations(as)).find((i) => i.id === id)!;

  type QueueQuery = Parameters<Session["api"]["alerts"]["$get"]>[0]["query"];
  const queue = async (as: Session = ana, query: QueueQuery = {}) => {
    const res = await as.api.alerts.$get({ query });
    const body = await res.json();
    if (!("alerts" in body)) throw new Error(`Could not list Alerts: ${res.status}`);
    return body.alerts;
  };
  const orgAudit = async () => {
    const body = await (await owner.api.organization["audit-log"].$get({ query: { category: "integrations" } })).json();
    if (!("entries" in body)) throw new Error("Could not read the Organization Audit Log");
    return body.entries;
  };

  return { t, owner, admin, ana, falcon, worker, add, addProd, integrations, integration, queue, orgAudit };
}

describe("Adding a CrowdStrike Integration", () => {
  test("an Admin adds one with Falcon API credentials; they are stored sealed and never sent back", async () => {
    const a = await acme();
    const { status, body } = await a.add();
    expect(status).toBe(201);
    expect(JSON.stringify(body)).not.toContain(CLIENT_SECRET);

    const listed = await a.integrations();
    expect(listed).toMatchObject([
      { type: "crowdstrike", name: "CrowdStrike — Prod", cloud: "us-1", paused: false, writeBack: false, health: "connecting", lastEventAt: null },
    ]);
    expect(listed[0]!.credentials).toMatchObject({ clientIdHint: "…0001" });
    expect(JSON.stringify(listed)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(listed)).not.toContain(CLIENT_ID);

    const rows = await a.t.deps.db.execute(sql`SELECT * FROM integrations`);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(rows)).not.toContain(CLIENT_ID);

    expect(await a.orgAudit()).toMatchObject([
      { action: "integration.created", actor: { name: "Adam Admin" }, target: "CrowdStrike — Prod", after: "CrowdStrike US-1 · client …0001 · read only" },
    ]);
  });

  test("the worker connects with the credentials as they were entered", async () => {
    const a = await acme();
    await a.addProd();
    await a.worker().tick();
    expect(a.falcon.tenant(CLIENT_ID).opened).toMatchObject([
      { cloud: "us-1", credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } },
    ]);
  });

  test("names are unique within the Organization", async () => {
    const a = await acme();
    await a.addProd();
    expect((await a.add(a.admin, { name: "crowdstrike — prod" })).status).toBe(409);
  });

  test("Analysts see the Integrations and their health, but not the credentials, and can't change them", async () => {
    const a = await acme();
    const id = await a.addProd();
    expect((await a.add(a.ana, { name: "Mine" })).status).toBe(403);
    const [seen] = await a.integrations(a.ana);
    expect(seen).toMatchObject({ id, name: "CrowdStrike — Prod", health: "connecting", credentials: null });
    const param = { id };
    expect((await a.ana.api.integrations[":id"].pause.$post({ param })).status).toBe(403);
    expect((await a.ana.api.integrations[":id"].credentials.$put({ param, json: { clientId: "x", clientSecret: "y" } })).status).toBe(403);
  });

  test("rotating credentials and pausing and resuming are recorded in the Organization Audit Log", async () => {
    const a = await acme();
    const id = await a.addProd();
    const param = { id };
    const rotated = await a.admin.api.integrations[":id"].credentials.$put({ param, json: { clientId: "falcon-client-0002", clientSecret: "new-secret" } });
    expect(rotated.status).toBe(200);
    expect((await a.admin.api.integrations[":id"].pause.$post({ param })).status).toBe(200);
    expect((await a.integration(id)).paused).toBe(true);
    expect((await a.admin.api.integrations[":id"].resume.$post({ param })).status).toBe(200);
    expect((await a.integration(id)).paused).toBe(false);

    expect((await a.orgAudit()).map((e) => [e.action, e.target, e.before, e.after])).toEqual([
      ["integration.resumed", "CrowdStrike — Prod", null, null],
      ["integration.paused", "CrowdStrike — Prod", null, null],
      ["integration.credentials_rotated", "CrowdStrike — Prod", "client …0001", "client …0002"],
      ["integration.created", "CrowdStrike — Prod", null, "CrowdStrike US-1 · client …0001 · read only"],
    ]);
    expect((await a.integration(id)).credentials).toMatchObject({ clientIdHint: "…0002" });
  });

  test("write-back to Falcon is off unless asked for when adding one", async () => {
    const a = await acme();
    const readOnly = await a.addProd();
    const writing = await a.addProd({ name: "CrowdStrike — Lab", clientId: "falcon-lab-0009", writeBack: true });
    expect((await a.integration(readOnly)).writeBack).toBe(false);
    expect((await a.integration(writing)).writeBack).toBe(true);
    expect((await a.orgAudit())[0]).toMatchObject({ action: "integration.created", after: "CrowdStrike US-1 · client …0009 · write-back on" });
  });

  test("an Admin allows and denies write-back, recorded in the Organization Audit Log; Analysts can't", async () => {
    const a = await acme();
    const id = await a.addProd();
    const param = { id };
    const setWriteBack = (as: typeof a.admin, enabled: boolean) => as.api.integrations[":id"]["write-back"].$put({ param, json: { enabled } });

    expect((await setWriteBack(a.ana, true)).status).toBe(403);
    expect((await a.integration(id)).writeBack).toBe(false);

    expect((await setWriteBack(a.admin, true)).status).toBe(200);
    expect(await a.integration(id, a.ana)).toMatchObject({ writeBack: true });
    expect((await setWriteBack(a.admin, true)).status).toBe(200);
    expect((await setWriteBack(a.admin, false)).status).toBe(200);
    expect((await a.integration(id)).writeBack).toBe(false);

    expect((await a.orgAudit()).map((e) => [e.action, e.actor.name, e.before, e.after])).toEqual([
      ["integration.write_back_disabled", "Adam Admin", "write-back on", "read only"],
      ["integration.write_back_enabled", "Adam Admin", "read only", "write-back on"],
      ["integration.created", "Adam Admin", null, "CrowdStrike US-1 · client …0001 · read only"],
    ]);
    expect((await a.admin.api.integrations[":id"]["write-back"].$put({ param: { id: "nope" }, json: { enabled: true } })).status).toBe(404);
  });

  test("denying write-back leaves the stream alone: Alerts keep arriving", async () => {
    const a = await acme();
    const id = await a.addProd({ writeBack: true });
    const stream = a.falcon.tenant(CLIENT_ID);
    const w = a.worker();
    await w.tick();
    await a.admin.api.integrations[":id"]["write-back"].$put({ param: { id }, json: { enabled: false } });
    await w.tick();
    stream.detection("EppDetectionSummaryEvent", "ldt:0", { Name: "Still read" });
    await stream.drained();
    expect(stream.opened).toHaveLength(1);
    expect((await a.queue()).map((x) => x.title)).toEqual(["Still read"]);
  });

  test("an unknown Integration is not found", async () => {
    const a = await acme();
    expect((await a.admin.api.integrations[":id"].pause.$post({ param: { id: "nope" } })).status).toBe(404);
  });
});

describe("Providers and Response Actions", () => {
  test("an Integration is CrowdStrike unless said otherwise, and Response Actions are off unless asked for", async () => {
    const a = await acme();
    const id = await a.addProd();
    const acting = await a.addProd({ name: "CrowdStrike — Lab", clientId: "falcon-lab-0009", provider: "crowdstrike", responseActions: true });
    expect(await a.integration(id, a.ana)).toMatchObject({
      provider: "crowdstrike",
      capabilities: { receivesAlerts: true, writesBack: true, responseActions: true },
      responseActions: false,
    });
    expect((await a.integration(acting)).responseActions).toBe(true);
    expect((await a.orgAudit())[0]).toMatchObject({
      action: "integration.created",
      after: "CrowdStrike US-1 · client …0009 · read only · Response Actions on",
    });
    expect((await a.add(a.admin, { name: "Mail", provider: "mimecast" as "crowdstrike" })).status).toBe(400);
  });

  test("only Admins turn Response Actions on and off, each change in the Organization Audit Log, apart from write-back", async () => {
    const a = await acme();
    const id = await a.addProd();
    const param = { id };
    const set = (as: typeof a.admin, enabled: boolean, on = param) => as.api.integrations[":id"]["response-actions"].$put({ param: on, json: { enabled } });

    expect((await set(a.ana, true)).status).toBe(403);
    expect((await a.integration(id)).responseActions).toBe(false);

    expect((await set(a.admin, true)).status).toBe(200);
    expect(await a.integration(id, a.ana)).toMatchObject({ responseActions: true, writeBack: false });
    expect((await set(a.owner, true)).status).toBe(200);
    expect((await set(a.ana, false)).status).toBe(403);
    expect((await set(a.owner, false)).status).toBe(200);
    expect((await a.integration(id)).responseActions).toBe(false);
    expect((await set(a.admin, true, { id: "nope" })).status).toBe(404);

    expect((await a.orgAudit()).map((e) => [e.action, e.actor.name, e.target, e.before, e.after])).toEqual([
      ["integration.response_actions_disabled", "Olive Owner", "CrowdStrike — Prod", "Response Actions on", "Response Actions off"],
      ["integration.response_actions_enabled", "Adam Admin", "CrowdStrike — Prod", "Response Actions off", "Response Actions on"],
      ["integration.created", "Adam Admin", "CrowdStrike — Prod", null, "CrowdStrike US-1 · client …0001 · read only"],
    ]);
  });

  test("workers stream only from Integrations whose Provider sends Alerts", async () => {
    const a = await acme();
    await a.addProd();
    const mail = await a.addProd({ name: "Mail", clientId: "mimecast-app-0003" });
    await a.t.deps.db.execute(sql`UPDATE integrations SET provider = 'mimecast' WHERE id = ${mail}`);
    const w = a.worker();
    await w.tick();
    expect(a.falcon.tenant(CLIENT_ID).opened).toHaveLength(1);
    expect(a.falcon.tenant("mimecast-app-0003").opened).toHaveLength(0);
    expect(await a.integration(mail)).toMatchObject({
      provider: "mimecast",
      capabilities: { receivesAlerts: false, writesBack: false, responseActions: true },
      workerId: null,
    });
    const param = { id: mail };
    expect((await a.admin.api.integrations[":id"]["write-back"].$put({ param, json: { enabled: true } })).status).toBe(422);
    expect((await a.admin.api.integrations[":id"]["response-actions"].$put({ param, json: { enabled: true } })).status).toBe(200);
  });
});

describe("Event Streams ingest", () => {
  test("endpoint, identity and mobile detections become Alerts with Status New; other events are skipped", async () => {
    const a = await acme();
    const id = await a.addProd();
    const stream = a.falcon.tenant(CLIENT_ID);
    await a.worker().tick();
    stream.detection("EppDetectionSummaryEvent", "ldt:8c4f:41", {
      Name: "Encoded PowerShell from Office process",
      SeverityName: "Critical",
      Hostname: "FIN-LT-0231",
      UserName: "d.howe",
    });
    stream.emit("AuthActivityAuditEvent", { OperationName: "userAuthenticate" });
    stream.detection("IdpDetectionSummaryEvent", "ind:a1e0:07", { Name: "Unusual sign-in location", Severity: 50, UserName: "d.howe" });
    stream.detection("MobileDetectionSummaryEvent", "mob:33bd:02", { Name: "Sideloaded mobile app", Severity: 3, ComputerName: "iPhone-MC" });
    await stream.drained();

    const alerts = await a.queue();
    expect(alerts.map((x) => [x.externalId, x.kind, x.status, x.severity, x.title, x.host, x.userName])).toEqual([
      ["mob:33bd:02", "mobile", "new", "medium", "Sideloaded mobile app", "iPhone-MC", null],
      ["ind:a1e0:07", "idp", "new", "medium", "Unusual sign-in location", null, "d.howe"],
      ["ldt:8c4f:41", "epp", "new", "critical", "Encoded PowerShell from Office process", "FIN-LT-0231", "d.howe"],
    ]);
    expect(alerts[0]!.integration).toEqual({ id, name: "CrowdStrike — Prod" });
    expect((await a.integration(id)).streamOffset).toBe(3);
  });

  test("a detection delivered again updates its Alert instead of adding another", async () => {
    const a = await acme();
    await a.addProd();
    const stream = a.falcon.tenant(CLIENT_ID);
    await a.worker().tick();
    stream.detection("EppDetectionSummaryEvent", "ldt:8c4f:41", { Name: "Credential dumping attempt", SeverityName: "High" });
    stream.detection("EppDetectionSummaryEvent", "ldt:8c4f:41", { Name: "Credential dumping attempt", SeverityName: "High" });
    await stream.drained();
    expect((await a.queue()).map((x) => [x.severity, x.version])).toEqual([["high", 1]]);

    stream.detection("EppDetectionSummaryEvent", "ldt:8c4f:41", { Name: "Credential dumping attempt", SeverityName: "Critical" });
    await stream.drained();
    expect((await a.queue()).map((x) => [x.severity, x.version])).toEqual([["critical", 2]]);
  });

  test("an event the worker already processed is not processed again when Falcon replays it", async () => {
    const a = await acme();
    const id = await a.addProd();
    const stream = a.falcon.tenant(CLIENT_ID);
    const w = a.worker();
    await w.tick();
    stream.detection("EppDetectionSummaryEvent", "ldt:1", { Name: "One", SeverityName: "Low" });
    await stream.drained();
    const processedAt = a.t.clock.now().toISOString();

    stream.drop();
    await stream.drained();
    a.t.clock.advance(MINUTE);
    stream.replayFrom = 0;
    await w.tick();
    await stream.drained();
    expect(stream.readsFrom).toEqual([0, 1]);
    expect((await a.queue()).map((x) => [x.externalId, x.version])).toEqual([["ldt:1", 1]]);
    expect(await a.integration(id)).toMatchObject({ streamOffset: 0, lastEventAt: processedAt });
  });

  test("on reconnecting after a drop the worker resumes from the stored offset", async () => {
    const a = await acme();
    const id = await a.addProd();
    const stream = a.falcon.tenant(CLIENT_ID);
    const w = a.worker();
    await w.tick();
    stream.detection("EppDetectionSummaryEvent", "ldt:1", { Name: "One" });
    stream.detection("EppDetectionSummaryEvent", "ldt:2", { Name: "Two" });
    await stream.drained();

    stream.drop();
    await stream.drained();
    expect(await a.integration(id)).toMatchObject({ health: "disconnected" });
    stream.detection("EppDetectionSummaryEvent", "ldt:3", { Name: "Three" });
    await w.tick();
    await stream.drained();

    expect(stream.readsFrom).toEqual([0, 2]);
    expect((await a.queue()).map((x) => x.externalId)).toEqual(["ldt:3", "ldt:2", "ldt:1"]);
    expect(await a.integration(id)).toMatchObject({ health: "connected", streamOffset: 2 });
    expect(await a.orgAudit()).toHaveLength(1);
  });

  test("a gap Falcon can no longer replay is recorded in the Organization Audit Log and not backfilled", async () => {
    const a = await acme();
    const id = await a.addProd();
    const stream = a.falcon.tenant(CLIENT_ID);
    const w = a.worker();
    await w.tick();
    stream.detection("EppDetectionSummaryEvent", "ldt:0", { Name: "Before" });
    stream.detection("EppDetectionSummaryEvent", "ldt:1", { Name: "Before too" });
    await stream.drained();
    stream.drop();
    await stream.drained();

    // While disconnected, two detections arrive and age out of Falcon's replay window.
    stream.detection("EppDetectionSummaryEvent", "ldt:2", { Name: "Lost" });
    const lost = stream.detection("EppDetectionSummaryEvent", "ldt:3", { Name: "Lost too" });
    stream.detection("EppDetectionSummaryEvent", "ldt:4", { Name: "After" });
    stream.forgetThrough(lost);
    await w.tick();
    await stream.drained();

    expect((await a.queue()).map((x) => x.externalId)).toEqual(["ldt:4", "ldt:1", "ldt:0"]);
    const [gap] = await a.orgAudit();
    expect(gap).toMatchObject({
      action: "integration.stream_gap",
      actor: { type: "system", name: "System" },
      target: "CrowdStrike — Prod",
      before: "offset 1",
      after: "offset 4",
    });
    expect((await a.integration(id)).lastGap).toMatchObject({ fromOffset: 2, toOffset: 3, at: a.t.clock.now().toISOString() });
  });

  test("the stream session is refreshed before Falcon's 30-minute expiry, again and again", async () => {
    const a = await acme();
    const id = await a.addProd();
    const stream = a.falcon.tenant(CLIENT_ID);
    const w = a.worker();
    await w.tick();
    const opened = a.t.clock.now().getTime();
    expect(Date.parse((await a.integration(id)).sessionRefreshAt!) - opened).toBeLessThan(30 * MINUTE);

    a.t.clock.advance(20 * MINUTE);
    await w.tick();
    expect(stream.refreshes).toBe(0);
    a.t.clock.advance(6 * MINUTE);
    await w.tick();
    expect(stream.refreshes).toBe(1);
    a.t.clock.advance(26 * MINUTE);
    await w.tick();
    expect(stream.refreshes).toBe(2);
    expect(stream.opened).toHaveLength(1);
    expect(Date.parse((await a.integration(id)).sessionRefreshAt!)).toBeGreaterThan(a.t.clock.now().getTime());
  });

  test("a session that can't be refreshed is reopened, resuming from the stored offset", async () => {
    const a = await acme();
    const id = await a.addProd();
    const stream = a.falcon.tenant(CLIENT_ID);
    const w = a.worker();
    await w.tick();
    stream.detection("EppDetectionSummaryEvent", "ldt:0", { Name: "One" });
    await stream.drained();
    stream.refuseRefresh = "session expired";
    a.t.clock.advance(26 * MINUTE);
    await w.tick();
    expect(await a.integration(id)).toMatchObject({ health: "error" });
    expect(stream.connections).toBe(0);
    stream.refuseRefresh = null;
    await w.tick();
    expect(stream.readsFrom).toEqual([0, 1]);
    expect(await a.integration(id)).toMatchObject({ health: "connected" });
  });
});

describe("Owning a stream", () => {
  test("exactly one worker holds each Integration's stream; another takes over when it lets go", async () => {
    const a = await acme();
    const id = await a.addProd();
    const stream = a.falcon.tenant(CLIENT_ID);
    const one = a.worker("worker-1");
    const two = a.worker("worker-2");
    await one.tick();
    await two.tick();
    await one.tick();
    expect(stream.opened).toHaveLength(1);
    expect(stream.connections).toBe(1);
    expect((await a.integration(id)).workerId).toBe("worker-1");

    stream.detection("EppDetectionSummaryEvent", "ldt:0", { Name: "One" });
    await stream.drained();
    await one.close();
    expect(stream.connections).toBe(0);
    expect(await a.integration(id)).toMatchObject({ health: "connecting", workerId: null });
    await two.tick();
    stream.detection("EppDetectionSummaryEvent", "ldt:1", { Name: "Two" });
    await stream.drained();

    expect((await a.integration(id)).workerId).toBe("worker-2");
    expect(stream.readsFrom).toEqual([0, 1]);
    expect(await a.queue()).toHaveLength(2);
  });

  test("a paused Integration's stream is let go, and picked up again from the stored offset on resume", async () => {
    const a = await acme();
    const id = await a.addProd();
    const stream = a.falcon.tenant(CLIENT_ID);
    const w = a.worker();
    await w.tick();
    stream.detection("EppDetectionSummaryEvent", "ldt:0", { Name: "One" });
    await stream.drained();

    await a.admin.api.integrations[":id"].pause.$post({ param: { id } });
    await w.tick();
    expect(stream.connections).toBe(0);
    expect(await a.integration(id)).toMatchObject({ paused: true, workerId: null });
    stream.detection("EppDetectionSummaryEvent", "ldt:1", { Name: "Two" });
    expect(await a.queue()).toHaveLength(1);

    await a.admin.api.integrations[":id"].resume.$post({ param: { id } });
    await w.tick();
    await stream.drained();
    expect(stream.readsFrom).toEqual([0, 1]);
    expect(await a.queue()).toHaveLength(2);
  });

  test("after rotating credentials the worker reconnects with the new ones", async () => {
    const a = await acme();
    const id = await a.addProd();
    const w = a.worker();
    await w.tick();
    await a.admin.api.integrations[":id"].credentials.$put({ param: { id }, json: { clientId: "falcon-client-0002", clientSecret: "rotated" } });
    await w.tick();
    expect(a.falcon.tenant(CLIENT_ID).connections).toBe(0);
    expect(a.falcon.tenant("falcon-client-0002").opened).toMatchObject([{ credentials: { clientId: "falcon-client-0002", clientSecret: "rotated" } }]);
  });
});

describe("Integration health", () => {
  test("the Integration shows a healthy stream and the time of the last event", async () => {
    const a = await acme();
    const id = await a.addProd();
    const stream = a.falcon.tenant(CLIENT_ID);
    await a.worker().tick();
    expect(await a.integration(id, a.ana)).toMatchObject({ health: "connected", lastEventAt: null, workerId: "worker-1" });
    a.t.clock.advance(MINUTE);
    stream.detection("EppDetectionSummaryEvent", "ldt:0", { Name: "One" });
    await stream.drained();
    expect(await a.integration(id, a.ana)).toMatchObject({ health: "connected", lastEventAt: a.t.clock.now().toISOString(), streamOffset: 0 });
  });

  test("credentials Falcon refuses show as an error, with Falcon's reason", async () => {
    const a = await acme();
    const id = await a.addProd();
    a.falcon.tenant(CLIENT_ID).refuse = "Signing in to the Falcon API failed: 401 access denied";
    await a.worker().tick();
    expect(await a.integration(id)).toMatchObject({ health: "error", healthDetail: "Signing in to the Falcon API failed: 401 access denied" });
  });
});

describe("The Alert queue", () => {
  test("filters by Status, Severity and Integration", async () => {
    const a = await acme();
    const prod = await a.addProd();
    const lab = await a.addProd({ name: "CrowdStrike — Lab", clientId: "falcon-lab-0009" });
    const w = a.worker();
    await w.tick();
    const p = a.falcon.tenant(CLIENT_ID);
    const l = a.falcon.tenant("falcon-lab-0009");
    p.detection("EppDetectionSummaryEvent", "ldt:p1", { Name: "Prod high", SeverityName: "High" });
    p.detection("EppDetectionSummaryEvent", "ldt:p2", { Name: "Prod low", SeverityName: "Low" });
    l.detection("EppDetectionSummaryEvent", "ldt:l1", { Name: "Lab high", SeverityName: "High" });
    await p.drained();
    await l.drained();

    const titles = async (query: Parameters<typeof a.queue>[1]) => (await a.queue(a.ana, query)).map((x) => x.title).toSorted();
    expect(await titles({})).toEqual(["Lab high", "Prod high", "Prod low"]);
    expect(await titles({ severity: "high" })).toEqual(["Lab high", "Prod high"]);
    expect(await titles({ integration: prod })).toEqual(["Prod high", "Prod low"]);
    expect(await titles({ integration: lab, severity: "low" })).toEqual([]);
    expect(await titles({ status: "new" })).toEqual(["Lab high", "Prod high", "Prod low"]);
    expect(await titles({ status: "dismissed" })).toEqual([]);
  });

  test("another Organization's Alerts are not in the queue", async () => {
    const a = await acme();
    await a.addProd();
    await a.worker().tick();
    a.falcon.tenant(CLIENT_ID).detection("EppDetectionSummaryEvent", "ldt:0", { Name: "Ours" });
    await a.falcon.tenant(CLIENT_ID).drained();

    await a.t.inviteOwner("Globex", "owner@globex.example");
    const globex = await a.t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    expect(await a.queue(globex)).toEqual([]);
    expect(await a.integrations(globex)).toEqual([]);
    expect((await globex.api.integrations[":id"].pause.$post({ param: { id: (await a.integrations())[0]!.id } })).status).toBe(404);
  });

  test("new Alerts and Integration changes reach Members' live sockets", async () => {
    const a = await acme();
    await a.addProd();
    const socket = await a.t.connect(a.ana);
    await a.worker().tick();
    await socket.next((m) => m.type === "alerts");
    a.falcon.tenant(CLIENT_ID).detection("EppDetectionSummaryEvent", "ldt:0", { Name: "Live" });
    await socket.next((m) => m.type === "alerts");
  });

  test("Alerts and Integrations are never deleted", async () => {
    const a = await acme();
    await a.addProd();
    await a.worker().tick();
    a.falcon.tenant(CLIENT_ID).detection("EppDetectionSummaryEvent", "ldt:0", { Name: "Kept" });
    await a.falcon.tenant(CLIENT_ID).drained();
    const fails = async (query: ReturnType<typeof sql>) => {
      try {
        await a.t.deps.db.execute(query);
        return false;
      } catch {
        return true;
      }
    };
    expect(await fails(sql`DELETE FROM alerts`)).toBe(true);
    expect(await fails(sql`DELETE FROM integrations`)).toBe(true);
  });
});
