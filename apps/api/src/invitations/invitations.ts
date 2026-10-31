import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { NotPermitted, organizationPolicy } from "../access/policy";
import { recordOrgAudit } from "../audit/org-audit-log";
import type { OrgRole } from "../auth/roles";
import type { Tx } from "../db/client";
import { invitation, member, organization, user } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import { INVITE_TTL_MS, sendInvite } from "./invite-email";

/**
 * Invitations into an Organization: sending, revoking, listing the pending ones and accepting.
 * Whoever accepts one gets an Argus account and becomes a Member with the invited role.
 */

/** The email already belongs to an Argus account or has a pending invitation. */
export class EmailTaken extends Error {
  constructor() {
    // One answer for both cases, so Admins can't probe other Organizations' Members or invitations.
    super("This email already has an Argus account or a pending invitation");
  }
}
/** No pending invitation with this id (or in this Organization, or its Organization was deleted). */
export class InvitationNotFound extends Error {
  constructor() {
    super("Invitation not found");
  }
}
export class InvitationExpired extends Error {
  constructor() {
    super("Invitation expired");
  }
}
/** Someone signed up with the invited email since the invitation was sent. */
export class AccountExists extends Error {
  constructor() {
    super("An account already exists for this email");
  }
}

export type PendingInvitation = { id: string; email: string; role: OrgRole; expiresAt: string; expired: boolean };

/**
 * Inserts a pending invitation and returns its id. Joins `tx`; the caller records it in the
 * Organization Audit Log and sends the email (`sendInvite`) once `tx` has committed.
 */
export async function createInvitation(
  tx: Tx,
  input: { organizationId: string; email: string; role: OrgRole; inviterId: string; now: Date },
) {
  const id = secureId();
  await tx.insert(invitation).values({
    id,
    organizationId: input.organizationId,
    email: input.email,
    role: input.role,
    status: "pending",
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + INVITE_TTL_MS),
    inviterId: input.inviterId,
  });
  return id;
}

export function invitationStore(deps: Pick<Deps, "db" | "auth" | "clock" | "mailer" | "baseUrl">) {
  const { db, auth, clock } = deps;

  /** The pending, unexpired invitation, or throws `InvitationNotFound` / `InvitationExpired`. */
  const findOpen = async (id: string) => {
    const [row] = await db
      .select({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        organizationId: organization.id,
        organizationName: organization.name,
      })
      .from(invitation)
      .innerJoin(organization, eq(invitation.organizationId, organization.id))
      .where(and(eq(invitation.id, id), isNull(organization.deletedAt)))
      .limit(1);
    if (!row || row.status !== "pending") throw new InvitationNotFound();
    if (row.expiresAt <= clock.now()) throw new InvitationExpired();
    return row;
  };

  return {
    /** Invites `email` into `me`'s Organization as `role`, and emails them the link. Admins and the Owner only. */
    async invite(me: Membership, email: string, role: Exclude<OrgRole, "owner">) {
      if (!organizationPolicy.canManageMembers(me)) throw new NotPermitted();
      const now = clock.now();
      const existing = await db.query.user.findFirst({ where: eq(user.email, email) });
      if (existing) throw new EmailTaken();
      const [pending] = await db
        .select({ id: invitation.id })
        .from(invitation)
        .where(and(eq(invitation.email, email), eq(invitation.status, "pending"), gt(invitation.expiresAt, now)))
        .limit(1);
      if (pending) throw new EmailTaken();

      const id = await db.transaction(async (tx) => {
        const created = await createInvitation(tx, { organizationId: me.organizationId, email, role, inviterId: me.userId, now });
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: now,
          actor: { type: "member", id: me.userId, name: me.name },
          category: "members",
          action: "member.invited",
          target: email,
          after: role,
        });
        return created;
      });
      await sendInvite(deps, { invitationId: id, email, organizationName: me.organizationName, role });
      return { id, email, role };
    },

    /** Cancels a pending invitation in `me`'s Organization. Admins and the Owner only. */
    async revoke(me: Membership, id: string) {
      if (!organizationPolicy.canManageMembers(me)) throw new NotPermitted();
      const [invite] = await db
        .select()
        .from(invitation)
        .where(and(eq(invitation.id, id), eq(invitation.organizationId, me.organizationId), eq(invitation.status, "pending")))
        .limit(1);
      if (!invite) throw new InvitationNotFound();
      await db.transaction(async (tx) => {
        await tx.update(invitation).set({ status: "canceled" }).where(eq(invitation.id, invite.id));
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: clock.now(),
          actor: { type: "member", id: me.userId, name: me.name },
          category: "members",
          action: "invitation.revoked",
          target: invite.email,
          before: invite.role,
        });
      });
    },

    /** The Organization's pending invitations, oldest first; undefined for Members who can't manage Members. */
    async pending(me: Membership): Promise<PendingInvitation[] | undefined> {
      if (!organizationPolicy.canManageMembers(me)) return undefined;
      const rows = await db
        .select({ id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt })
        .from(invitation)
        .where(and(eq(invitation.organizationId, me.organizationId), eq(invitation.status, "pending")))
        .orderBy(asc(invitation.createdAt));
      const now = clock.now();
      return rows.map((i) => ({ ...i, role: i.role as OrgRole, expiresAt: i.expiresAt.toISOString(), expired: i.expiresAt <= now }));
    },

    /** What the invitation offers, for the person accepting it. */
    async open(id: string) {
      const invite = await findOpen(id);
      return { email: invite.email, role: invite.role, organization: { name: invite.organizationName } };
    },

    /** Creates the invited person's account and makes them a Member with the invited role. */
    async accept(id: string, input: { name: string; password: string }) {
      const invite = await findOpen(id);
      const existing = await db.query.user.findFirst({ where: eq(user.email, invite.email) });
      if (existing) throw new AccountExists();

      // Server-side calls: no session, so Better Auth treats them as trusted.
      const { user: created } = await auth.api.createUser({
        body: { email: invite.email, password: input.password, name: input.name, role: "user", data: { emailVerified: true } },
      });
      const role = (invite.role ?? "analyst") as OrgRole;
      const now = clock.now();
      await db.transaction(async (tx) => {
        await tx.insert(member).values({ id: secureId(), organizationId: invite.organizationId, userId: created.id, role, createdAt: now });
        await tx.update(invitation).set({ status: "accepted" }).where(eq(invitation.id, invite.id));
        await recordOrgAudit(tx, {
          organizationId: invite.organizationId,
          occurredAt: now,
          actor: { type: "member", id: created.id, name: input.name },
          category: "members",
          action: "member.joined",
          target: invite.email,
          after: role,
        });
      });
      return { email: invite.email };
    },
  };
}

export type InvitationStore = ReturnType<typeof invitationStore>;
