import { and, desc, eq, gte } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { orgAuditLog } from "../db/schema";
import { secureId } from "../ids";

export const ORG_AUDIT_CATEGORIES = ["members", "case-roles", "sso", "integrations", "alerts", "teams", "ignored-observables"] as const;
export type OrgAuditCategory = (typeof ORG_AUDIT_CATEGORIES)[number];

export type OrgAuditAction =
  | "organization.created"
  | "organization.deleted"
  | "member.invited"
  | "invitation.revoked"
  | "member.joined"
  | "member.role_changed"
  | "member.removed"
  | "ownership.transferred"
  | "case_role.created"
  | "case_role.renamed"
  | "case_role.retired"
  | "integration.created"
  | "integration.credentials_rotated"
  | "integration.paused"
  | "integration.resumed"
  | "integration.write_back_enabled"
  | "integration.write_back_disabled"
  | "integration.response_actions_enabled"
  | "integration.response_actions_disabled"
  | "integration.response_action_defaults_changed"
  | "integration.host_containment_enabled"
  | "integration.host_containment_disabled"
  | "integration.destination_list_changed"
  | "integration.stream_gap"
  | "integration.deleted"
  | "sso.enabled"
  | "sso.changed"
  | "sso.disabled"
  | "teams.webhook_set"
  | "teams.webhook_changed"
  | "teams.webhook_removed"
  | "ignored_observable.added"
  | "ignored_observable.removed"
  | "alert.dismissed"
  | "alert.falcon_status_changed"
  | "alert.falcon_assignee_changed"
  | "alert.falcon_tags_changed";

/**
 * Who acted: a Member (or the Operator) by id and name at the time, CrowdStrike for changes made in
 * Falcon (named after the Falcon user), or the system itself.
 */
export type OrgAuditActor =
  | { type: "member"; id: string; name: string }
  | { type: "operator"; id: string }
  | { type: "crowdstrike"; name: string }
  | { type: "system" };

export type OrgAuditEntry = {
  organizationId: string;
  occurredAt: Date;
  actor: OrgAuditActor;
  category: OrgAuditCategory;
  action: OrgAuditAction;
  target?: string | null;
  before?: string | null;
  after?: string | null;
};

/** Appends one entry. Call it in the same transaction as the change it records. */
export async function recordOrgAudit(db: Db | Tx, entry: OrgAuditEntry) {
  const { actor } = entry;
  await db.insert(orgAuditLog).values({
    id: secureId(),
    organizationId: entry.organizationId,
    occurredAt: entry.occurredAt,
    actorType: actor.type,
    actorId: actor.type === "member" || actor.type === "operator" ? actor.id : null,
    // Operators are shown by role, not name: they are not part of the Organization.
    actorName: actor.type === "member" || actor.type === "crowdstrike" ? actor.name : actor.type === "operator" ? "Operator" : "System",
    category: entry.category,
    action: entry.action,
    target: entry.target ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

export type OrgAuditFilter = { category?: OrgAuditCategory; actorId?: string; from?: Date };

/** The Organization's entries, newest first. */
export async function listOrgAudit(db: Db, organizationId: string, filter: OrgAuditFilter = {}, limit = 500) {
  const rows = await db
    .select()
    .from(orgAuditLog)
    .where(
      and(
        eq(orgAuditLog.organizationId, organizationId),
        filter.category ? eq(orgAuditLog.category, filter.category) : undefined,
        filter.actorId ? eq(orgAuditLog.actorId, filter.actorId) : undefined,
        filter.from ? gte(orgAuditLog.occurredAt, filter.from) : undefined,
      ),
    )
    .orderBy(desc(orgAuditLog.occurredAt), desc(orgAuditLog.seq))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actor: { type: row.actorType, id: row.actorId, name: row.actorName },
    category: row.category as OrgAuditCategory,
    action: row.action as OrgAuditAction,
    target: row.target,
    before: row.before,
    after: row.after,
  }));
}
