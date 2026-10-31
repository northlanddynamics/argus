import { asc, eq } from "drizzle-orm";
import { type CaseAccessFacts, canSeeCase } from "../access/policy";
import type { OrgRole } from "../auth/roles";
import type { Db, Tx } from "../db/client";
import { member, user } from "../db/schema";

/**
 * The Members who can see a Case, by name: who can be mentioned on it or given work on it.
 * Guests arrive with later work.
 */
export async function peopleWhoCanSee(db: Db | Tx, theCase: CaseAccessFacts) {
  const rows = await db
    .select({ id: user.id, name: user.name, role: member.role })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, theCase.organizationId))
    .orderBy(asc(user.name), asc(user.id));
  return rows
    .map((r) => ({ id: r.id, name: r.name, role: r.role as OrgRole }))
    .filter((p) => canSeeCase({ organizationId: theCase.organizationId, userId: p.id, role: p.role }, theCase));
}

export type Person = Awaited<ReturnType<typeof peopleWhoCanSee>>[number];
