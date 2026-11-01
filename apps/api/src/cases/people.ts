import { and, asc, eq, inArray } from "drizzle-orm";
import { type CaseAccessFacts, canSeeCase, canSeeItem, type InternalFact } from "../access/policy";
import type { OrgRole } from "../auth/roles";
import type { Db, Tx } from "../db/client";
import { member, user } from "../db/schema";

/** Someone who can see a Case: a Member, or a Guest whose grant on it counts. */
export type Person = { id: string; name: string; role: OrgRole | "guest" };

/**
 * The people who can see a Case at `at`, by name: who can be mentioned on it or given work on it.
 * Members first, then Guests. With `item`, only those who can also see that item (no Guests on an
 * Internal one).
 */
export async function peopleWhoCanSee(db: Db | Tx, theCase: CaseAccessFacts, at: Date, item?: InternalFact): Promise<Person[]> {
  const rows = await db
    .select({ id: user.id, name: user.name, role: member.role })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, theCase.organizationId))
    .orderBy(asc(user.name), asc(user.id));
  const members = rows
    .map((r) => ({ id: r.id, name: r.name, role: r.role as OrgRole }))
    .filter((p) => canSeeCase({ organizationId: theCase.organizationId, userId: p.id, role: p.role }, theCase));
  if (item && !canSeeItem({ role: "guest" }, item)) return members;
  const guestIds = theCase.guests
    .map((g) => g.userId)
    .filter((userId) => canSeeCase({ organizationId: theCase.organizationId, userId, role: "guest", at }, theCase));
  if (!guestIds.length) return members;
  const guests = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, guestIds))
    .orderBy(asc(user.name), asc(user.id));
  return [...members, ...guests.map((g) => ({ ...g, role: "guest" as const }))];
}

/** Which of `ids` are Members of the Organization; anyone else on a Case is a Guest. */
export async function membersAmong(db: Db | Tx, organizationId: string, ids: readonly string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), inArray(member.userId, [...ids])));
  return new Set(rows.map((r) => r.userId));
}
