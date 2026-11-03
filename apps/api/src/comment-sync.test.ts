import { describe, expect, test } from "bun:test";
import { COMMENT_REFRESH_INTERVAL_MS, createCommentSyncer } from "./crowdstrike/comment-sync";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import { createWriteBackSender } from "./crowdstrike/write-back";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const COUNSEL = "kim@lawfirm.example";
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security with its Owner and an Analyst, a CrowdStrike Integration (write-back on unless
 * `writeBack` is false), and a worker reading its stream, sending write-backs and fetching comments,
 * all on a fake Falcon.
 */
async function acme({ writeBack = true }: { writeBack?: boolean } = {}) {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Session = ReturnType<typeof t.session>;

  await owner.api.integrations.$post({
    json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret", writeBack },
  });
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const tenant = falcon.tenant(CLIENT_ID);
  /** A worker's comment syncer; a new one is a worker started afresh. */
  const syncer = () => createCommentSyncer(t.deps, { connect: falcon.connect });
  const comments = syncer();
  const writeBacks = createWriteBackSender(t.deps, { connect: falcon.connect });

  const detect = async (...compositeIds: string[]) => {
    for (const id of compositeIds) tenant.detection("EppDetectionSummaryEvent", id, { Name: `Detection ${id}`, SeverityName: "High" });
    await tenant.drained();
  };
  /** Falcon reports a change to the Alerts, as when a comment is added in the console. */
  const falconUpdate = async (...compositeIds: string[]) => {
    tenant.emit("UserActivityAuditEvent", {
      OperationName: "detection_update",
      UserId: "jsmith@acme.example",
      UTCTimestamp: 1_800_000_000,
      AuditKeyValues: compositeIds.map((id) => ({ Key: "composite_id", ValueString: id })),
    });
    await tenant.drained();
  };
  const select = async (...compositeIds: string[]) => {
    const body = await (await ana.api.alerts.$get({ query: {} })).json();
    if (!("alerts" in body)) throw new Error("Could not list Alerts");
    return compositeIds.map((id) => {
      const found = body.alerts.find((a) => a.externalId === id);
      if (!found) throw new Error(`No Alert ${id}`);
      return { id: found.id, version: found.version };
    });
  };
  const openFrom = async (...compositeIds: string[]) => {
    const res = await ana.api.alerts.cases.$post({
      json: { title: "Credential theft on FIN-LT-0231", caseType: "malware", alerts: await select(...compositeIds) },
    });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case.number;
  };
  const open = async () => {
    const body = await (await ana.api.cases.$post({ json: { title: "Lateral movement", caseType: "malware", severity: "high" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    return body.case.number;
  };
  /** The Alert's page, as `as` opens it. */
  const alert = async (compositeId: string, as: Session = ana) => {
    const [selected] = await select(compositeId);
    const body = await (await as.api.alerts[":id"].$get({ param: { id: selected!.id } })).json();
    if (!("alert" in body)) throw new Error("Could not open the Alert");
    return body.alert;
  };
  const discussion = async (number: number, as: Session = ana) => {
    const body = await (await as.api.cases[":number"].discussion.$get({ param: param(number) })).json();
    if (!("messages" in body)) throw new Error("Could not read the Discussion");
    return body.messages;
  };
  const auditLog = async (number: number) => {
    const body = await (await owner.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };
  return { t, owner, ana, tenant, syncer, comments, writeBacks, detect, falconUpdate, select, openFrom, open, alert, discussion, auditLog };
}

describe("Falcon comments in the Discussion", () => {
  test("when Falcon reports an update, the Alert's comments join its Case's Discussion, Internal and attributed to CrowdStrike", async () => {
    const a = await acme();
    await a.detect("ldt:1");
    const number = await a.openFrom("ldt:1");
    await a.comments.tick();
    expect(await a.discussion(number)).toEqual([]);

    a.tenant.comment("ldt:1", "Isolated the host from the console.", { id: "c-1", at: new Date("2026-01-01T08:00:00Z") });
    await a.falconUpdate("ldt:1");
    // Fetched by the worker, not by the stream.
    expect(await a.discussion(number)).toEqual([]);
    await a.comments.tick();

    const alertId = (await a.select("ldt:1"))[0]!.id;
    expect(await a.discussion(number)).toEqual([
      {
        id: expect.any(String),
        author: { id: null, name: "CrowdStrike: jsmith@acme.example" },
        falcon: { alertId },
        body: "Isolated the host from the console.",
        mentions: [],
        postedAt: expect.any(String),
        editedAt: null,
        retractedAt: null,
        internal: true,
        can: { edit: false, retract: false },
      },
    ]);
    expect((await a.auditLog(number)).find((e) => e.action === "discussion.message_posted")).toMatchObject({
      actor: { type: "crowdstrike", id: null, name: "CrowdStrike (Falcon: jsmith@acme.example)" },
      target: "Internal · from Detection ldt:1 (ldt:1)",
      after: "Isolated the host from the console.",
    });
  });

  test("comments are de-duplicated by their identity in Falcon, however often they are fetched and by whichever worker", async () => {
    const a = await acme();
    await a.detect("ldt:1");
    const number = await a.openFrom("ldt:1");
    a.tenant.comment("ldt:1", "Isolated.", { id: "c-1" });
    a.tenant.comment("ldt:1", "Isolated.", { id: "c-2", author: "mlee@acme.example" });
    await a.falconUpdate("ldt:1");
    await a.comments.tick();
    await a.falconUpdate("ldt:1");
    await a.syncer().tick();
    a.tenant.comment("ldt:1", "Reimaging tomorrow.", { id: "c-3" });
    await a.falconUpdate("ldt:1");
    await Promise.all([a.comments.tick(), a.syncer().tick()]);

    expect((await a.discussion(number)).map((m) => [m.author.name, m.body])).toEqual([
      ["CrowdStrike: jsmith@acme.example", "Isolated."],
      ["CrowdStrike: mlee@acme.example", "Isolated."],
      ["CrowdStrike: jsmith@acme.example", "Reimaging tomorrow."],
    ]);
    expect(a.tenant.commentReads).toEqual(["ldt:1", "ldt:1", "ldt:1"]);
  });

  test("opening an Alert asks for a refresh without waiting for Falcon; the worker fetches its comments", async () => {
    const a = await acme();
    await a.detect("ldt:1");
    a.tenant.comment("ldt:1", "Looks like the Patch Tuesday script.", { id: "c-1" });

    const opened = await a.alert("ldt:1");
    expect(opened.falconComments).toEqual({ refreshing: true, syncedAt: null, error: null, comments: [] });
    expect(a.tenant.commentReads).toEqual([]);

    await a.comments.tick();
    expect((await a.alert("ldt:1")).falconComments).toEqual({
      refreshing: false,
      syncedAt: expect.any(String),
      error: null,
      comments: [{ id: expect.any(String), author: "jsmith@acme.example", body: "Looks like the Patch Tuesday script.", createdAt: null }],
    });

    // Opened again soon after, it isn't fetched again; a while later, it is.
    await a.alert("ldt:1");
    await a.comments.tick();
    expect(a.tenant.commentReads).toEqual(["ldt:1"]);
    a.t.clock.advance(COMMENT_REFRESH_INTERVAL_MS + 1);
    expect((await a.alert("ldt:1")).falconComments.refreshing).toBe(true);
    await a.comments.tick();
    expect(a.tenant.commentReads).toEqual(["ldt:1", "ldt:1"]);
  });

  test("opening a Case asks for its Alerts' comments", async () => {
    const a = await acme();
    await a.detect("ldt:1", "ldt:2", "ldt:3");
    const number = await a.openFrom("ldt:1", "ldt:2");
    await a.comments.tick();
    a.tenant.comment("ldt:2", "Same user as last week.", { id: "c-1" });
    a.t.clock.advance(COMMENT_REFRESH_INTERVAL_MS + 1);

    expect((await a.ana.api.cases[":number"].$get({ param: param(number) })).status).toBe(200);
    await a.comments.tick();
    expect(a.tenant.commentReads.toSorted()).toEqual(["ldt:1", "ldt:1", "ldt:2", "ldt:2"]);
    expect((await a.discussion(number)).map((m) => m.body)).toEqual(["Same user as last week."]);
  });

  test("comments made before an Alert was attached join the Case when it is; Argus's own write-back comments don't", async () => {
    const a = await acme();
    await a.detect("ldt:1");
    a.tenant.comment("ldt:1", "Escalating to IR.", { id: "c-1" });
    await a.alert("ldt:1");
    await a.comments.tick();

    const number = await a.openFrom("ldt:1");
    await a.writeBacks.tick();
    expect(a.tenant.patches).toHaveLength(1);
    await a.comments.tick();
    expect((await a.discussion(number)).map((m) => m.body)).toEqual(["Escalating to IR."]);
    expect((await a.alert("ldt:1")).falconComments.comments.map((c) => c.body)).toEqual(["Escalating to IR."]);

    // Moved to another Case, the comments follow it there too.
    const other = await a.open();
    await a.ana.api.alerts.attach.$post({ json: { case: other, alerts: await a.select("ldt:1") } });
    await a.writeBacks.tick();
    await a.comments.tick();
    expect((await a.discussion(other)).map((m) => m.body)).toEqual(["Escalating to IR."]);
  });

  test("synced messages are Internal: Guests see them only once a Member shows them", async () => {
    const a = await acme();
    await a.detect("ldt:1");
    const number = await a.openFrom("ldt:1");
    expect((await a.owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel" } })).status).toBe(201);
    const guest = await a.t.guestSignIn(COUNSEL);
    a.tenant.comment("ldt:1", "Host reimaged.", { id: "c-1" });
    await a.falconUpdate("ldt:1");
    await a.comments.tick();

    expect(await a.discussion(number, guest)).toEqual([]);
    const [message] = await a.discussion(number);
    const shown = await a.ana.api.cases[":number"].internal.$put({
      param: param(number),
      json: { item: { kind: "discussion_message", id: message!.id }, internal: false },
    });
    expect(shown.status).toBe(200);
    expect(await a.discussion(number, guest)).toEqual([
      expect.objectContaining({ author: { id: null, name: "CrowdStrike: jsmith@acme.example" }, falcon: { alertId: null }, body: "Host reimaged." }),
    ]);
  });

  test("a failed fetch is reported on the Alert and posts nothing; a later one catches up", async () => {
    const a = await acme({ writeBack: false });
    await a.detect("ldt:1");
    const number = await a.openFrom("ldt:1");
    a.tenant.comment("ldt:1", "Contained.", { id: "c-1" });
    a.tenant.refuseReads = "Reading an Alert's comments from Falcon failed: 403 access denied";
    await a.falconUpdate("ldt:1");
    await a.comments.tick();
    expect((await a.alert("ldt:1")).falconComments).toMatchObject({ refreshing: false, error: "Reading an Alert's comments from Falcon failed: 403 access denied" });
    expect(await a.discussion(number)).toEqual([]);

    a.tenant.refuseReads = null;
    await a.falconUpdate("ldt:1");
    await a.comments.tick();
    expect((await a.alert("ldt:1")).falconComments).toMatchObject({ error: null, comments: [expect.objectContaining({ body: "Contained." })] });
    expect((await a.discussion(number)).map((m) => m.body)).toEqual(["Contained."]);
  });

  test("a Closed Case's Discussion gains no synced comments", async () => {
    const a = await acme({ writeBack: false });
    await a.detect("ldt:1");
    const number = await a.openFrom("ldt:1");
    expect((await a.ana.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "true_positive" } })).status).toBe(200);
    a.tenant.comment("ldt:1", "Closed in Falcon too.", { id: "c-1" });
    await a.falconUpdate("ldt:1");
    await a.comments.tick();
    expect(await a.discussion(number)).toEqual([]);
    expect((await a.alert("ldt:1")).falconComments.comments).toHaveLength(1);
  });
});
