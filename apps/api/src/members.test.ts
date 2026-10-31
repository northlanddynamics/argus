import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { buildTestApp } from "./test/harness";

const OWNER = "owner@acme.example";
const PASSWORD = "correct-horse-battery";

/** The Postgres error a query fails with (Drizzle wraps it as `cause`), or null if it succeeds. */
async function dbError(query: PromiseLike<unknown>) {
  try {
    await query;
    return null;
  } catch (e) {
    return String((e as { cause?: unknown }).cause ?? e);
  }
}

/** Acme Security with its Owner signed in, plus helpers to bring in more Members. */
async function acme() {
  const t = await buildTestApp();
  await t.inviteOwner("Acme Security", OWNER);
  const owner = await t.acceptInvite(OWNER, PASSWORD, "Olive Owner");
  /** `by` invites `email` as `role`; the invitee accepts, signs in and enrolls in TOTP. */
  const join = async (by: typeof owner, email: string, role: "admin" | "analyst", name: string) => {
    const res = await by.api.organization.invitations.$post({ json: { email, role } });
    expect(res.status).toBe(201);
    return t.acceptInvite(email, PASSWORD, name);
  };
  const members = async (as = owner) => {
    const res = await as.api.organization.members.$get();
    expect(res.status).toBe(200);
    return (await res.json()).members;
  };
  const memberId = async (email: string) => (await members()).find((m) => m.email === email)!.id;
  type AuditQuery = { category?: "members" | "integrations"; actor?: string; from?: string };
  const auditLog = async (as = owner, query: AuditQuery = {}) => {
    const res = await as.api.organization["audit-log"].$get({ query });
    const body = await res.json();
    if (!("entries" in body)) throw new Error(`Audit log: ${res.status}`);
    return body.entries;
  };
  return { t, owner, join, members, memberId, auditLog };
}

describe("Roles", () => {
  test("the Organization starts with exactly one Owner", async () => {
    const { members } = await acme();
    expect(await members()).toMatchObject([{ email: OWNER, name: "Olive Owner", role: "owner" }]);
  });

  test("the database refuses a second Owner", async () => {
    const { t, owner, join } = await acme();
    await join(owner, "ada@acme.example", "admin", "Ada Admin");
    const promote = t.deps.db.execute(sql`UPDATE member SET role = 'owner' WHERE role = 'admin'`);
    expect(await dbError(promote)).toMatch(/member_one_owner_per_org/);
  });
});

describe("Inviting Members", () => {
  test("an Admin invites by email; the invitee gets a link, accepts and joins with that role", async () => {
    const { t, owner, join, members } = await acme();
    const admin = await join(owner, "ada@acme.example", "admin", "Ada Admin");
    const res = await admin.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    expect(res.status).toBe(201);
    expect(t.outbox.messages.at(-1)).toMatchObject({ to: "ana@acme.example" });
    expect(t.outbox.messages.at(-1)!.text).toContain("Acme Security");

    const analyst = await t.acceptInvite("ana@acme.example", PASSWORD, "Ana Analyst");
    const me = await (await analyst.api.me.$get()).json();
    expect(me).toMatchObject({ organization: { name: "Acme Security", role: "analyst" } });
    expect((await members()).map((m) => [m.email, m.role])).toEqual([
      [OWNER, "owner"],
      ["ada@acme.example", "admin"],
      ["ana@acme.example", "analyst"],
    ]);
  });

  test("pending invitations are listed for Admins and can be revoked", async () => {
    const { t, owner } = await acme();
    await owner.api.organization.invitations.$post({ json: { email: "ana@acme.example", role: "analyst" } });
    const list = await (await owner.api.organization.members.$get()).json();
    expect(list.invitations).toMatchObject([{ email: "ana@acme.example", role: "analyst" }]);

    const revoke = await owner.api.organization.invitations[":id"].$delete({ param: { id: list.invitations![0]!.id } });
    expect(revoke.status).toBe(200);
    expect((await (await owner.api.organization.members.$get()).json()).invitations).toEqual([]);
    const accept = await t.session().api.invitations[":id"].accept.$post({
      param: { id: t.inviteIdFor("ana@acme.example") },
      json: { name: "Ana", password: PASSWORD },
    });
    expect(accept.status).toBe(404);
  });

  test("an email that already has an Argus account or a pending invitation cannot be invited", async () => {
    const { owner } = await acme();
    const invite = (email: string) => owner.api.organization.invitations.$post({ json: { email, role: "analyst" } });
    expect((await invite(OWNER)).status as number).toBe(409);
    expect((await invite("ana@acme.example")).status).toBe(201);
    expect((await invite("ana@acme.example")).status as number).toBe(409);
  });

  test("nobody can be invited as Owner", async () => {
    const { owner } = await acme();
    const res = await owner.api.organization.invitations.$post({
      // @ts-expect-error owner is not an invitable role
      json: { email: "o2@acme.example", role: "owner" },
    });
    expect(res.status as number).toBe(400);
  });
});

describe("Changing roles and removing Members", () => {
  test("an Admin changes an Analyst to Admin and back", async () => {
    const { owner, join, members, memberId } = await acme();
    const admin = await join(owner, "ada@acme.example", "admin", "Ada Admin");
    await join(owner, "ana@acme.example", "analyst", "Ana Analyst");
    const id = await memberId("ana@acme.example");

    const promote = await admin.api.organization.members[":id"].$patch({ param: { id }, json: { role: "admin" } });
    expect(promote.status).toBe(200);
    expect((await members()).find((m) => m.id === id)!.role).toBe("admin");
    await admin.api.organization.members[":id"].$patch({ param: { id }, json: { role: "analyst" } });
    expect((await members()).find((m) => m.id === id)!.role).toBe("analyst");
  });

  test("the Owner's role cannot be changed and the Owner cannot be removed", async () => {
    const { owner, join, memberId } = await acme();
    const admin = await join(owner, "ada@acme.example", "admin", "Ada Admin");
    const id = await memberId(OWNER);
    const demote = await admin.api.organization.members[":id"].$patch({ param: { id }, json: { role: "analyst" } });
    expect(demote.status as number).toBe(409);
    const remove = await admin.api.organization.members[":id"].$delete({ param: { id } });
    expect(remove.status as number).toBe(409);
  });

  test("a removed Member is signed out and no longer in the Organization", async () => {
    const { owner, join, members, memberId } = await acme();
    const analyst = await join(owner, "ana@acme.example", "analyst", "Ana Analyst");
    const res = await owner.api.organization.members[":id"].$delete({ param: { id: await memberId("ana@acme.example") } });
    expect(res.status).toBe(200);
    expect((await members()).map((m) => m.email)).toEqual([OWNER]);
    expect((await analyst.api.me.$get()).status as number).toBe(401);
  });
});

describe("Analysts cannot manage Members", () => {
  test("invite, change role, remove and revoke are refused", async () => {
    const { owner, join, memberId } = await acme();
    const analyst = await join(owner, "ana@acme.example", "analyst", "Ana Analyst");
    await owner.api.organization.invitations.$post({ json: { email: "bo@acme.example", role: "analyst" } });
    const invitationId = (await (await owner.api.organization.members.$get()).json()).invitations![0]!.id;
    const ownerId = await memberId(OWNER);
    const selfId = await memberId("ana@acme.example");

    const attempts = [
      analyst.api.organization.invitations.$post({ json: { email: "x@acme.example", role: "admin" } }),
      analyst.api.organization.invitations[":id"].$delete({ param: { id: invitationId } }),
      analyst.api.organization.members[":id"].$patch({ param: { id: selfId }, json: { role: "admin" } }),
      analyst.api.organization.members[":id"].$delete({ param: { id: ownerId } }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status as number).toBe(403);
  });

  test("Analysts can see who the Members are, but not pending invitations", async () => {
    const { owner, join } = await acme();
    const analyst = await join(owner, "ana@acme.example", "analyst", "Ana Analyst");
    await owner.api.organization.invitations.$post({ json: { email: "bo@acme.example", role: "analyst" } });
    const list = await (await analyst.api.organization.members.$get()).json();
    expect(list.members).toHaveLength(2);
    expect(list.invitations).toBeUndefined();
  });

  test("Better Auth's own organization endpoints cannot be used to bypass Argus", async () => {
    const { owner, join, memberId } = await acme();
    await join(owner, "ana@acme.example", "analyst", "Ana Analyst");
    const invite = await owner.auth.organization.inviteMember({ email: "x@acme.example", role: "admin" });
    expect(invite.error?.status).toBe(403);
    const update = await owner.auth.organization.updateMemberRole({
      memberId: await memberId("ana@acme.example"),
      role: "admin",
    });
    expect(update.error?.status).toBe(403);
    const remove = await owner.auth.organization.removeMember({ memberIdOrEmail: "ana@acme.example" });
    expect(remove.error?.status).toBe(403);
  });
});

describe("Ownership", () => {
  test("the Owner transfers ownership to another Member and becomes an Admin", async () => {
    const { owner, join, members, memberId } = await acme();
    await join(owner, "ada@acme.example", "admin", "Ada Admin");
    const res = await owner.api.organization.ownership.$post({ json: { memberId: await memberId("ada@acme.example") } });
    expect(res.status).toBe(200);
    expect((await members()).map((m) => [m.email, m.role])).toEqual([
      [OWNER, "admin"],
      ["ada@acme.example", "owner"],
    ]);
  });

  test("only the Owner can transfer ownership", async () => {
    const { owner, join, memberId } = await acme();
    const admin = await join(owner, "ada@acme.example", "admin", "Ada Admin");
    const res = await admin.api.organization.ownership.$post({ json: { memberId: await memberId("ada@acme.example") } });
    expect(res.status as number).toBe(403);
  });

  test("only the Owner can delete the Organization; its Members are signed out", async () => {
    const { t, owner, join } = await acme();
    const admin = await join(owner, "ada@acme.example", "admin", "Ada Admin");
    const byAdmin = await admin.api.organization.$delete({ json: { confirmName: "Acme Security" } });
    expect(byAdmin.status as number).toBe(403);
    const wrongName = await owner.api.organization.$delete({ json: { confirmName: "Acme" } });
    expect(wrongName.status as number).toBe(400);

    const res = await owner.api.organization.$delete({ json: { confirmName: "Acme Security" } });
    expect(res.status).toBe(200);
    expect((await admin.api.me.$get()).status as number).toBe(401);
    const operator = await t.createOperator("ops2@argus.test");
    const orgs = await (await operator.api.operator.organizations.$get()).json();
    expect(orgs.organizations).toMatchObject([{ name: "Acme Security", deleted: true, members: 0 }]);
  });
});

describe("Organization Audit Log", () => {
  test("every Members action is recorded, newest first", async () => {
    const { t, owner, join, memberId, auditLog } = await acme();
    const admin = await join(owner, "ada@acme.example", "admin", "Ada Admin");
    await join(admin, "ana@acme.example", "analyst", "Ana Analyst");
    const anaId = await memberId("ana@acme.example");
    await admin.api.organization.members[":id"].$patch({ param: { id: anaId }, json: { role: "admin" } });
    await admin.api.organization.invitations.$post({ json: { email: "bo@acme.example", role: "analyst" } });
    const bo = (await (await admin.api.organization.members.$get()).json()).invitations![0]!.id;
    await admin.api.organization.invitations[":id"].$delete({ param: { id: bo } });
    await admin.api.organization.members[":id"].$delete({ param: { id: anaId } });
    await owner.api.organization.ownership.$post({ json: { memberId: await memberId("ada@acme.example") } });
    t.clock.advance(1000);

    const entries = await auditLog();
    const shape = entries.map((e) => ({
      actor: e.actor.name,
      category: e.category,
      action: e.action,
      target: e.target,
      before: e.before,
      after: e.after,
    }));
    expect(shape.toReversed()).toEqual([
      { actor: "Operator", category: "members", action: "organization.created", target: "Acme Security", before: null, after: OWNER },
      { actor: "Operator", category: "members", action: "member.invited", target: OWNER, before: null, after: "owner" },
      { actor: "Olive Owner", category: "members", action: "member.joined", target: OWNER, before: null, after: "owner" },
      { actor: "Olive Owner", category: "members", action: "member.invited", target: "ada@acme.example", before: null, after: "admin" },
      { actor: "Ada Admin", category: "members", action: "member.joined", target: "ada@acme.example", before: null, after: "admin" },
      { actor: "Ada Admin", category: "members", action: "member.invited", target: "ana@acme.example", before: null, after: "analyst" },
      { actor: "Ana Analyst", category: "members", action: "member.joined", target: "ana@acme.example", before: null, after: "analyst" },
      { actor: "Ada Admin", category: "members", action: "member.role_changed", target: "Ana Analyst", before: "analyst", after: "admin" },
      { actor: "Ada Admin", category: "members", action: "member.invited", target: "bo@acme.example", before: null, after: "analyst" },
      { actor: "Ada Admin", category: "members", action: "invitation.revoked", target: "bo@acme.example", before: "analyst", after: null },
      { actor: "Ada Admin", category: "members", action: "member.removed", target: "Ana Analyst", before: "admin", after: null },
      { actor: "Olive Owner", category: "members", action: "ownership.transferred", target: "Ada Admin", before: "Olive Owner", after: "Ada Admin" },
    ]);
  });

  test("deleting the Organization is recorded", async () => {
    const { t, owner } = await acme();
    await owner.api.organization.$delete({ json: { confirmName: "Acme Security" } });
    const rows = await t.deps.db.execute<{ action: string; actor_name: string }>(
      sql`SELECT action, actor_name FROM org_audit_log ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
    );
    expect([...rows]).toEqual([{ action: "organization.deleted", actor_name: "Olive Owner" }]);
  });

  test("it filters by category, actor and date", async () => {
    const { t, owner, join, auditLog } = await acme();
    t.clock.advance(24 * 60 * 60 * 1000);
    const admin = await join(owner, "ada@acme.example", "admin", "Ada Admin");
    const me = await (await admin.api.me.$get()).json();
    if (!("user" in me)) throw new Error("Not signed in");
    const adaId = me.user.id;

    expect(await auditLog(owner, { actor: adaId })).toMatchObject([{ action: "member.joined" }]);
    const since = new Date(t.clock.now().getTime() - 60_000).toISOString();
    expect((await auditLog(owner, { from: since })).map((e) => e.action)).toEqual(["member.joined", "member.invited"]);
    expect(await auditLog(owner, { category: "integrations" })).toEqual([]);
  });

  test("Admins can read it; Analysts get 403", async () => {
    const { owner, join } = await acme();
    const admin = await join(owner, "ada@acme.example", "admin", "Ada Admin");
    const analyst = await join(owner, "ana@acme.example", "analyst", "Ana Analyst");
    expect((await admin.api.organization["audit-log"].$get({ query: {} })).status).toBe(200);
    expect((await analyst.api.organization["audit-log"].$get({ query: {} })).status as number).toBe(403);
  });

  test("entries cannot be updated or deleted, even by the database owner", async () => {
    const { t } = await acme();
    const { db } = t.deps;
    expect(await dbError(db.execute(sql`UPDATE org_audit_log SET action = 'tampered'`))).toMatch(/append-only/);
    expect(await dbError(db.execute(sql`DELETE FROM org_audit_log`))).toMatch(/append-only/);
    expect(await dbError(db.execute(sql`TRUNCATE org_audit_log`))).toMatch(/append-only/);
  });

  test("entries are scoped to their Organization", async () => {
    const { t, auditLog } = await acme();
    const operator = await t.createOperator("ops2@argus.test");
    await operator.api.operator.organizations.$post({ json: { name: "Globex", ownerEmail: "owner@globex.example" } });
    expect((await auditLog()).every((e) => e.target !== "Globex")).toBe(true);
  });
});
