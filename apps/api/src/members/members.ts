import { and, asc, count, eq, max, ne, inArray } from "drizzle-orm";
import { NotPermitted, organizationPolicy } from "../access/policy";
import { recordOrgAudit, type OrgAuditEntry } from "../audit/org-audit-log";
import type { OrgRole } from "../auth/roles";
import { signOutEverywhere } from "../auth/sessions";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { account, member, passkey, session, user } from "../db/schema";
import type { Membership } from "./membership";
import { publish } from "../realtime/signals";

/**
 * The Members of one Organization: who they are, their roles, removing them and moving ownership.
 * Invitations are in `invitations/`.
 */

export class MemberNotFound extends Error {
  constructor() {
    super("Member not found");
  }
}
/** The Owner's role changes only by transferring ownership, and the Owner can't be removed. */
export class OwnerProtected extends Error {}
export class AlreadyOwner extends Error {
  constructor() {
    super("You are already the Owner");
  }
}

/** The Member's name, or null unless `userId` is a Member of `organizationId`. Joins `tx`. */
export async function memberName(tx: Db | Tx, organizationId: string, userId: string) {
  const [row] = await tx
    .select({ name: user.name })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  return row?.name ?? null;
}

/** The Member's name and role, or null unless `userId` is a Member of `organizationId`. Joins `tx`. */
export async function memberOf(tx: Db | Tx, organizationId: string, userId: string) {
  const [row] = await tx
    .select({ name: user.name, role: member.role })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  return row ? { userId, organizationId, name: row.name, role: row.role as OrgRole } : null;
}

const ROLE_CHANGE_REFUSED = "The Owner's role changes only by transferring ownership";
const REMOVAL_REFUSED = "The Owner cannot be removed";

export function memberStore({ db, clock }: { db: Db; clock: Clock }) {
  /** Fields every Organization Audit Log entry written by `by` shares. */
  const auditBy = (by: Membership): Omit<OrgAuditEntry, "action"> => ({
    organizationId: by.organizationId,
    occurredAt: clock.now(),
    actor: { type: "member", id: by.userId, name: by.name },
    category: "members",
  });

  /** The Member of `me`'s Organization with this member id, or throws `MemberNotFound`. */
  const find = async (me: Membership, memberId: string) => {
    const [row] = await db
      .select({ id: member.id, userId: member.userId, role: member.role, name: user.name })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(and(eq(member.id, memberId), eq(member.organizationId, me.organizationId)))
      .limit(1);
    if (!row) throw new MemberNotFound();
    return { ...row, role: row.role as OrgRole };
  };

  return {
    /** Every Member of `me`'s Organization, oldest first, with how they sign in and when they were last active. */
    async list(me: Membership) {
      const rows = await db
        .select({
          id: member.id,
          userId: user.id,
          name: user.name,
          email: user.email,
          role: member.role,
          totp: user.twoFactorEnabled,
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(eq(member.organizationId, me.organizationId))
        .orderBy(asc(member.createdAt), asc(user.createdAt));
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
      return rows.map((r) => ({
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
    },

    /** Gives a Member another role. Admins and the Owner only; never the Owner's role. */
    async changeRole(me: Membership, memberId: string, role: Exclude<OrgRole, "owner">) {
      if (!organizationPolicy.canManageMembers(me)) throw new NotPermitted();
      const target = await find(me, memberId);
      if (target.role === "owner") throw new OwnerProtected(ROLE_CHANGE_REFUSED);
      if (target.role === role) return;
      const changed = await db.transaction(async (tx) => {
        // Re-checked here: ownership may have moved to this Member since `find`.
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
        await publish(tx, { kind: "members", organizationId: me.organizationId });
        return true;
      });
      if (!changed) throw new OwnerProtected(ROLE_CHANGE_REFUSED);
    },

    /** Removes a Member and signs them out everywhere. Admins and the Owner only; never the Owner. */
    async remove(me: Membership, memberId: string) {
      if (!organizationPolicy.canManageMembers(me)) throw new NotPermitted();
      const target = await find(me, memberId);
      if (target.role === "owner") throw new OwnerProtected(REMOVAL_REFUSED);
      const removed = await db.transaction(async (tx) => {
        // Re-checked here: ownership may have moved to this Member since `find`.
        const rows = await tx
          .delete(member)
          .where(and(eq(member.id, target.id), ne(member.role, "owner")))
          .returning();
        if (!rows.length) return false;
        await signOutEverywhere(tx, [target.userId]);
        await recordOrgAudit(tx, { ...auditBy(me), action: "member.removed", target: target.name, before: target.role });
        await publish(tx, { kind: "members", organizationId: me.organizationId });
        return true;
      });
      if (!removed) throw new OwnerProtected(REMOVAL_REFUSED);
    },

    /** Makes another Member the Owner; `me` becomes an Admin. The Owner only. */
    async transferOwnership(me: Membership, memberId: string) {
      if (!organizationPolicy.canActAsOwner(me)) throw new NotPermitted();
      const target = await find(me, memberId);
      if (target.id === me.memberId) throw new AlreadyOwner();
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
        await publish(tx, { kind: "members", organizationId: me.organizationId });
      });
    },
  };
}

export type MemberStore = ReturnType<typeof memberStore>;
