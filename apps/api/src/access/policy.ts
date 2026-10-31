import { and, eq, or, type SQL } from "drizzle-orm";
import type { OrgRole } from "../auth/roles";
import { cases } from "../db/schema";

/**
 * The access policy: the one place that decides what an actor may see and do.
 * Routes and stores ask it; nothing else looks at roles, Restricted or the Assignee to decide access.
 *
 * - Owners and Admins see every Case in their Organization.
 * - Analysts see every non-Restricted Case, and a Restricted Case only while they are assigned to it.
 *   (Case Roles will also count as assigned once they exist.)
 * - Nobody sees anything outside their own Organization.
 *
 * A Case the actor can't see is reported as not found, so its existence doesn't leak.
 */

/** The access policy doesn't let the actor do this. Modules throw it; routes answer 403. */
export class NotPermitted extends Error {}

/** Who is acting: a Member of one Organization. Guests arrive with later work. */
export type Actor = { organizationId: string; userId: string; role: OrgRole };

/** What the policy needs to know about a Case. */
export type CaseAccessFacts = { organizationId: string; restricted: boolean; assigneeId: string | null };

const seesEveryCase = (actor: Actor) => actor.role === "owner" || actor.role === "admin";
const managesOrganization = (actor: Actor) => actor.role === "owner" || actor.role === "admin";
const isAssigned = (actor: Actor, c: CaseAccessFacts) => c.assigneeId === actor.userId;

/** Whether `actor` can see the Case at all. Mirrors `visibleCases`, which does the same in SQL. */
export function canSeeCase(actor: Actor, c: CaseAccessFacts) {
  if (c.organizationId !== actor.organizationId) return false;
  return seesEveryCase(actor) || !c.restricted || isAssigned(actor, c);
}

/** The Cases `actor` can see, as a condition on the `cases` table. Mirrors `canSeeCase`. */
export function visibleCases(actor: Actor): SQL {
  const inOrganization = eq(cases.organizationId, actor.organizationId);
  if (seesEveryCase(actor)) return inOrganization;
  return and(inOrganization, or(eq(cases.restricted, false), eq(cases.assigneeId, actor.userId))) as SQL;
}

/** Case permissions, for a Case the actor can already see. */
export const casePolicy = {
  /** Admins, the Owner and the Case's Assignee mark a Case Restricted or lift it. */
  canRestrict: (actor: Actor, c: CaseAccessFacts) => seesEveryCase(actor) || isAssigned(actor, c),
  /** Only Admins and the Owner reopen a Closed Case. */
  canReopen: (actor: Actor) => managesOrganization(actor),
};

/** Organization permissions. */
export const organizationPolicy = {
  /** Invite, change the role of and remove Members; see pending invitations. */
  canManageMembers: managesOrganization,
  canReadAuditLog: managesOrganization,
  /** Transfer ownership and delete the Organization. */
  canActAsOwner: (actor: Actor) => actor.role === "owner",
};

/** What `actor` may do on a Case they can see, for the client to show or hide controls. */
export const casePermissions = (actor: Actor, c: CaseAccessFacts) => ({
  restrict: casePolicy.canRestrict(actor, c),
  reopen: casePolicy.canReopen(actor),
});
