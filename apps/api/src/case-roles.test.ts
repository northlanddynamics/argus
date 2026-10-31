import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { buildTestApp } from "./test/harness";

const PASSWORD = "correct-horse-battery";
const param = (number: number) => ({ number: String(number) });

/** The Postgres error a query fails with (Drizzle wraps it as `cause`), or null if it succeeds. */
async function dbError(query: PromiseLike<unknown>) {
  try {
    await query;
    return null;
  } catch (e) {
    return String((e as { cause?: unknown }).cause ?? e);
  }
}

/** Acme Security: the Owner, an Admin, Ana and Ben (Analysts), signed in. */
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

  const catalog = async (as: Member) => {
    const body = await (await as.api.organization["case-roles"].$get()).json();
    return body.caseRoles;
  };
  const createRole = async (as: Member, name: string) => {
    const res = await as.api.organization["case-roles"].$post({ json: { name } });
    return { status: res.status, body: await res.json() };
  };
  /** Creates a Case Role that must succeed, and returns its id. */
  const role = async (name: string, as: Member = admin) => {
    const { status, body } = await createRole(as, name);
    if (status !== 201 || !("caseRole" in body)) throw new Error(`Could not create ${name}: ${status}`);
    return body.caseRole.id;
  };
  const rename = async (as: Member, id: string, name: string) => {
    const res = await as.api.organization["case-roles"][":id"].$patch({ param: { id }, json: { name } });
    return { status: res.status, body: await res.json() };
  };
  const retire = async (as: Member, id: string) => (await as.api.organization["case-roles"][":id"].retire.$post({ param: { id } })).status;

  const orgAudit = async (as: Member) => {
    const body = await (await as.api.organization["audit-log"].$get({ query: { category: "case-roles" } })).json();
    if (!("entries" in body)) throw new Error("Could not read the Organization Audit Log");
    return body.entries;
  };

  const open = async (as: Member = owner, title = "Executive mailbox access") => {
    const res = await as.api.cases.$post({ json: { title, caseType: "account_compromise", severity: "high" } });
    const body = await res.json();
    if (!("case" in body)) throw new Error(`Could not open a Case: ${res.status}`);
    return body.case.number;
  };
  const view = async (as: Member, number: number) => {
    const res = await as.api.cases[":number"].$get({ param: param(number) });
    return { status: res.status, body: await res.json() };
  };
  const listNumbers = async (as: Member) => {
    const body = await (await as.api.cases.$get({ query: {} })).json();
    return "cases" in body ? body.cases.map((c) => c.number) : [];
  };
  const change = (as: Member, number: number, json: { assigneeId?: string | null; restricted?: boolean }) =>
    as.api.cases[":number"].$patch({ param: param(number), json });

  const assign = async (as: Member, number: number, caseRoleId: string, holderId: string) => {
    const res = await as.api.cases[":number"]["case-roles"].$post({ param: param(number), json: { caseRoleId, userId: holderId } });
    return { status: res.status, body: await res.json() };
  };
  const unassign = async (as: Member, number: number, assignmentId: string) => {
    const res = await as.api.cases[":number"]["case-roles"][":assignmentId"].$delete({ param: { ...param(number), assignmentId } });
    return { status: res.status, body: await res.json() };
  };
  /** The Case's Case Role assignments as "Role: Holder", as `as` sees them. */
  const holders = async (as: Member, number: number) => {
    const { body } = await view(as, number);
    return "case" in body ? body.case.caseRoles.map((a) => `${a.caseRole.name}: ${a.holder.name}`) : null;
  };

  const auditLog = async (as: Member, number: number) => {
    const body = await (await as.api.cases[":number"]["audit-log"].$get({ param: param(number), query: {} })).json();
    if (!("entries" in body)) throw new Error("Could not read the Audit Log");
    return body.entries;
  };

  return {
    t,
    owner,
    admin,
    ana,
    ben,
    userId,
    catalog,
    createRole,
    role,
    rename,
    retire,
    orgAudit,
    open,
    view,
    listNumbers,
    change,
    assign,
    unassign,
    holders,
    auditLog,
  };
}

describe("The Case Role catalog", () => {
  test("Admins create, rename and retire Case Roles; every Member reads the catalog", async () => {
    const { admin, ana, role, rename, retire, catalog } = await acme();
    const lead = await role("Lead");
    const forensics = await role("Forensics");
    const comms = await role("Comms");
    expect((await rename(admin, forensics, "Forensics & IR")).status).toBe(200);
    expect(await retire(admin, comms)).toBe(200);

    expect(await catalog(ana)).toEqual([
      { id: forensics, name: "Forensics & IR", retired: false, cases: 0 },
      { id: lead, name: "Lead", retired: false, cases: 0 },
      { id: comms, name: "Comms", retired: true, cases: 0 },
    ]);
  });

  test("each change is recorded in the Organization Audit Log under Case Roles", async () => {
    const { admin, owner, role, rename, retire, orgAudit } = await acme();
    const id = await role("Legal");
    await rename(owner, id, "Legal counsel");
    await retire(admin, id);
    const entries = (await orgAudit(owner)).map((e) => [e.actor.name, e.category, e.action, e.target, e.before, e.after]);
    expect(entries).toEqual([
      ["Adam Admin", "case-roles", "case_role.retired", "Legal counsel", null, null],
      ["Olive Owner", "case-roles", "case_role.renamed", "Legal counsel", "Legal", "Legal counsel"],
      ["Adam Admin", "case-roles", "case_role.created", "Legal", null, null],
    ]);
  });

  test("Analysts can't change the catalog, and nothing is recorded", async () => {
    const { owner, ana, createRole, role, rename, retire, catalog, orgAudit } = await acme();
    const lead = await role("Lead");
    expect((await createRole(ana, "Forensics")).status).toBe(403);
    expect((await rename(ana, lead, "Boss")).status).toBe(403);
    expect(await retire(ana, lead)).toBe(403);
    expect((await catalog(ana)).map((r) => r.name)).toEqual(["Lead"]);
    expect(await orgAudit(owner)).toHaveLength(1);
  });

  test("names are unique among active Case Roles, ignoring case; a retired name can be used again", async () => {
    const { admin, createRole, role, rename, retire } = await acme();
    const lead = await role("Lead");
    const comms = await role("Comms");
    expect(await createRole(admin, "lead")).toMatchObject({ status: 409, body: { error: "There is already a Case Role named lead" } });
    expect((await rename(admin, comms, "LEAD")).status).toBe(409);
    await retire(admin, lead);
    expect((await createRole(admin, "Lead")).status).toBe(201);
  });

  test("a blank name is refused", async () => {
    const { admin, createRole } = await acme();
    expect((await createRole(admin, "   ")).status).toBe(400);
  });

  test("a retired Case Role can't be renamed; retiring it again changes nothing", async () => {
    const { admin, owner, role, rename, retire, orgAudit } = await acme();
    const id = await role("Comms");
    await retire(admin, id);
    expect((await rename(admin, id, "Communications")).status).toBe(409);
    expect(await retire(admin, id)).toBe(200);
    expect(await orgAudit(owner)).toHaveLength(2);
  });

  test("another Organization's Case Roles are not found and not listed", async () => {
    const { t, role, catalog } = await acme();
    const lead = await role("Lead");
    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    expect(await catalog(globex)).toEqual([]);
    const res = await globex.api.organization["case-roles"][":id"].$patch({ param: { id: lead }, json: { name: "Mine" } });
    expect(res.status).toBe(404);
  });

  test("the catalog counts the Cases each Case Role is held on", async () => {
    const { owner, ana, ben, role, open, assign, userId, catalog } = await acme();
    const lead = await role("Lead");
    const one = await open();
    const two = await open();
    await assign(owner, one, lead, await userId(ana));
    await assign(owner, one, lead, await userId(ben));
    await assign(owner, two, lead, await userId(ana));
    expect(await catalog(owner)).toEqual([{ id: lead, name: "Lead", retired: false, cases: 2 }]);
  });

  test("Case Roles are never deleted at the database", async () => {
    const { t, role } = await acme();
    await role("Lead");
    expect(await dbError(t.deps.db.execute(sql`DELETE FROM case_roles`))).toMatch(/cannot be deleted/);
  });
});

describe("Case Roles on a Case", () => {
  test("anyone working the Case gives Members Case Roles; the Case shows who holds which", async () => {
    const { ana, ben, owner, role, open, assign, userId, holders } = await acme();
    const lead = await role("Lead");
    const forensics = await role("Forensics");
    const number = await open(ana);
    const { status, body } = await assign(ben, number, lead, await userId(ana));
    expect(status).toBe(200);
    expect(body).toEqual({
      caseRoles: [
        { id: expect.any(String), caseRole: { id: lead, name: "Lead", retired: false }, holder: { id: await userId(ana), name: "Ana Analyst" } },
      ],
    });
    await assign(ana, number, forensics, await userId(ben));
    await assign(ana, number, forensics, await userId(owner));
    expect(await holders(owner, number)).toEqual(["Forensics: Ben Analyst", "Forensics: Olive Owner", "Lead: Ana Analyst"]);
  });

  test("giving and taking away are recorded in the Audit Log, by holder and Case Role", async () => {
    const { t, ana, ben, role, open, assign, unassign, userId, auditLog } = await acme();
    const lead = await role("Lead");
    const number = await open(ana);
    const { body } = await assign(ana, number, lead, await userId(ben));
    const assignmentId = "caseRoles" in body && body.caseRoles ? body.caseRoles[0]!.id : "";
    expect((await unassign(ben, number, assignmentId)).status).toBe(200);

    const entries = (await auditLog(ana, number)).slice(0, 2);
    expect(entries).toEqual([
      {
        id: expect.any(String),
        occurredAt: t.clock.now().toISOString(),
        actor: { type: "member", id: await userId(ben), name: "Ben Analyst" },
        action: "case_role.unassigned",
        target: "Ben Analyst",
        before: "Lead",
        after: null,
      },
      {
        id: expect.any(String),
        occurredAt: t.clock.now().toISOString(),
        actor: { type: "member", id: await userId(ana), name: "Ana Analyst" },
        action: "case_role.assigned",
        target: "Ben Analyst",
        before: null,
        after: "Lead",
      },
    ]);
  });

  test("giving someone a Case Role they already hold changes nothing", async () => {
    const { owner, ana, role, open, assign, userId, holders, auditLog } = await acme();
    const lead = await role("Lead");
    const number = await open();
    await assign(owner, number, lead, await userId(ana));
    const before = await auditLog(owner, number);
    expect((await assign(owner, number, lead, await userId(ana))).status).toBe(200);
    expect(await holders(owner, number)).toEqual(["Lead: Ana Analyst"]);
    expect(await auditLog(owner, number)).toEqual(before);
  });

  test("only active Case Roles of the Organization, and only its Members", async () => {
    const { t, admin, owner, ana, role, retire, open, assign, userId } = await acme();
    const comms = await role("Comms");
    const lead = await role("Lead");
    await retire(admin, comms);
    await t.inviteOwner("Globex", "owner@globex.example");
    const globex = await t.acceptInvite("owner@globex.example", PASSWORD, "Gil Globex");
    const number = await open();
    expect(await assign(owner, number, comms, await userId(ana))).toMatchObject({ status: 400, body: { error: "This Case Role is retired" } });
    expect((await assign(owner, number, "nope", await userId(ana))).status).toBe(400);
    expect((await assign(owner, number, lead, await userId(globex))).status).toBe(400);
  });

  test("a retired Case Role stays with those who hold it, marked retired", async () => {
    const { admin, owner, ana, role, retire, open, assign, userId, view } = await acme();
    const comms = await role("Comms");
    const number = await open();
    await assign(owner, number, comms, await userId(ana));
    await retire(admin, comms);
    const { body } = await view(owner, number);
    expect("case" in body && body.case.caseRoles.map((a) => a.caseRole)).toEqual([{ id: comms, name: "Comms", retired: true }]);
  });

  test("an assignment that has ended, or belongs to another Case, is not found", async () => {
    const { owner, ana, role, open, assign, unassign, userId } = await acme();
    const lead = await role("Lead");
    const one = await open();
    const two = await open();
    const { body } = await assign(owner, one, lead, await userId(ana));
    const id = "caseRoles" in body && body.caseRoles ? body.caseRoles[0]!.id : "";
    expect((await unassign(owner, two, id)).status).toBe(404);
    expect((await unassign(owner, one, id)).status).toBe(200);
    expect((await unassign(owner, one, id)).status).toBe(404);
  });

  test("a Closed Case's Case Roles can't change", async () => {
    const { owner, ana, role, open, assign, userId } = await acme();
    const lead = await role("Lead");
    const number = await open();
    await owner.api.cases[":number"].close.$post({ param: param(number), json: { resolution: "benign" } });
    expect((await assign(owner, number, lead, await userId(ana))).status).toBe(409);
  });

  test("Case Role assignments are never deleted at the database", async () => {
    const { t, owner, ana, role, open, assign, userId } = await acme();
    const lead = await role("Lead");
    await assign(owner, await open(), lead, await userId(ana));
    expect(await dbError(t.deps.db.execute(sql`DELETE FROM case_role_assignments`))).toMatch(/cannot be deleted/);
  });
});

describe("A Case Role counts as assigned for Restricted Case visibility", () => {
  test("an Analyst given a Case Role on a Restricted Case sees it, until it is taken away", async () => {
    const { owner, ana, ben, role, open, change, assign, unassign, userId, view, listNumbers } = await acme();
    const forensics = await role("Forensics");
    const number = await open();
    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    expect((await view(ben, number)).status).toBe(404);
    expect(await listNumbers(ben)).toEqual([]);

    const { body } = await assign(ana, number, forensics, await userId(ben));
    expect((await view(ben, number)).status).toBe(200);
    expect(await listNumbers(ben)).toEqual([number]);

    const id = "caseRoles" in body && body.caseRoles ? body.caseRoles[0]!.id : "";
    await unassign(owner, number, id);
    expect((await view(ben, number)).status).toBe(404);
  });

  test("an Analyst who gives up their own Case Role on a Restricted Case loses sight of it", async () => {
    const { owner, ana, ben, role, open, change, assign, unassign, userId, view } = await acme();
    const forensics = await role("Forensics");
    const number = await open();
    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    const { body } = await assign(owner, number, forensics, await userId(ben));
    const id = "caseRoles" in body && body.caseRoles ? body.caseRoles[0]!.id : "";
    expect(await unassign(ben, number, id)).toEqual({ status: 200, body: { caseRoles: null } });
    expect((await view(ben, number)).status).toBe(404);
  });

  test("a Case Role holder can work the Case but, unlike its Assignee, can't lift Restricted", async () => {
    const { owner, ana, ben, role, open, change, assign, userId, view } = await acme();
    const forensics = await role("Forensics");
    const number = await open();
    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    await assign(owner, number, forensics, await userId(ben));
    const { body } = await view(ben, number);
    expect("case" in body && body.case.can.restrict).toBe(false);
    expect((await change(ben, number, { restricted: false })).status).toBe(403);
    expect((await change(ben, number, { assigneeId: null })).status).toBe(200);
    expect((await view(ben, number)).status).toBe(200);
  });

  test("a Case Role holder can own the Restricted Case's Tasks", async () => {
    const { owner, ana, ben, role, open, change, assign, userId } = await acme();
    const forensics = await role("Forensics");
    const number = await open();
    await change(owner, number, { assigneeId: await userId(ana), restricted: true });
    await assign(owner, number, forensics, await userId(ben));
    const res = await ana.api.cases[":number"].tasks.$post({
      param: param(number),
      json: { title: "Capture memory image", ownerId: await userId(ben) },
    });
    expect(res.status).toBe(201);
  });

  test("a Case Role on one Case doesn't reveal another Restricted Case", async () => {
    const { owner, ana, ben, role, open, change, assign, userId, view } = await acme();
    const lead = await role("Lead");
    const one = await open();
    const two = await open();
    for (const n of [one, two]) await change(owner, n, { assigneeId: await userId(ana), restricted: true });
    await assign(owner, one, lead, await userId(ben));
    expect((await view(ben, one)).status).toBe(200);
    expect((await view(ben, two)).status).toBe(404);
  });
});
