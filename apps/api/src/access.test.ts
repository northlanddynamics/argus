import { describe, expect, test } from "bun:test";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const EMPTY = { type: "doc" as const, content: [] };
const param = (number: number) => ({ number: String(number) });

/**
 * Acme Security with one Member of each kind:
 * the Owner, an Admin, Ana (an Analyst who will be the Assignee) and Ben (an Analyst who won't).
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
  const ben = await join("ben@acme.example", "analyst", "Ben Analyst");
  type Member = typeof owner;

  const userId = async (as: Member) => {
    const me = await (await as.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    return me.user.id;
  };

  const open = async (as: Member, title = "Departing employee bulk download") => {
    const res = await as.api.cases.$post({ json: { title, caseType: "insider_threat", severity: "high" } });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case.number;
  };

  type Change = Parameters<Member["api"]["cases"][":number"]["$patch"]>[0]["json"];
  const change = async (as: Member, number: number, json: Change) => {
    const res = await as.api.cases[":number"].$patch({ param: param(number), json });
    return { status: res.status, body: await res.json() };
  };

  type ListQuery = Parameters<Member["api"]["cases"]["$get"]>[0]["query"];
  const list = async (as: Member, query: ListQuery = {}) => {
    const body = await (await as.api.cases.$get({ query })).json();
    if (!("cases" in body)) throw new Error("Could not list Cases");
    return body;
  };

  const view = async (as: Member, number: number) => {
    const res = await as.api.cases[":number"].$get({ param: param(number) });
    return { status: res.status, body: await res.json() };
  };

  const auditLog = async (as: Member, number: number) => {
    const body = await (await as.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };

  return { t, owner, admin, ana, ben, userId, open, change, list, view, auditLog };
}

type Acme = Awaited<ReturnType<typeof acme>>;
type ActorName = "owner" | "admin" | "ana" | "ben";

/**
 * Every actor × Restricted or not, on a Case assigned to Ana.
 * An actor who can't see the Case gets exactly what they'd get for a Case that doesn't exist.
 */
describe("Who can see a Case", () => {
  const matrix: { actor: ActorName; who: string; restricted: boolean; sees: boolean }[] = [
    { actor: "owner", who: "the Owner", restricted: false, sees: true },
    { actor: "owner", who: "the Owner", restricted: true, sees: true },
    { actor: "admin", who: "an Admin", restricted: false, sees: true },
    { actor: "admin", who: "an Admin", restricted: true, sees: true },
    { actor: "ana", who: "the Analyst assigned to it", restricted: false, sees: true },
    { actor: "ana", who: "the Analyst assigned to it", restricted: true, sees: true },
    { actor: "ben", who: "an Analyst not assigned to it", restricted: false, sees: true },
    { actor: "ben", who: "an Analyst not assigned to it", restricted: true, sees: false },
  ];

  for (const { actor, who, restricted, sees } of matrix) {
    const kind = restricted ? "a Restricted Case" : "a non-Restricted Case";
    test(`${who} ${sees ? "can" : "cannot"} see and work ${kind}`, async () => {
      const a = await acme();
      const number = await a.open(a.owner);
      await a.change(a.owner, number, { assigneeId: await a.userId(a.ana), restricted });
      const as = a[actor];
      const ok = sees ? 200 : 404;

      // Lists and their counts
      const listed = await a.list(as);
      expect(listed.cases.some((c) => c.number === number)).toBe(sees);
      expect(listed.counts.open).toBe(sees ? 1 : 0);
      expect((await a.list(as, { view: "mine" })).cases.length).toBe(sees && actor === "ana" ? 1 : 0);

      // Direct reads
      const viewed = await a.view(as, number);
      expect(viewed.status).toBe(ok);
      if (sees) expect(viewed.body).toMatchObject({ case: { number, restricted } });
      else expect(viewed.body).toEqual((await a.view(as, 999)).body);
      expect((await as.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).status).toBe(ok);

      // Writes
      expect((await a.change(as, number, { severity: "critical" })).status).toBe(ok);
      const summary = await as.api.cases[":number"].summary.$put({ param: param(number), json: { summary: EMPTY, version: 1 } });
      expect(summary.status).toBe(ok);
      const closed = await as.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "benign" } });
      expect(closed.status).toBe(ok);

      // Nothing an unseeing actor tried reached the Audit Log.
      const actions = (await a.auditLog(a.owner, number)).map((e) => e.action);
      expect(actions.includes("case.severity_changed")).toBe(sees);
      expect(actions.includes("case.closed")).toBe(sees);
    });
  }

  test("an Analyst who can't see a Closed Restricted Case can't learn of it by trying to reopen it", async () => {
    const a = await acme();
    const number = await a.open(a.owner);
    await a.change(a.owner, number, { restricted: true });
    await a.owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "true_positive" } });

    expect((await a.ben.api.cases[":number"].reopen.$post({ param: param(number) })).status).toBe(404);
    expect((await a.ben.api.cases[":number"].reopen.$post({ param: param(999) })).status).toBe(404);
    expect((await a.list(a.ben, { view: "closed" })).cases).toEqual([]);
    expect((await a.list(a.admin, { view: "closed" })).cases.map((c) => c.number)).toEqual([number]);
  });

  test("an Analyst sees a Restricted Case once it's assigned to them, and stops seeing it once it isn't", async () => {
    const a = await acme();
    const number = await a.open(a.owner);
    await a.change(a.owner, number, { restricted: true });
    expect((await a.view(a.ben, number)).status).toBe(404);

    await a.change(a.admin, number, { assigneeId: await a.userId(a.ben) });
    expect((await a.view(a.ben, number)).status).toBe(200);
    expect((await a.list(a.ben, { view: "mine" })).cases.map((c) => c.number)).toEqual([number]);

    await a.change(a.admin, number, { assigneeId: await a.userId(a.ana) });
    expect((await a.view(a.ben, number)).status).toBe(404);
    expect((await a.view(a.ana, number)).status).toBe(200);
  });

  test("an Assignee who hands a Restricted Case to someone else is told it went through, then loses sight of it", async () => {
    const a = await acme();
    const number = await a.open(a.owner);
    await a.change(a.owner, number, { assigneeId: await a.userId(a.ana), restricted: true });

    const handed = await a.change(a.ana, number, { assigneeId: await a.userId(a.ben) });
    expect(handed).toEqual({ status: 200, body: { case: null } });
    expect((await a.view(a.ana, number)).status).toBe(404);
    expect((await a.view(a.ben, number)).body).toMatchObject({ case: { assignee: { name: "Ben Analyst" } } });
  });

  test("Members of another Organization see none of Acme's Cases, Restricted or not", async () => {
    const a = await acme();
    const open = await a.open(a.owner, "Phishing report");
    const restricted = await a.open(a.owner);
    await a.change(a.owner, restricted, { restricted: true });
    await a.t.inviteOwner("Globex", "owner@globex.example");
    const globex = await a.t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");

    expect((await a.list(globex)).cases).toEqual([]);
    expect((await a.view(globex, open)).status).toBe(404);
    expect((await a.view(globex, restricted)).status).toBe(404);
    expect((await a.change(globex, open, { restricted: true })).status).toBe(404);
  });
});

describe("Marking a Case Restricted", () => {
  const matrix: { actor: ActorName; who: string; may: boolean }[] = [
    { actor: "owner", who: "the Owner", may: true },
    { actor: "admin", who: "an Admin", may: true },
    { actor: "ana", who: "the Assignee", may: true },
    { actor: "ben", who: "an Analyst who isn't the Assignee", may: false },
  ];

  for (const { actor, who, may } of matrix) {
    test(`${who} ${may ? "can" : "cannot"} mark a Case Restricted and lift it`, async () => {
      const a = await acme();
      const number = await a.open(a.owner);
      await a.change(a.owner, number, { assigneeId: await a.userId(a.ana) });
      const as = a[actor];

      const marked = await a.change(as, number, { restricted: true });
      expect(marked.status).toBe(may ? 200 : 403);
      expect((await a.view(a.owner, number)).body).toMatchObject({ case: { restricted: may } });
      if (!may) {
        // Once someone who may has marked it, they can no longer see it to lift it.
        await a.change(a.owner, number, { restricted: true });
        expect((await a.change(as, number, { restricted: false })).status).toBe(404);
        return;
      }
      expect((await a.change(as, number, { restricted: false })).status).toBe(200);

      const entries = (await a.auditLog(a.owner, number)).filter((e) => e.action === "case.restricted_changed");
      const name = { owner: "Olive Owner", admin: "Adam Admin", ana: "Ana Analyst", ben: "Ben Analyst" }[actor];
      expect(entries.map((e) => ({ by: e.actor.name, before: e.before, after: e.after }))).toEqual([
        { by: name, before: "true", after: "false" },
        { by: name, before: "false", after: "true" },
      ]);
    });
  }

  test("a refused change to Restricted changes nothing else in the same request", async () => {
    const a = await acme();
    const number = await a.open(a.owner);
    expect((await a.change(a.ben, number, { severity: "critical", restricted: true })).status).toBe(403);
    expect((await a.view(a.owner, number)).body).toMatchObject({ case: { severity: "high", restricted: false } });
    expect((await a.auditLog(a.owner, number)).map((e) => e.action)).toEqual(["case.opened"]);
  });

  test("setting Restricted to what it already is records nothing", async () => {
    const a = await acme();
    const number = await a.open(a.owner);
    expect((await a.change(a.ben, number, { restricted: false })).status).toBe(200);
    expect((await a.auditLog(a.owner, number)).map((e) => e.action)).toEqual(["case.opened"]);
  });

  test("a Closed Case can't be marked Restricted", async () => {
    const a = await acme();
    const number = await a.open(a.owner);
    await a.owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "benign" } });
    expect((await a.change(a.owner, number, { restricted: true })).status).toBe(409);
  });

  test("the Case tells each Member what they may do with it", async () => {
    const a = await acme();
    const number = await a.open(a.owner);
    await a.change(a.owner, number, { assigneeId: await a.userId(a.ana) });
    const can = async (as: Acme["owner"]) => {
      const { body } = await a.view(as, number);
      return "case" in body ? body.case.can : null;
    };
    const all = { work: true, readAuditLog: true };
    expect(await can(a.owner)).toEqual({ ...all, restrict: true, reopen: true, manageGuests: true });
    expect(await can(a.admin)).toEqual({ ...all, restrict: true, reopen: true, manageGuests: true });
    expect(await can(a.ana)).toEqual({ ...all, restrict: true, reopen: false, manageGuests: true });
    expect(await can(a.ben)).toEqual({ ...all, restrict: false, reopen: false, manageGuests: false });
  });
});
