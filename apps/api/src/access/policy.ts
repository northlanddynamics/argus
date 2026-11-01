import { and, eq, exists, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { OrgRole } from "../auth/roles";
import { caseGuests, caseRoleAssignments, cases } from "../db/schema";

/**
 * The access policy: the one place that decides what an actor may see and do.
 * Routes and stores ask it; nothing else looks at roles, Restricted, the Assignee or Guest grants to decide access.
 *
 * - Owners and Admins see every Case in their Organization.
 * - Analysts see every non-Restricted Case, and a Restricted Case only while they are assigned to it:
 *   as its Assignee, or through a Case Role on it.
 * - Guests see only the Cases they hold a Guest grant for, until it ends or expires; Restricted makes
 *   no difference to them. They never see a Case's Audit Log or which other Cases an Observable or
 *   Asset is on.
 * - Nobody sees anything outside the Organization they are acting in.
 *
 * A Case the actor can't see is reported as not found, so its existence doesn't leak.
 */

/** The access policy doesn't let the actor do this. Modules throw it; routes answer 403. */
export class NotPermitted extends Error {}

/** A Member of one Organization. */
export type MemberActor = { organizationId: string; userId: string; role: OrgRole };
/**
 * A Guest acting in one Organization that granted them Cases. `at` is the moment their request is
 * judged at: a grant that has expired by then no longer counts.
 */
export type GuestActor = { organizationId: string; userId: string; role: "guest"; at: Date };
/** Who is acting. */
export type Actor = MemberActor | GuestActor;

/** A Guest grant on a Case that hasn't been ended; `expiresAt` (ISO) is when it stops counting, if ever. */
export type GuestGrantFact = { userId: string; expiresAt: string | null };

/**
 * What the policy needs to know about a Case. `caseRoleHolderIds`: who holds a Case Role on it now.
 * `guests`: the Guest grants on it that haven't been ended (some may have expired).
 */
export type CaseAccessFacts = {
  organizationId: string;
  restricted: boolean;
  assigneeId: string | null;
  caseRoleHolderIds: readonly string[];
  guests: readonly GuestGrantFact[];
};

export const isGuest = (actor: Actor): actor is GuestActor => actor.role === "guest";
const seesEveryCase = (actor: Actor) => actor.role === "owner" || actor.role === "admin";
const managesOrganization = (actor: Actor) => actor.role === "owner" || actor.role === "admin";
const isAssignee = (actor: Actor, c: Pick<CaseAccessFacts, "assigneeId">) => !isGuest(actor) && c.assigneeId === actor.userId;
/** Assigned to the Case: its Assignee, or holding a Case Role on it. */
const isAssigned = (actor: Actor, c: CaseAccessFacts) => isAssignee(actor, c) || c.caseRoleHolderIds.includes(actor.userId);
/** Whether `grant` still counts at `at`. */
const grantCounts = (grant: GuestGrantFact, at: Date) => grant.expiresAt === null || Date.parse(grant.expiresAt) > at.getTime();

/** Whether `actor` can see the Case at all. Mirrors `visibleCases`, which does the same in SQL. */
export function canSeeCase(actor: Actor, c: CaseAccessFacts) {
  if (c.organizationId !== actor.organizationId) return false;
  if (isGuest(actor)) return c.guests.some((g) => g.userId === actor.userId && grantCounts(g, actor.at));
  return seesEveryCase(actor) || !c.restricted || isAssigned(actor, c);
}

/** Guest grants held by `userId` that count at `at`, as a condition on the `case_guests` table. */
export const countingGrants = (userId: string, at: Date) =>
  and(eq(caseGuests.userId, userId), isNull(caseGuests.endedAt), or(isNull(caseGuests.expiresAt), gt(caseGuests.expiresAt, at)));

/** The Cases `actor` can see, as a condition on the `cases` table. Mirrors `canSeeCase`. */
export function visibleCases(actor: Actor): SQL {
  const inOrganization = eq(cases.organizationId, actor.organizationId);
  if (isGuest(actor)) {
    const holdsGrant = exists(
      sql`(select 1 from ${caseGuests} where ${caseGuests.caseId} = ${cases.id} and ${countingGrants(actor.userId, actor.at)})`,
    );
    return and(inOrganization, holdsGrant) as SQL;
  }
  if (seesEveryCase(actor)) return inOrganization;
  const holdsCaseRole = exists(
    sql`(select 1 from ${caseRoleAssignments} where ${caseRoleAssignments.caseId} = ${cases.id} and ${and(
      eq(caseRoleAssignments.userId, actor.userId),
      isNull(caseRoleAssignments.endedAt),
    )})`,
  );
  return and(inOrganization, or(eq(cases.restricted, false), eq(cases.assigneeId, actor.userId), holdsCaseRole)) as SQL;
}

/** Case permissions, for a Case the actor can already see. */
export const casePolicy = {
  /** Admins, the Owner and the Case's Assignee (not Case Role holders) mark a Case Restricted or lift it. */
  canRestrict: (actor: Actor, c: Pick<CaseAccessFacts, "assigneeId">) => seesEveryCase(actor) || isAssignee(actor, c),
  /** Only Admins and the Owner reopen a Closed Case. */
  canReopen: (actor: Actor) => managesOrganization(actor),
  /** Admins, the Owner and the Case's Assignee invite Guests to it and remove them. */
  canManageGuests: (actor: Actor, c: Pick<CaseAccessFacts, "assigneeId">) => seesEveryCase(actor) || isAssignee(actor, c),
  /** Members only: Guests never see a Case's Audit Log. */
  canReadAuditLog: (actor: Actor) => !isGuest(actor),
  /** Members only: Guests never learn which other Cases an Observable or Asset is on. */
  canSeeCorrelation: (actor: Actor) => !isGuest(actor),
  /** Members only, for now: Guests read their Cases but change nothing on them. */
  canWork: (actor: Actor) => !isGuest(actor),
};

/** Discussion permissions, for a message on a Case the actor can already see. */
export const discussionPolicy = {
  /** Only a message's author edits or retracts it. */
  canChangeMessage: (actor: Actor, message: { authorId: string }) => message.authorId === actor.userId,
};

/** Organization permissions. */
export const organizationPolicy = {
  /** Invite, change the role of and remove Members; see pending invitations. */
  canManageMembers: managesOrganization,
  canReadAuditLog: managesOrganization,
  /** Create, rename and retire the Organization's Case Roles. */
  canManageCaseRoles: managesOrganization,
  /** Add Integrations, rotate their credentials, pause and resume them, and see which credentials are in use. */
  canManageIntegrations: managesOrganization,
  /** Transfer ownership and delete the Organization. */
  canActAsOwner: (actor: Actor) => actor.role === "owner",
};

/** What `actor` may do on a Case they can see, for the client to show or hide controls. */
export const casePermissions = (actor: Actor, c: Pick<CaseAccessFacts, "assigneeId">) => ({
  /** Change the Case and add to it (unless it's Closed). */
  work: casePolicy.canWork(actor),
  restrict: casePolicy.canRestrict(actor, c),
  reopen: casePolicy.canReopen(actor),
  manageGuests: casePolicy.canManageGuests(actor, c),
  readAuditLog: casePolicy.canReadAuditLog(actor),
});
