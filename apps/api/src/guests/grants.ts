import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { countingGrants, type GuestGrantFact } from "../access/policy";
import type { Db, Tx } from "../db/client";
import { caseGuests, cases, organization } from "../db/schema";

/**
 * Guest grants as the access policy and the rest of the app read them. Kept apart from the Guest
 * module so the Case module and the live hub can read them without depending on the rest of it.
 */

/** The Guest grants on a Case that haven't been ended, expired or not. */
export async function guestGrantsOf(db: Db | Tx, caseId: string): Promise<GuestGrantFact[]> {
  const rows = await db
    .select({ userId: caseGuests.userId, expiresAt: caseGuests.expiresAt })
    .from(caseGuests)
    .where(and(eq(caseGuests.caseId, caseId), isNull(caseGuests.endedAt)));
  return rows.map((r) => ({ userId: r.userId, expiresAt: r.expiresAt?.toISOString() ?? null }));
}

/**
 * Every Case `userId` holds a counting Guest grant for at `at`, across Organizations: newest grant
 * first. Deleted Organizations' Cases are left out.
 */
export async function guestCasesOf(db: Db | Tx, userId: string, at: Date) {
  const rows = await db
    .select({
      organizationId: organization.id,
      organizationName: organization.name,
      number: cases.number,
      title: cases.title,
      expiresAt: caseGuests.expiresAt,
    })
    .from(caseGuests)
    .innerJoin(cases, eq(caseGuests.caseId, cases.id))
    .innerJoin(organization, eq(caseGuests.organizationId, organization.id))
    .where(and(countingGrants(userId, at), isNull(organization.deletedAt)))
    .orderBy(desc(caseGuests.invitedAt), desc(caseGuests.seq), asc(cases.number));
  return rows.map((r) => ({
    organization: { id: r.organizationId, name: r.organizationName },
    number: r.number,
    title: r.title,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  }));
}

export type GuestCase = Awaited<ReturnType<typeof guestCasesOf>>[number];
