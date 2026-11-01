import { and, desc, eq, gte } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { caseAuditLog } from "../db/schema";
import { secureId } from "../ids";
import type { CaseAuditAction } from "./vocabulary";

/** Who acted on a Case. CrowdStrike and the system arrive with later work. */
export type CaseActor = { type: "member" | "guest"; id: string; name: string };

export type CaseAuditEntry = {
  organizationId: string;
  caseId: string;
  occurredAt: Date;
  actor: CaseActor;
  action: CaseAuditAction;
  /** What within the Case was acted on, as named now: a Task's title, a Case Role holder's name. */
  target?: string | null;
  before?: string | null;
  after?: string | null;
};

/** Appends one entry. Call it in the same transaction as the change it records. */
export async function recordCaseAudit(tx: Tx, entry: CaseAuditEntry) {
  await tx.insert(caseAuditLog).values({
    id: secureId(),
    organizationId: entry.organizationId,
    caseId: entry.caseId,
    occurredAt: entry.occurredAt,
    actorType: entry.actor.type,
    actorId: entry.actor.id,
    actorName: entry.actor.name,
    action: entry.action,
    target: entry.target ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

export type CaseAuditFilter = { actorId?: string; action?: CaseAuditAction; from?: Date };

/** A Case's entries, newest first. */
export async function listCaseAudit(db: Db, caseId: string, filter: CaseAuditFilter = {}, limit = 1000) {
  const rows = await db
    .select()
    .from(caseAuditLog)
    .where(
      and(
        eq(caseAuditLog.caseId, caseId),
        filter.actorId ? eq(caseAuditLog.actorId, filter.actorId) : undefined,
        filter.action ? eq(caseAuditLog.action, filter.action) : undefined,
        filter.from ? gte(caseAuditLog.occurredAt, filter.from) : undefined,
      ),
    )
    .orderBy(desc(caseAuditLog.occurredAt), desc(caseAuditLog.seq))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actor: { type: row.actorType, id: row.actorId, name: row.actorName },
    action: row.action as CaseAuditAction,
    target: row.target,
    before: row.before,
    after: row.after,
  }));
}
