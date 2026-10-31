import { and, count, desc, eq, inArray } from "drizzle-orm";
import { NotPermitted, organizationPolicy } from "../access/policy";
import { listOrgAudit, recordOrgAudit, type OrgAuditFilter } from "../audit/org-audit-log";
import { signOutEverywhere } from "../auth/sessions";
import { invitation, member, organization, user } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import { createInvitation } from "../invitations/invitations";
import { sendInvite } from "../invitations/invite-email";
import type { Membership } from "../members/membership";
import { publish } from "../realtime/signals";

/**
 * Organizations as a whole: Operators create and list them; the Owner deletes one; Admins read its
 * Organization Audit Log. Callers must have established that an `Operator` is one.
 */

/** An Operator, already checked to be one. */
export type Operator = { id: string };

/** The Owner didn't type the Organization's name to confirm deleting it. */
export class ConfirmationMismatch extends Error {
  constructor() {
    super("Type the Organization's name to confirm");
  }
}

const slugify = (name: string) =>
  `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)}-${secureId().slice(0, 6).toLowerCase()}`;

export function organizationStore(deps: Pick<Deps, "db" | "clock" | "mailer" | "baseUrl">) {
  const { db, clock } = deps;

  return {
    /** Every Organization, newest first, with its Owner (or the pending Owner invitation) and Member count. */
    async list() {
      const orgs = await db.select().from(organization).orderBy(desc(organization.createdAt));
      const ids = orgs.map((o) => o.id);
      const [owners, ownerInvites, memberCounts] = ids.length
        ? await Promise.all([
            db
              .select({ organizationId: member.organizationId, email: user.email })
              .from(member)
              .innerJoin(user, eq(member.userId, user.id))
              .where(and(inArray(member.organizationId, ids), eq(member.role, "owner"))),
            db
              .select({ organizationId: invitation.organizationId, email: invitation.email })
              .from(invitation)
              .where(and(inArray(invitation.organizationId, ids), eq(invitation.role, "owner"), eq(invitation.status, "pending")))
              .orderBy(desc(invitation.createdAt)),
            db
              .select({ organizationId: member.organizationId, n: count() })
              .from(member)
              .where(inArray(member.organizationId, ids))
              .groupBy(member.organizationId),
          ])
        : [[], [], []];
      return orgs.map((org) => {
        const owner = owners.find((o) => o.organizationId === org.id);
        // Newest first, so this is the latest pending Owner invitation.
        const pending = ownerInvites.find((i) => i.organizationId === org.id);
        return {
          id: org.id,
          name: org.name,
          createdAt: org.createdAt.toISOString(),
          deleted: org.deletedAt !== null,
          members: memberCounts.find((m) => m.organizationId === org.id)?.n ?? 0,
          owner: owner
            ? { email: owner.email, status: "active" as const }
            : pending
              ? { email: pending.email, status: "invited" as const }
              : null,
        };
      });
    },

    /** Creates an Organization with no Members yet, and invites `ownerEmail` to own it. */
    async create(operator: Operator, input: { name: string; ownerEmail: string }) {
      const { name, ownerEmail } = input;
      const now = clock.now();
      const org = { id: secureId(), name, slug: slugify(name), createdAt: now };
      const invitationId = await db.transaction(async (tx) => {
        await tx.insert(organization).values(org);
        const id = await createInvitation(tx, { organizationId: org.id, email: ownerEmail, role: "owner", inviterId: operator.id, now });
        const audit = { organizationId: org.id, occurredAt: now, actor: { type: "operator", id: operator.id }, category: "members" } as const;
        await recordOrgAudit(tx, { ...audit, action: "organization.created", target: name, after: ownerEmail });
        await recordOrgAudit(tx, { ...audit, action: "member.invited", target: ownerEmail, after: "owner" });
        return id;
      });
      await sendInvite(deps, { invitationId, email: ownerEmail, organizationName: name, role: "owner" });
      return { id: org.id, name: org.name };
    },

    /**
     * Deletes `me`'s Organization once they confirm its name. The Owner only. Nothing is
     * hard-deleted (ADR 0003): it is marked deleted, and every Member loses access at once.
     */
    async delete(me: Membership, confirmName: string) {
      if (!organizationPolicy.canActAsOwner(me)) throw new NotPermitted();
      if (confirmName !== me.organizationName) throw new ConfirmationMismatch();
      await db.transaction(async (tx) => {
        const members = await tx.delete(member).where(eq(member.organizationId, me.organizationId)).returning();
        await signOutEverywhere(tx, members.map((m) => m.userId));
        await tx
          .update(invitation)
          .set({ status: "canceled" })
          .where(and(eq(invitation.organizationId, me.organizationId), eq(invitation.status, "pending")));
        await tx.update(organization).set({ deletedAt: clock.now() }).where(eq(organization.id, me.organizationId));
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: clock.now(),
          actor: { type: "member", id: me.userId, name: me.name },
          category: "members",
          action: "organization.deleted",
          target: me.organizationName,
        });
        await publish(tx, { kind: "members", organizationId: me.organizationId });
      });
    },

    /** The Organization Audit Log, newest first. Admins and the Owner only. */
    async auditLog(me: Membership, filter: OrgAuditFilter) {
      if (!organizationPolicy.canReadAuditLog(me)) throw new NotPermitted();
      return listOrgAudit(db, me.organizationId, filter);
    },
  };
}

export type OrganizationStore = ReturnType<typeof organizationStore>;
