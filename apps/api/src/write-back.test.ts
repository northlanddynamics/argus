import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createStreamWorker } from "./crowdstrike/stream-worker";
import { createWriteBackSender, MAX_WRITE_BACK_ATTEMPTS } from "./crowdstrike/write-back";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security with its Owner and an Analyst, a CrowdStrike Integration with write-back on (unless
 * `writeBack` is false), a worker reading its stream and a write-back sender, both on a fake Falcon.
 */
async function acme({ writeBack = true }: { writeBack?: boolean } = {}) {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Member = typeof owner;

  const added = await owner.api.integrations.$post({
    json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret", writeBack },
  });
  const addedBody = await added.json();
  if (!("integration" in addedBody)) throw new Error(`Could not add an Integration: ${added.status}`);
  const integrationId = addedBody.integration.id;
  const falcon = fakeFalcon();
  const worker = createStreamWorker(t.deps, { connect: falcon.connect, workerId: "worker-1" });
  t.onCleanup(worker.close);
  await worker.tick();
  const tenant = falcon.tenant(CLIENT_ID);
  /** A worker's write-back sender; a new one is a worker started afresh. */
  const sender = () => createWriteBackSender(t.deps, { connect: falcon.connect });
  const writeBacks = sender();

  const detect = async (...compositeIds: string[]) => {
    for (const id of compositeIds) tenant.detection("EppDetectionSummaryEvent", id, { Name: `Detection ${id}`, SeverityName: "High" });
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
  const userId = async (as: Member) => {
    const me = await (await as.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  };
  const counts = async () => {
    const body = await (await owner.api.integrations.$get()).json();
    if (!("integrations" in body)) throw new Error("Could not list Integrations");
    return body.integrations.find((i) => i.id === integrationId)!.writeBacks;
  };

  return { t, owner, ana, integrationId, tenant, sender, writeBacks, detect, select, openFrom, userId, counts, param };
}

describe("Writing back to Falcon", () => {
  test("attaching sets the Alerts In Progress in Falcon with a comment linking to the Case", async () => {
    const a = await acme();
    await a.detect("ldt:1", "ldt:2", "ldt:3");
    const number = await a.openFrom("ldt:1", "ldt:2");
    // Queued with the change; nothing is sent until the worker sends it.
    expect(a.tenant.patches).toEqual([]);
    expect(await a.counts()).toMatchObject({ pending: 2, retrying: 0, sent: 0 });

    await a.writeBacks.tick();
    const comment = `Attached to Argus Case C-${number} "Credential theft on FIN-LT-0231": http://argus.test/cases/${number}`;
    expect(a.tenant.patches).toEqual([{ compositeIds: ["ldt:1", "ldt:2"], patch: { status: "in_progress", comment } }]);
    expect(await a.counts()).toMatchObject({ pending: 0, sent: 2 });

    // Attaching to another Case, which moves it, links to that one.
    const other = await a.ana.api.cases.$post({ json: { title: "Lateral movement", caseType: "malware", severity: "high" } });
    const otherBody = await other.json();
    if (!("case" in otherBody)) throw new Error("Could not open a Case");
    await a.ana.api.alerts.attach.$post({ json: { case: otherBody.case.number, alerts: await a.select("ldt:2", "ldt:3") } });
    await a.writeBacks.tick();
    expect(a.tenant.patches[1]).toEqual({
      compositeIds: ["ldt:2", "ldt:3"],
      patch: { status: "in_progress", comment: expect.stringContaining(`Argus Case C-${otherBody.case.number} "Lateral movement"`) },
    });
  });

  test("dismissing closes the Alerts in Falcon with the Dismissal Reason as a comment", async () => {
    const a = await acme();
    await a.detect("ldt:1", "ldt:2");
    await a.ana.api.alerts.dismiss.$post({ json: { alerts: await a.select("ldt:1"), reason: "false_positive", comment: "Patch Tuesday script" } });
    await a.ana.api.alerts.dismiss.$post({ json: { alerts: await a.select("ldt:2"), reason: "benign" } });
    await a.writeBacks.tick();
    expect(a.tenant.patches).toEqual([
      { compositeIds: ["ldt:1"], patch: { status: "closed", comment: "Dismissed in Argus by Ana Analyst: False Positive (Patch Tuesday script)" } },
      { compositeIds: ["ldt:2"], patch: { status: "closed", comment: "Dismissed in Argus by Ana Analyst: Benign" } },
    ]);
  });

  test("closing a Case closes its attached Alerts in Falcon with the Resolution as a comment", async () => {
    const a = await acme();
    await a.detect("ldt:1", "ldt:2", "ldt:3");
    const number = await a.openFrom("ldt:1", "ldt:2");
    await a.writeBacks.tick();
    expect((await a.ana.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "true_positive" } })).status).toBe(200);
    await a.writeBacks.tick();
    expect(a.tenant.patches.slice(1)).toEqual([
      {
        compositeIds: ["ldt:1", "ldt:2"],
        patch: { status: "closed", comment: `Argus Case C-${number} "Credential theft on FIN-LT-0231" was closed by Ana Analyst: True Positive` },
      },
    ]);
  });

  test("a Case closed as a Duplicate of another closes its Alerts in Falcon too", async () => {
    const a = await acme();
    await a.detect("ldt:1", "ldt:2");
    const original = await a.openFrom("ldt:1");
    const duplicate = await a.openFrom("ldt:2");
    await a.writeBacks.tick();
    const linked = await a.ana.api.cases[":number"].links.$post({ param: param(duplicate), json: { type: "duplicate_of", case: original } });
    expect(linked.status).toBe(201);
    await a.writeBacks.tick();
    expect(a.tenant.patches.at(-1)).toEqual({
      compositeIds: ["ldt:2"],
      patch: { status: "closed", comment: expect.stringMatching(/was closed by Ana Analyst: Duplicate$/) },
    });
  });

  test("a Case Assignee change assigns its Alerts to the Falcon user with their email, and is skipped when there is none", async () => {
    const a = await acme();
    a.tenant.users.set("ana@acme.example", "falcon-uuid-ana");
    await a.detect("ldt:1", "ldt:2");
    const number = await a.openFrom("ldt:1", "ldt:2");
    await a.writeBacks.tick();
    const assign = (assigneeId: string | null) => a.owner.api.cases[":number"].$patch({ param: param(number), json: { assigneeId } });

    expect((await assign(await a.userId(a.ana))).status).toBe(200);
    await a.writeBacks.tick();
    expect(a.tenant.patches.at(-1)).toEqual({ compositeIds: ["ldt:1", "ldt:2"], patch: { assignTo: "falcon-uuid-ana" } });

    // No Falcon user is owner@acme.example: nothing is sent, and the Integration says so.
    const sent = a.tenant.patches.length;
    expect((await assign(await a.userId(a.owner))).status).toBe(200);
    await a.writeBacks.tick();
    expect(a.tenant.patches.length).toBe(sent);
    expect(await a.counts()).toMatchObject({ pending: 0, skipped: 2 });

    expect((await assign(null)).status).toBe(200);
    await a.writeBacks.tick();
    expect(a.tenant.patches.at(-1)).toEqual({ compositeIds: ["ldt:1", "ldt:2"], patch: { assignTo: null } });
  });

  test("a failed write-back is retried with backoff, survives a restart, and an Alert's changes still arrive in order", async () => {
    const a = await acme();
    await a.detect("ldt:1");
    const number = await a.openFrom("ldt:1");
    await a.ana.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "benign" } });

    a.tenant.failNextWrites = 2;
    await a.writeBacks.tick();
    expect(a.tenant.patches).toEqual([]);
    expect(await a.counts()).toMatchObject({
      pending: 1,
      retrying: 1,
      nextRetryAt: new Date(a.t.clock.now().getTime() + 30_000).toISOString(),
      lastError: "Updating Alerts in Falcon failed: 503",
    });

    // Not due yet.
    a.t.clock.advance(29_000);
    await a.writeBacks.tick();
    expect(a.tenant.patches).toEqual([]);

    a.t.clock.advance(1_000);
    await a.writeBacks.tick();
    expect(a.tenant.patches).toEqual([]);
    expect(await a.counts()).toMatchObject({ retrying: 1, nextRetryAt: new Date(a.t.clock.now().getTime() + 60_000).toISOString() });

    // The worker restarts: the outbox is in the database, so a new one picks up where it left off.
    a.t.clock.advance(60_000);
    await a.sender().tick();
    expect(a.tenant.patches.map((p) => p.patch.status)).toEqual(["in_progress", "closed"]);
    expect(await a.counts()).toMatchObject({ pending: 0, retrying: 0, sent: 2, lastError: null });
  });

  test("a write-back Falcon keeps refusing is given up on", async () => {
    const a = await acme();
    await a.detect("ldt:1");
    await a.ana.api.alerts.dismiss.$post({ json: { alerts: await a.select("ldt:1"), reason: "benign" } });
    a.tenant.refuseWrites = "Updating Alerts in Falcon failed: 403 access denied";
    for (let i = 0; i < MAX_WRITE_BACK_ATTEMPTS; i++) {
      await a.writeBacks.tick();
      a.t.clock.advance(60 * 60_000);
    }
    expect(await a.counts()).toMatchObject({ pending: 0, retrying: 0, failed: 1 });
    a.tenant.refuseWrites = null;
    await a.writeBacks.tick();
    expect(a.tenant.patches).toEqual([]);
  });

  test("two workers never send the same write-back", async () => {
    const a = await acme();
    await a.detect("ldt:1", "ldt:2", "ldt:3");
    await a.openFrom("ldt:1", "ldt:2", "ldt:3");
    await Promise.all([a.writeBacks.tick(), a.sender().tick()]);
    expect(a.tenant.patches.flatMap((p) => p.compositeIds).toSorted()).toEqual(["ldt:1", "ldt:2", "ldt:3"]);
  });

  test("a read-only Integration sends nothing, and turning write-back off cancels what wasn't sent", async () => {
    const readOnly = await acme({ writeBack: false });
    await readOnly.detect("ldt:1");
    await readOnly.openFrom("ldt:1");
    await readOnly.writeBacks.tick();
    expect(readOnly.tenant.patches).toEqual([]);
    expect(await readOnly.counts()).toMatchObject({ pending: 0, sent: 0 });

    const a = await acme();
    await a.detect("ldt:1");
    await a.openFrom("ldt:1");
    await a.owner.api.integrations[":id"]["write-back"].$put({ param: { id: a.integrationId }, json: { enabled: false } });
    await a.writeBacks.tick();
    expect(a.tenant.patches).toEqual([]);
    expect(await a.counts()).toMatchObject({ pending: 0, sent: 0 });

    // Turned back on, earlier changes stay unsent; later ones go.
    await a.owner.api.integrations[":id"]["write-back"].$put({ param: { id: a.integrationId }, json: { enabled: true } });
    await a.ana.api.cases[":number"].close.$post({ param: param(1), json: { resolution: "benign" } });
    await a.writeBacks.tick();
    expect(a.tenant.patches.map((p) => p.patch.status)).toEqual(["closed"]);
  });

  test("an Integration whose Provider doesn't write back gets no write-backs, and what was queued is cancelled", async () => {
    const a = await acme();
    await a.detect("ldt:1", "ldt:2");
    await a.openFrom("ldt:1");
    // As if its Provider could not write back: queued and new changes are never sent.
    await a.t.deps.db.execute(sql`UPDATE integrations SET provider = 'mimecast', cloud = NULL WHERE id = ${a.integrationId}`);
    await a.ana.api.alerts.dismiss.$post({ json: { alerts: await a.select("ldt:2"), reason: "benign" } });
    await a.writeBacks.tick();
    expect(a.tenant.patches).toEqual([]);
    expect(await a.counts()).toMatchObject({ pending: 0, sent: 0 });
  });

  test("a paused Integration's write-backs wait until it is resumed", async () => {
    const a = await acme();
    await a.detect("ldt:1");
    await a.owner.api.integrations[":id"].pause.$post({ param: { id: a.integrationId } });
    await a.openFrom("ldt:1");
    await a.writeBacks.tick();
    expect(a.tenant.patches).toEqual([]);
    expect(await a.counts()).toMatchObject({ pending: 1 });

    await a.owner.api.integrations[":id"].resume.$post({ param: { id: a.integrationId } });
    await a.writeBacks.tick();
    expect(a.tenant.patches.map((p) => p.compositeIds)).toEqual([["ldt:1"]]);
  });
});
