import { describe, expect, test } from "bun:test";
import { createResponseActionSender, MAX_RESPONSE_ACTION_ATTEMPTS } from "./response-actions/sender";
import { fakeFalcon } from "./test/fake-falcon";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const CLIENT_ID = "falcon-client-0001";
const COUNSEL = "k.patel@lawfirm.example";
const SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security: its Owner and Ana (an Analyst), a CrowdStrike Integration with Response Actions on,
 * a High Case opened by Ana with outside counsel on it as a Guest, and a Response Action sender on a
 * fake Falcon.
 */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", "owner@acme.example");
  const owner = await t.acceptInvite("owner@acme.example", PASSWORD, "Olive Owner");
  await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
  const ana = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
  type Session = typeof ana;

  const res = await owner.api.integrations.$post({
    json: { name: "CrowdStrike — Prod", cloud: "us-1", clientId: CLIENT_ID, clientSecret: "falcon-secret", responseActions: true },
  });
  const added = await res.json();
  if (!("integration" in added)) throw new Error(`Could not add an Integration: ${res.status}`);
  const integrationId = added.integration.id;

  const opened = await (await ana.api.cases.$post({ json: { title: "Phishing at Acme", caseType: "phishing", severity: "high" } })).json();
  if (!("case" in opened)) throw new Error("Could not open a Case");
  const number = opened.case.number;
  await owner.api.cases[":number"].guests.$post({ param: param(number), json: { email: COUNSEL, name: "Kim Patel" } });
  const guest = await t.guestSignIn(COUNSEL);

  const falcon = fakeFalcon();
  const tenant = falcon.tenant(CLIENT_ID);
  const worker = createResponseActionSender(t.deps, { connect: falcon.connect });

  /** Runs an action from the Action Center as `as`; returns the status and body. */
  const run = async (as: Session, json: Parameters<Session["api"]["action-center"]["run"]["$post"]>[0]["json"]) => {
    const r = await as.api["action-center"].run.$post({ json });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> & { values?: { value: string; outcome: string; detail: string | null }[]; responseActionIds?: string[] } };
  };
  const log = async (as: Session, query: Record<string, string> = {}) => {
    const body = await (await as.api["action-log"].$get({ query })).json();
    if (!("entries" in body)) throw new Error("Could not read the Action Log");
    return body.entries;
  };
  const caseActions = async (on = number) => {
    const body = await (await ana.api.cases[":number"]["response-actions"].$get({ param: param(on) })).json();
    if (!("responseActions" in body)) throw new Error("Could not list Response Actions");
    return body.responseActions;
  };
  const openCase = async (title: string, restricted = false) => {
    const body = await (await owner.api.cases.$post({ json: { title, caseType: "malware", severity: "medium" } })).json();
    if (!("case" in body)) throw new Error("Could not open a Case");
    if (restricted) await owner.api.cases[":number"].$patch({ param: param(body.case.number), json: { restricted: true } });
    return body.case.number;
  };
  return { t, owner, ana, guest, integrationId, number, tenant, worker, run, log, caseActions, openCase };
}

describe("Action Center", () => {
  test("lists every action, saying which can run now and why the rest can't", async () => {
    const a = await acme();
    const body = await (await a.ana.api["action-center"].$get()).json();
    if (!("actions" in body)) throw new Error("No catalogue");
    const card = (action: string, through?: string) => body.actions.find((c) => c.action === action && (!through || c.through.includes(through)))!;
    expect(card("detect")).toMatchObject({ status: "ready", integration: { id: a.integrationId }, group: "respond", accepts: ["sha256", "md5", "domain", "ip"] });
    expect(card("block_sender")).toMatchObject({ status: "unconfigured", integration: null, statusText: "No Mimecast Integration" });
    expect(card("contain")).toMatchObject({ status: "off", statusText: "Host containment off" });
    expect(card("lift_containment")).toMatchObject({ status: "admin_only", adminOnly: true });
    expect(card("ip_lookup")).toMatchObject({ status: "unconfigured" });
    expect(card("hash_lookup")).toMatchObject({ status: "no_key" });
    expect(card("mark_important")).toMatchObject({ status: "ready" });
    expect(card("ignore")).toMatchObject({ status: "admin_only" });
    const asOwner = await (await a.owner.api["action-center"].$get()).json();
    if (!("actions" in asOwner)) throw new Error("No catalogue");
    expect(asOwner.actions.find((c) => c.action === "ignore")).toMatchObject({ status: "ready" });
  });

  test("Guests have no Action Center or Action Log", async () => {
    const a = await acme();
    expect((await a.guest.api["action-center"].$get()).status as number).toBe(403);
    expect((await a.guest.api["action-log"].$get({ query: {} })).status as number).toBe(403);
    expect((await a.guest.api["action-center"].run.$post({ json: { action: "mark_important", text: "invoice-portal.biz" } })).status as number).toBe(403);
  });

  test("takes a Response Action with no Case: it needs a reason, the tool is sent the reason, and the Organization Audit Log records it", async () => {
    const a = await acme();
    const refused = await a.run(a.ana, { action: "detect", text: `bad: 185.220.101[.]4 and ${SHA256}`, integrationIds: [a.integrationId] });
    expect(refused.status).toBe(400);

    const taken = await a.run(a.ana, {
      action: "detect",
      text: `bad: 185.220.101[.]4, hxxps://invoice-portal[.]biz/x and ${SHA256}`,
      integrationIds: [a.integrationId],
      reason: "Reported by 14 users",
    });
    expect(taken.status).toBe(200);
    expect(taken.body.values!.map((v) => [v.value, v.outcome])).toEqual([
      ["https://invoice-portal.biz/x", "skipped"],
      ["185.220.101.4", "taken"],
      ["invoice-portal.biz", "taken"],
      [SHA256, "taken"],
    ]);
    expect(taken.body.responseActionIds).toHaveLength(3);

    await a.worker.tick();
    const sent = a.tenant.iocsCreated.map((i) => [i.value, i.severity, i.description.split("\n")[0]]);
    expect(sent).toContainEqual(["185.220.101.4", "high", "Argus: Reported by 14 users"]);
    expect(a.tenant.iocsCreated[0]!.description).toContain("/actions/log");

    const entries = await a.log(a.ana);
    expect(entries.filter((e) => e.action === "response_action").map((e) => [e.label, e.value.value, e.state, e.case, e.source, e.by.name])).toEqual([
      ["IOC alert", SHA256, "active", null, "action_center", "Ana Analyst"],
      ["IOC alert", "invoice-portal.biz", "active", null, "action_center", "Ana Analyst"],
      ["IOC alert", "185.220.101.4", "active", null, "action_center", "Ana Analyst"],
    ]);
    expect(entries[0]!.responseAction).toMatchObject({ removable: true, retryable: false, reason: "Reported by 14 users" });

    const audit = await (await a.owner.api.organization["audit-log"].$get({ query: { category: "response-actions" } })).json();
    if (!("entries" in audit)) throw new Error("No Organization Audit Log");
    expect(audit.entries.map((e: { action: string }) => e.action)).toContain("response_action.requested");
    expect(audit.entries.map((e: { action: string }) => e.action)).toContain("response_action.sent");
  });

  test("taken with a Case, each value is linked to it and the Case records it", async () => {
    const a = await acme();
    const taken = await a.run(a.ana, { action: "detect", text: "invoice-portal.biz", integrationIds: [a.integrationId], caseNumber: a.number });
    expect(taken.status).toBe(200);
    expect(taken.body.case).toMatchObject({ number: a.number });
    const onCase = await a.caseActions();
    expect(onCase.map((r) => [r.observable?.value, r.state])).toEqual([["invoice-portal.biz", "pending"]]);
    const [entry] = await a.log(a.ana, { link: "linked" });
    expect(entry).toMatchObject({ label: "IOC alert", case: { number: a.number }, source: "action_center", responseAction: { removable: false } });
    expect(await a.log(a.ana, { link: "unlinked" })).toEqual([]);
  });

  test("removes and retries a Response Action with no Case from the Action Log, and links it to a Case for good", async () => {
    const a = await acme();
    await a.run(a.ana, { action: "detect", text: "invoice-portal.biz", integrationIds: [a.integrationId], reason: "Seen in a bulletin" });
    a.tenant.refuseIocs = "Falcon refused it";
    for (let i = 0; i < MAX_RESPONSE_ACTION_ATTEMPTS; i++) {
      a.t.clock.advance(60 * 60_000);
      await a.worker.tick();
    }
    let [entry] = await a.log(a.ana);
    expect(entry).toMatchObject({ state: "failed", detail: "Falcon refused it", responseAction: { retryable: true } });

    a.tenant.refuseIocs = null;
    expect((await a.ana.api["action-log"][":id"].retry.$post({ param: { id: entry!.id } })).status).toBe(200);
    await a.worker.tick();
    [entry] = await a.log(a.ana);
    expect(entry).toMatchObject({ state: "active" });

    const linked = await a.ana.api["action-log"][":id"].link.$post({ param: { id: entry!.id }, json: { caseNumber: a.number } });
    expect(linked.status).toBe(200);
    [entry] = await a.log(a.ana);
    expect(entry).toMatchObject({ case: { number: a.number }, responseAction: { removable: false } });
    expect((await a.ana.api["action-log"][":id"].link.$post({ param: { id: entry!.id }, json: { caseNumber: a.number } })).status).toBe(409);
    expect((await a.ana.api["action-log"][":id"].remove.$post({ param: { id: entry!.id }, json: {} })).status).toBe(404);

    const onCase = await a.caseActions();
    expect(onCase.map((r) => [r.observable?.value, r.state])).toEqual([["invoice-portal.biz", "active"]]);
    const timeline = await (await a.ana.api.cases[":number"].timeline.$get({ param: param(a.number) })).json();
    if (!("entries" in timeline)) throw new Error("No Timeline");
    expect(timeline.entries.some((e: { body: string }) => e.body.includes("linked to this Case by Ana Analyst") && e.body.includes("Seen in a bulletin"))).toBe(true);
  });

  test("removing a Response Action with no Case deletes it in the tool", async () => {
    const a = await acme();
    await a.run(a.ana, { action: "detect", text: "invoice-portal.biz", integrationIds: [a.integrationId], reason: "Bulletin" });
    await a.worker.tick();
    const [entry] = await a.log(a.ana);
    expect((await a.ana.api["action-log"][":id"].remove.$post({ param: { id: entry!.id }, json: {} })).status).toBe(200);
    await a.worker.tick();
    expect(a.tenant.iocsDeleted).toHaveLength(1);
    expect((await a.log(a.ana))[0]).toMatchObject({ state: "removed" });
  });

  test("a value sent from the Action Center is already present for a Case, and the other way round", async () => {
    const a = await acme();
    await a.run(a.ana, { action: "detect", text: "invoice-portal.biz", integrationIds: [a.integrationId], reason: "Bulletin" });
    await a.run(a.ana, { action: "detect", text: "invoice-portal.biz", integrationIds: [a.integrationId], caseNumber: a.number });
    const [onCase] = await a.caseActions();
    expect(onCase).toMatchObject({ origin: "already_present", state: "active" });
    await a.worker.tick();
    expect(a.tenant.iocsCreated).toHaveLength(1);
  });

  test("marks values Important, logging each, and only Admins Ignore", async () => {
    const a = await acme();
    const marked = await a.run(a.ana, { action: "mark_important", text: "invoice-portal.biz\ninvoice-portal.biz\n10.0.0.1" });
    expect(marked.body.values!.map((v) => [v.value, v.outcome])).toEqual([
      ["invoice-portal.biz", "done"],
      ["10.0.0.1", "done"],
    ]);
    const again = await a.run(a.ana, { action: "mark_important", text: "invoice-portal.biz" });
    expect(again.body.values![0]).toMatchObject({ outcome: "unchanged" });
    expect((await a.run(a.ana, { action: "ignore", text: "invoice-portal.biz" })).status).toBe(403);
    expect((await a.run(a.owner, { action: "ignore", text: "invoice-portal.biz" })).status).toBe(200);

    // Marks made elsewhere are logged too.
    await a.ana.api.observables.important.$post({ json: { type: "domain", value: "other-portal.org", important: true } });
    const entries = await a.log(a.ana, { group: "mark" });
    expect(entries.map((e) => [e.label, e.value.value, e.state, e.source])).toEqual([
      ["Mark Important", "other-portal.org", "done", "elsewhere"],
      ["Ignore", "invoice-portal.biz", "done", "action_center"],
      ["Mark Important", "invoice-portal.biz", "unchanged", "action_center"],
      ["Mark Important", "10.0.0.1", "done", "action_center"],
      ["Mark Important", "invoice-portal.biz", "done", "action_center"],
    ]);
  });

  test("logs a lookup run from the Action Center, and how it went", async () => {
    const a = await acme();
    const looked = await a.run(a.ana, { action: "ip_lookup", text: "8.8.8.8 and 10.1.2.3", caseNumber: a.number });
    expect(looked.body.values!.map((v) => [v.value, v.outcome])).toEqual([
      ["8.8.8.8", "failed"],
      ["10.1.2.3", "done"],
    ]);
    const entries = await a.log(a.ana, { group: "lookup" });
    expect(entries.map((e) => [e.label, e.value.value, e.state, e.case?.number])).toEqual([
      ["IP details", "10.1.2.3", "done", a.number],
      ["IP details", "8.8.8.8", "failed", a.number],
    ]);
    expect(entries[1]!.detail).toBe("The Organization has no IPinfo Integration");
  });

  test("leaves out runs on Cases the reader can't see", async () => {
    const a = await acme();
    const hidden = await a.openCase("Insider at Acme", true);
    await a.run(a.owner, { action: "mark_important", text: "insider-share.net", caseNumber: hidden });
    await a.run(a.owner, { action: "mark_important", text: "public-site.com" });
    expect((await a.log(a.ana)).map((e) => e.value.value)).toEqual(["public-site.com"]);
    expect((await a.log(a.owner)).map((e) => e.value.value)).toEqual(["public-site.com", "insider-share.net"]);
  });

  test("Response Actions taken from a Case's own menu are logged as from the Case", async () => {
    const a = await acme();
    const linked = await (await a.ana.api.cases[":number"].observables.$post({ param: param(a.number), json: { type: "md5", value: "44d88612fea8a8f36de82e1278abb02f" } })).json();
    if (!("observable" in linked)) throw new Error("Could not link");
    await a.ana.api.cases[":number"]["response-actions"].$post({
      param: param(a.number),
      json: { observableId: linked.observable.id, integrationId: a.integrationId, action: "prevent" },
    });
    const [entry] = await a.log(a.ana);
    expect(entry).toMatchObject({ label: "IOC block", source: "case", case: { number: a.number }, state: "pending" });
  });
});
