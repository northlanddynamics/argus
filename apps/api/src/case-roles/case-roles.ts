import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { canSeeCase, NotPermitted, organizationPolicy } from "../access/policy";
import { recordOrgAudit, type OrgAuditEntry } from "../audit/org-audit-log";
import { actorOf, lockCase } from "../cases/cases";
import { recordCaseAudit } from "../cases/case-audit-log";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { caseRoleAssignments, caseRoles, user } from "../db/schema";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import { memberName } from "../members/members";
import { publish } from "../realtime/signals";
import { caseRoleAssignmentsOf } from "./holders";

/**
 * Case Roles: the Organization's catalog, which Admins maintain, and the Case Roles given to Members
 * on a Case, which anyone working the Case can change. Holding a Case Role on a Case counts as being
 * assigned to it, so it lets an Analyst see it while it is Restricted (`access/policy.ts`).
 */

export class CaseRoleNotFound extends Error {
  constructor() {
    super("Case Role not found");
  }
}
/** Another active Case Role already has this name. */
export class CaseRoleNameTaken extends Error {
  constructor(name: string) {
    super(`There is already a Case Role named ${name}`);
  }
}
/** A retired Case Role can't be given to anyone or renamed. */
export class CaseRoleRetired extends Error {
  constructor() {
    super("This Case Role is retired");
  }
}
/** The person given a Case Role isn't a Member of the Organization. */
export class NotAMember extends Error {
  constructor() {
    super("A Case Role can only be given to a Member of the Organization");
  }
}
export class AssignmentNotFound extends Error {
  constructor() {
    super("Case Role assignment not found");
  }
}

/** Postgres's unique_violation, which Drizzle wraps as `cause`. */
const isUniqueViolation = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "23505";

/** Locks the Case Role of `me`'s Organization for the rest of `tx`, or throws `CaseRoleNotFound`. */
const lockRole = async (tx: Tx, me: Membership, id: string) => {
  const [row] = await tx
    .select()
    .from(caseRoles)
    .where(and(eq(caseRoles.id, id), eq(caseRoles.organizationId, me.organizationId)))
    .for("update");
  if (!row) throw new CaseRoleNotFound();
  return row;
};

/** Runs `work`, turning a clash with another active Case Role's name into `CaseRoleNameTaken`. */
const uniqueName = async <T>(name: string, work: () => Promise<T>) => {
  try {
    return await work();
  } catch (e) {
    if (isUniqueViolation(e)) throw new CaseRoleNameTaken(name);
    throw e;
  }
};

const catalogEntry = (row: { id: string; name: string; retiredAt: Date | null; cases?: number }) => ({
  id: row.id,
  name: row.name,
  retired: row.retiredAt !== null,
  /** How many Cases someone holds it on now. */
  cases: row.cases ?? 0,
});

export function caseRoleStore({ db, clock }: { db: Db; clock: Clock }) {
  const auditBy = (me: Membership): Omit<OrgAuditEntry, "action"> => ({
    organizationId: me.organizationId,
    occurredAt: clock.now(),
    actor: { type: "member", id: me.userId, name: me.name },
    category: "case-roles",
  });

  return {
    /** The catalog, active Case Roles first, then by name. Every Member reads it, to give Case Roles. */
    async catalog(me: Membership) {
      const rows = await db
        .select({
          id: caseRoles.id,
          name: caseRoles.name,
          retiredAt: caseRoles.retiredAt,
          cases: sql<number>`count(distinct ${caseRoleAssignments.caseId})::int`,
        })
        .from(caseRoles)
        .leftJoin(caseRoleAssignments, and(eq(caseRoleAssignments.caseRoleId, caseRoles.id), isNull(caseRoleAssignments.endedAt)))
        .where(eq(caseRoles.organizationId, me.organizationId))
        .groupBy(caseRoles.id)
        .orderBy(sql`${caseRoles.retiredAt} IS NOT NULL`, asc(sql`lower(${caseRoles.name})`), asc(caseRoles.createdAt));
      return rows.map(catalogEntry);
    },

    /** Adds a Case Role to the catalog. Admins and the Owner only. */
    async create(me: Membership, name: string) {
      if (!organizationPolicy.canManageCaseRoles(me)) throw new NotPermitted();
      const row = { id: secureId(), organizationId: me.organizationId, name, createdAt: clock.now(), retiredAt: null };
      await uniqueName(name, () =>
        db.transaction(async (tx) => {
          await tx.insert(caseRoles).values(row);
          await recordOrgAudit(tx, { ...auditBy(me), action: "case_role.created", target: name });
        }),
      );
      return catalogEntry(row);
    },

    /** Renames an active Case Role, wherever it is held. Admins and the Owner only. */
    async rename(me: Membership, id: string, name: string) {
      if (!organizationPolicy.canManageCaseRoles(me)) throw new NotPermitted();
      return uniqueName(name, () =>
        db.transaction(async (tx) => {
          const current = await lockRole(tx, me, id);
          if (current.retiredAt) throw new CaseRoleRetired();
          if (current.name === name) return catalogEntry(current);
          await tx.update(caseRoles).set({ name }).where(eq(caseRoles.id, id));
          await recordOrgAudit(tx, { ...auditBy(me), action: "case_role.renamed", target: name, before: current.name, after: name });
          return catalogEntry({ ...current, name });
        }),
      );
    },

    /**
     * Retires a Case Role: it is no longer offered, and its name is free again. Those holding it on
     * Cases keep it until someone takes it away. Admins and the Owner only.
     */
    async retire(me: Membership, id: string) {
      if (!organizationPolicy.canManageCaseRoles(me)) throw new NotPermitted();
      await db.transaction(async (tx) => {
        const current = await lockRole(tx, me, id);
        if (current.retiredAt) return;
        await tx.update(caseRoles).set({ retiredAt: clock.now() }).where(eq(caseRoles.id, id));
        await recordOrgAudit(tx, { ...auditBy(me), action: "case_role.retired", target: current.name });
      });
    },

    /**
     * Gives Member `userId` an active Case Role on Case `number`. Giving someone a Case Role they
     * already hold there changes nothing. Returns the Case's Case Role assignments.
     */
    async assign(me: Membership, number: number, input: { caseRoleId: string; userId: string }) {
      const now = clock.now();
      const caseId = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const role = await lockRole(tx, me, input.caseRoleId);
        if (role.retiredAt) throw new CaseRoleRetired();
        const holderName = await memberName(tx, me.organizationId, input.userId);
        if (holderName === null) throw new NotAMember();
        const [held] = await tx
          .select({ n: count() })
          .from(caseRoleAssignments)
          .where(
            and(
              eq(caseRoleAssignments.caseId, current.id),
              eq(caseRoleAssignments.caseRoleId, role.id),
              eq(caseRoleAssignments.userId, input.userId),
              isNull(caseRoleAssignments.endedAt),
            ),
          );
        if (held?.n) return current.id;
        await tx.insert(caseRoleAssignments).values({
          id: secureId(),
          organizationId: me.organizationId,
          caseId: current.id,
          caseRoleId: role.id,
          userId: input.userId,
          assignedById: me.userId,
          assignedAt: now,
        });
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "case_role.assigned",
          target: holderName,
          after: role.name,
        });
        const before = { caseRoleHolderIds: current.caseRoleHolderIds };
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id, before });
        return current.id;
      });
      return caseRoleAssignmentsOf(db, caseId);
    },

    /**
     * Takes a Case Role assignment away. Returns the Case's Case Role assignments, or null when that
     * leaves `me` unable to see the Case (an Analyst giving up their own Case Role on a Restricted Case).
     */
    async unassign(me: Membership, number: number, assignmentId: string) {
      const now = clock.now();
      const result = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const [assignment] = await tx
          .select({ id: caseRoleAssignments.id, userId: caseRoleAssignments.userId, caseRoleId: caseRoleAssignments.caseRoleId })
          .from(caseRoleAssignments)
          .where(
            and(
              eq(caseRoleAssignments.id, assignmentId),
              eq(caseRoleAssignments.caseId, current.id),
              isNull(caseRoleAssignments.endedAt),
            ),
          )
          .for("update");
        if (!assignment) throw new AssignmentNotFound();
        await tx
          .update(caseRoleAssignments)
          .set({ endedAt: now, endedById: me.userId })
          .where(eq(caseRoleAssignments.id, assignment.id));
        const [role] = await tx.select({ name: caseRoles.name }).from(caseRoles).where(eq(caseRoles.id, assignment.caseRoleId));
        // By name even if they have since left the Organization.
        const [holder] = await tx.select({ name: user.name }).from(user).where(eq(user.id, assignment.userId));
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "case_role.unassigned",
          target: holder?.name ?? null,
          before: role?.name ?? null,
        });
        const before = { caseRoleHolderIds: current.caseRoleHolderIds };
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id, before });
        return current;
      });
      const assignments = await caseRoleAssignmentsOf(db, result.id);
      const after = { ...result, caseRoleHolderIds: [...new Set(assignments.map((a) => a.holder.id))] };
      return canSeeCase(me, after) ? assignments : null;
    },
  };
}

export type CaseRoleStore = ReturnType<typeof caseRoleStore>;
