import { zValidator } from "@hono/zod-validator";
import { and, asc, count, eq, gt, inArray, max, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { ORG_AUDIT_CATEGORIES, listOrgAudit, recordOrgAudit, type OrgAuditEntry } from "../audit/org-audit-log";
import type { OrgRole } from "../auth/roles";
import type { Tx } from "../db/client";
import { account, invitation, member, organization, passkey, session, user as userTable } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import { INVITE_TTL_MS, sendInvite } from "../invites";
import { MANAGERS, type MemberEnv, type Membership, requireMember } from "../members/membership";

/** Roles an Admin can give. Ownership only moves by transfer. */
const assignableRole = z.enum(["admin", "analyst"]);

const inviteBody = z.object({ email: z.email().trim().toLowerCase(), role: assignableRole });
const roleBody = z.object({ role: assignableRole });
const transferBody = z.object({ memberId: z.string().min(1) });
const deleteBody = z.object({ confirmName: z.string() });
const auditQuery = z.object({
  category: z.enum(ORG_AUDIT_CATEGORIES).optional(),
  actor: z.string().min(1).optional(),
  from: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), "Not a date")
    .optional(),
});

/** Ends every session these people hold, so a change to their membership takes effect now. */
const signOutEverywhere = (tx: Tx, userIds: string[]) =>
  userIds.length ? tx.delete(session).where(inArray(session.userId, userIds)) : Promise.resolve();

type PendingInvitation = { id: string; email: string; role: OrgRole; expiresAt: string; expired: boolean };

/** Settings · Members, Ownership and the Organization Audit Log. */
export const organizationRoutes = (deps: Deps) => {
  const { db, clock } = deps;
  const anyMember = requireMember(db);
  const managers = requireMember(db, MANAGERS);
  const ownerOnly = requireMember(db, ["owner"]);

  /** Fields every entry written by `by` shares. */
  const auditBy = (by: Membership): Omit<OrgAuditEntry, "action"> => ({
    organizationId: by.organizationId,
    occurredAt: clock.now(),
    actor: { type: "member", id: by.userId, name: by.name },
    category: "members",
  });

  const findMember = async (organizationId: string, memberId: string) => {
    const [row] = await db
      .select({ id: member.id, userId: member.userId, role: member.role, name: userTable.name })
      .from(member)
      .innerJoin(userTable, eq(member.userId, userTable.id))
      .where(and(eq(member.id, memberId), eq(member.organizationId, organizationId)))
      .limit(1);
    return row ? { ...row, role: row.role as OrgRole } : null;
  };

  return new Hono<MemberEnv>()
    .get("/members", anyMember, async (c) => {
      const me = c.get("membership");
      const rows = await db
        .select({
          id: member.id,
          userId: userTable.id,
          name: userTable.name,
          email: userTable.email,
          role: member.role,
          totp: userTable.twoFactorEnabled,
        })
        .from(member)
        .innerJoin(userTable, eq(member.userId, userTable.id))
        .where(eq(member.organizationId, me.organizationId))
        .orderBy(asc(member.createdAt), asc(userTable.createdAt));
      const userIds = rows.map((r) => r.userId);
      const [passkeys, passwords, lastActive] = userIds.length
        ? await Promise.all([
            db.select({ userId: passkey.userId, n: count() }).from(passkey).where(inArray(passkey.userId, userIds)).groupBy(passkey.userId),
            db
              .select({ userId: account.userId })
              .from(account)
              .where(and(inArray(account.userId, userIds), eq(account.providerId, "credential"))),
            db
              .select({ userId: session.userId, at: max(session.updatedAt) })
              .from(session)
              .where(inArray(session.userId, userIds))
              .groupBy(session.userId),
          ])
        : [[], [], []];
      const members = rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        name: r.name,
        email: r.email,
        role: r.role as OrgRole,
        signIn: {
          password: passwords.some((p) => p.userId === r.userId),
          totp: !!r.totp,
          passkeys: passkeys.find((p) => p.userId === r.userId)?.n ?? 0,
        },
        lastActiveAt: lastActive.find((s) => s.userId === r.userId)?.at?.toISOString() ?? null,
      }));
      // Pending invitations are for Admins only.
      if (!MANAGERS.includes(me.role)) return c.json({ members, invitations: undefined as PendingInvitation[] | undefined }, 200);
      const invitations = await db
        .select({ id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt })
        .from(invitation)
        .where(and(eq(invitation.organizationId, me.organizationId), eq(invitation.status, "pending")))
        .orderBy(asc(invitation.createdAt));
      return c.json(
        {
          members,
          invitations: invitations.map(
            (i): PendingInvitation => ({
              ...i,
              role: i.role as OrgRole,
              expiresAt: i.expiresAt.toISOString(),
              expired: i.expiresAt <= clock.now(),
            }),
          ),
        },
        200,
      );
    })
    .post("/invitations", managers, zValidator("json", inviteBody), async (c) => {
      const me = c.get("membership");
      const { email, role } = c.req.valid("json");
      const now = clock.now();
      const existing = await db.query.user.findFirst({ where: eq(userTable.email, email) });
      // One answer for both cases, so Admins can't probe other Organizations' Members or invitations.
      const taken = { error: "This email already has an Argus account or a pending invitation" };
      if (existing) return c.json(taken, 409);
      const [pending] = await db
        .select({ id: invitation.id })
        .from(invitation)
        .where(and(eq(invitation.email, email), eq(invitation.status, "pending"), gt(invitation.expiresAt, now)))
        .limit(1);
      if (pending) return c.json(taken, 409);

      const id = secureId();
      await db.transaction(async (tx) => {
        await tx.insert(invitation).values({
          id,
          organizationId: me.organizationId,
          email,
          role,
          status: "pending",
          createdAt: now,
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
          inviterId: me.userId,
        });
        await recordOrgAudit(tx, { ...auditBy(me), action: "member.invited", target: email, after: role });
      });
      await sendInvite(deps, { invitationId: id, email, organizationName: me.organizationName, role });
      return c.json({ invitation: { id, email, role } }, 201);
    })
    .delete("/invitations/:id", managers, async (c) => {
      const me = c.get("membership");
      const [invite] = await db
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.id, c.req.param("id")),
            eq(invitation.organizationId, me.organizationId),
            eq(invitation.status, "pending"),
          ),
        )
        .limit(1);
      if (!invite) return c.json({ error: "Invitation not found" }, 404);
      await db.transaction(async (tx) => {
        await tx.update(invitation).set({ status: "canceled" }).where(eq(invitation.id, invite.id));
        await recordOrgAudit(tx, { ...auditBy(me), action: "invitation.revoked", target: invite.email, before: invite.role });
      });
      return c.json({ ok: true }, 200);
    })
    .patch("/members/:id", managers, zValidator("json", roleBody), async (c) => {
      const me = c.get("membership");
      const { role } = c.req.valid("json");
      const target = await findMember(me.organizationId, c.req.param("id"));
      if (!target) return c.json({ error: "Member not found" }, 404);
      if (target.role === "owner") return c.json({ error: "The Owner's role changes only by transferring ownership" }, 409);
      if (target.role === role) return c.json({ ok: true }, 200);
      const changed = await db.transaction(async (tx) => {
        // Re-checked here: ownership may have moved to this Member since `findMember`.
        const rows = await tx
          .update(member)
          .set({ role })
          .where(and(eq(member.id, target.id), ne(member.role, "owner")))
          .returning();
        if (!rows.length) return false;
        await recordOrgAudit(tx, {
          ...auditBy(me),
          action: "member.role_changed",
          target: target.name,
          before: target.role,
          after: role,
        });
        return true;
      });
      if (!changed) return c.json({ error: "The Owner's role changes only by transferring ownership" }, 409);
      return c.json({ ok: true }, 200);
    })
    .delete("/members/:id", managers, async (c) => {
      const me = c.get("membership");
      const target = await findMember(me.organizationId, c.req.param("id"));
      if (!target) return c.json({ error: "Member not found" }, 404);
      if (target.role === "owner") return c.json({ error: "The Owner cannot be removed" }, 409);
      const removed = await db.transaction(async (tx) => {
        // Re-checked here: ownership may have moved to this Member since `findMember`.
        const rows = await tx
          .delete(member)
          .where(and(eq(member.id, target.id), ne(member.role, "owner")))
          .returning();
        if (!rows.length) return false;
        await signOutEverywhere(tx, [target.userId]);
        await recordOrgAudit(tx, { ...auditBy(me), action: "member.removed", target: target.name, before: target.role });
        return true;
      });
      if (!removed) return c.json({ error: "The Owner cannot be removed" }, 409);
      return c.json({ ok: true }, 200);
    })
    .post("/ownership", ownerOnly, zValidator("json", transferBody), async (c) => {
      const me = c.get("membership");
      const target = await findMember(me.organizationId, c.req.valid("json").memberId);
      if (!target) return c.json({ error: "Member not found" }, 404);
      if (target.id === me.memberId) return c.json({ error: "You are already the Owner" }, 409);
      await db.transaction(async (tx) => {
        // Demote first: the database allows only one Owner at a time.
        await tx.update(member).set({ role: "admin" }).where(eq(member.id, me.memberId));
        await tx.update(member).set({ role: "owner" }).where(eq(member.id, target.id));
        await recordOrgAudit(tx, {
          ...auditBy(me),
          action: "ownership.transferred",
          target: target.name,
          before: me.name,
          after: target.name,
        });
      });
      return c.json({ ok: true }, 200);
    })
    .delete("/", ownerOnly, zValidator("json", deleteBody), async (c) => {
      const me = c.get("membership");
      if (c.req.valid("json").confirmName !== me.organizationName) {
        return c.json({ error: "Type the Organization's name to confirm" }, 400);
      }
      await db.transaction(async (tx) => {
        // Nothing is hard-deleted (ADR 0003): the Organization is marked deleted and everyone loses access.
        const members = await tx.delete(member).where(eq(member.organizationId, me.organizationId)).returning();
        await signOutEverywhere(tx, members.map((m) => m.userId));
        await tx
          .update(invitation)
          .set({ status: "canceled" })
          .where(and(eq(invitation.organizationId, me.organizationId), eq(invitation.status, "pending")));
        await tx.update(organization).set({ deletedAt: clock.now() }).where(eq(organization.id, me.organizationId));
        await recordOrgAudit(tx, { ...auditBy(me), action: "organization.deleted", target: me.organizationName });
      });
      return c.json({ ok: true }, 200);
    })
    .get("/audit-log", managers, zValidator("query", auditQuery), async (c) => {
      const me = c.get("membership");
      const { category, actor, from } = c.req.valid("query");
      const entries = await listOrgAudit(db, me.organizationId, {
        category,
        actorId: actor,
        from: from ? new Date(from) : undefined,
      });
      return c.json({ entries }, 200);
    });
};
