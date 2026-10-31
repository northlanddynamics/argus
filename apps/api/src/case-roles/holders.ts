import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { caseRoleAssignments, caseRoles, user } from "../db/schema";

/**
 * Who holds Case Roles on a Case now. Kept apart from the Case Role module so the Case module and
 * the live hub can read it without depending on the rest of it.
 */

/** The people holding at least one Case Role on the Case now, once each. */
export async function caseRoleHolderIds(db: Db | Tx, caseId: string) {
  const rows = await db
    .selectDistinct({ userId: caseRoleAssignments.userId })
    .from(caseRoleAssignments)
    .where(and(eq(caseRoleAssignments.caseId, caseId), isNull(caseRoleAssignments.endedAt)));
  return rows.map((r) => r.userId);
}

/** The Case's current Case Role assignments, by Case Role name, then holder name. */
export async function caseRoleAssignmentsOf(db: Db | Tx, caseId: string) {
  const rows = await db
    .select({
      id: caseRoleAssignments.id,
      caseRoleId: caseRoles.id,
      caseRoleName: caseRoles.name,
      retired: caseRoles.retiredAt,
      userId: user.id,
      userName: user.name,
    })
    .from(caseRoleAssignments)
    .innerJoin(caseRoles, eq(caseRoleAssignments.caseRoleId, caseRoles.id))
    .innerJoin(user, eq(caseRoleAssignments.userId, user.id))
    .where(and(eq(caseRoleAssignments.caseId, caseId), isNull(caseRoleAssignments.endedAt)))
    .orderBy(asc(caseRoles.name), asc(user.name), asc(caseRoleAssignments.assignedAt));
  return rows.map((r) => ({
    id: r.id,
    caseRole: { id: r.caseRoleId, name: r.caseRoleName, retired: r.retired !== null },
    holder: { id: r.userId, name: r.userName },
  }));
}

export type CaseRoleAssignmentView = Awaited<ReturnType<typeof caseRoleAssignmentsOf>>[number];
