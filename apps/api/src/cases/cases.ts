import { and, count, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { cases, member, organization, user } from "../db/schema";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import { type CaseActor, type CaseAuditEntry, listCaseAudit, recordCaseAudit, type CaseAuditFilter } from "./case-audit-log";
import { type CaseSummary, emptySummary } from "./case-summary";
import type { CaseType, Severity, Status } from "./vocabulary";

/**
 * Cases within one Organization. Every read and write goes through here and is scoped to the
 * acting Member's Organization, so a Case of another Organization is simply not found.
 */

export type OpenCaseInput = { title: string; caseType: CaseType; severity: Severity; summary?: CaseSummary };
export type CaseChanges = { status?: Status; severity?: Severity; caseType?: CaseType; assigneeId?: string | null };
export type CaseListView = "open" | "mine" | "unassigned" | "closed";
export type CaseListFilter = { view?: CaseListView; status?: Status; severity?: Severity; caseType?: CaseType };

export class CaseNotFound extends Error {}
export class NotAMember extends Error {}
export class StaleSummary extends Error {
  readonly current: CaseSummaryView;
  constructor(current: CaseSummaryView) {
    super("The Case Summary changed since you opened it");
    this.current = current;
  }
}

type Person = { id: string; name: string };
export type CaseSummaryView = { content: CaseSummary; version: number; updatedBy: Person; updatedAt: string };

const assignee = alias(user, "assignee");
const openedBy = alias(user, "opened_by");
const summaryBy = alias(user, "summary_by");

const listColumns = {
  number: cases.number,
  title: cases.title,
  status: cases.status,
  severity: cases.severity,
  caseType: cases.caseType,
  assigneeId: assignee.id,
  assigneeName: assignee.name,
  openedAt: cases.openedAt,
  updatedAt: cases.updatedAt,
};

type ListRow = {
  number: number;
  title: string;
  status: Status;
  severity: Severity;
  caseType: CaseType;
  assigneeId: string | null;
  assigneeName: string | null;
  openedAt: Date;
  updatedAt: Date;
};

const listItem = (row: ListRow) => ({
  number: row.number,
  title: row.title,
  status: row.status,
  severity: row.severity,
  caseType: row.caseType,
  assignee: row.assigneeId ? { id: row.assigneeId, name: row.assigneeName ?? "" } : null,
  openedAt: row.openedAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const actorOf = (me: Membership): CaseActor => ({ type: "member", id: me.userId, name: me.name });

/** The Member's name, or throws `NotAMember` unless `userId` belongs to `organizationId`. */
const memberName = async (tx: Db | Tx, organizationId: string, userId: string) => {
  const [row] = await tx
    .select({ name: user.name })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  if (!row) throw new NotAMember();
  return row.name;
};

export function caseStore({ db, clock }: { db: Db; clock: Clock }) {
  /** The Case's internal id, or throws `CaseNotFound` when it isn't in `organizationId`. */
  const findId = async (organizationId: string, number: number) => {
    const [row] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.organizationId, organizationId), eq(cases.number, number)))
      .limit(1);
    if (!row) throw new CaseNotFound();
    return row.id;
  };

  const view = async (organizationId: string, number: number) => {
    const [row] = await db
      .select({
        ...listColumns,
        openedById: openedBy.id,
        openedByName: openedBy.name,
        summary: cases.summary,
        summaryVersion: cases.summaryVersion,
        summaryById: summaryBy.id,
        summaryByName: summaryBy.name,
        summaryUpdatedAt: cases.summaryUpdatedAt,
      })
      .from(cases)
      .leftJoin(assignee, eq(cases.assigneeId, assignee.id))
      .innerJoin(openedBy, eq(cases.openedById, openedBy.id))
      .innerJoin(summaryBy, eq(cases.summaryUpdatedById, summaryBy.id))
      .where(and(eq(cases.organizationId, organizationId), eq(cases.number, number)))
      .limit(1);
    if (!row) throw new CaseNotFound();
    return {
      ...listItem(row),
      openedBy: { id: row.openedById, name: row.openedByName },
      summary: {
        content: row.summary,
        version: row.summaryVersion,
        updatedBy: { id: row.summaryById, name: row.summaryByName },
        updatedAt: row.summaryUpdatedAt.toISOString(),
      } satisfies CaseSummaryView,
    };
  };

  return {
    view,

    async open(me: Membership, input: OpenCaseInput) {
      const now = clock.now();
      const number = await db.transaction(async (tx) => {
        // Serialises numbering within the Organization.
        await tx.select({ id: organization.id }).from(organization).where(eq(organization.id, me.organizationId)).for("update");
        const [{ last }] = (await tx
          .select({ last: sql<number>`coalesce(max(${cases.number}), 0)::int` })
          .from(cases)
          .where(eq(cases.organizationId, me.organizationId))) as [{ last: number }];
        const id = secureId();
        await tx.insert(cases).values({
          id,
          organizationId: me.organizationId,
          number: last + 1,
          title: input.title,
          status: "new",
          severity: input.severity,
          caseType: input.caseType,
          assigneeId: null,
          summary: input.summary ?? emptySummary(),
          summaryVersion: 1,
          summaryUpdatedById: me.userId,
          summaryUpdatedAt: now,
          openedById: me.userId,
          openedAt: now,
          updatedAt: now,
        });
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: id,
          occurredAt: now,
          actor: actorOf(me),
          action: "case.opened",
          after: input.title,
        });
        return last + 1;
      });
      return view(me.organizationId, number);
    },

    async list(organizationId: string, viewerId: string, filter: CaseListFilter = {}) {
      const notClosed = ne(cases.status, "closed");
      const views: Record<CaseListView, SQL | undefined> = {
        open: notClosed,
        mine: and(notClosed, eq(cases.assigneeId, viewerId)),
        unassigned: and(notClosed, isNull(cases.assigneeId)),
        closed: eq(cases.status, "closed"),
      };
      const inOrg = eq(cases.organizationId, organizationId);
      const rows = await db
        .select(listColumns)
        .from(cases)
        .leftJoin(assignee, eq(cases.assigneeId, assignee.id))
        .where(
          and(
            inOrg,
            views[filter.view ?? "open"],
            filter.status ? eq(cases.status, filter.status) : undefined,
            filter.severity ? eq(cases.severity, filter.severity) : undefined,
            filter.caseType ? eq(cases.caseType, filter.caseType) : undefined,
          ),
        )
        .orderBy(desc(cases.updatedAt), desc(cases.number))
        .limit(500);
      const countOf = async (where: SQL | undefined) =>
        (await db.select({ n: count() }).from(cases).where(and(inOrg, where)))[0]?.n ?? 0;
      const [mine, unassigned, open, closed] = await Promise.all(
        (["mine", "unassigned", "open", "closed"] as const).map((v) => countOf(views[v])),
      );
      return { cases: rows.map(listItem), counts: { mine, unassigned, open, closed } };
    },

    /** Applies the fields that differ from the Case's current values, one Audit Log entry each. */
    async change(me: Membership, number: number, changes: CaseChanges) {
      const now = clock.now();
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: cases.id, status: cases.status, severity: cases.severity, caseType: cases.caseType, assigneeId: cases.assigneeId })
          .from(cases)
          .where(and(eq(cases.organizationId, me.organizationId), eq(cases.number, number)))
          .for("update");
        if (!current) throw new CaseNotFound();
        const entry = (action: CaseAuditEntry["action"], before: string | null, after: string | null): CaseAuditEntry => ({
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action,
          before,
          after,
        });
        const entries: CaseAuditEntry[] = [];
        const set: Partial<typeof cases.$inferInsert> = {};
        if (changes.status !== undefined && changes.status !== current.status) {
          set.status = changes.status;
          entries.push(entry("case.status_changed", current.status, changes.status));
        }
        if (changes.severity !== undefined && changes.severity !== current.severity) {
          set.severity = changes.severity;
          entries.push(entry("case.severity_changed", current.severity, changes.severity));
        }
        if (changes.caseType !== undefined && changes.caseType !== current.caseType) {
          set.caseType = changes.caseType;
          entries.push(entry("case.case_type_changed", current.caseType, changes.caseType));
        }
        if (changes.assigneeId !== undefined && changes.assigneeId !== current.assigneeId) {
          const after = changes.assigneeId === null ? null : await memberName(tx, me.organizationId, changes.assigneeId);
          const before = current.assigneeId
            ? ((await tx.select({ name: user.name }).from(user).where(eq(user.id, current.assigneeId)))[0]?.name ?? null)
            : null;
          set.assigneeId = changes.assigneeId;
          entries.push(entry("case.assignee_changed", before, after));
        }
        if (!entries.length) return;
        await tx.update(cases).set({ ...set, updatedAt: now }).where(eq(cases.id, current.id));
        for (const e of entries) await recordCaseAudit(tx, e);
      });
      return view(me.organizationId, number);
    },

    /** Replaces the Case Summary if `version` is still current; otherwise throws `StaleSummary` with what is. */
    async saveSummary(me: Membership, number: number, content: CaseSummary, version: number) {
      const now = clock.now();
      const saved = await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: cases.id, summary: cases.summary, version: cases.summaryVersion })
          .from(cases)
          .where(and(eq(cases.organizationId, me.organizationId), eq(cases.number, number)))
          .for("update");
        if (!current) throw new CaseNotFound();
        if (current.version !== version) return false;
        await tx
          .update(cases)
          .set({ summary: content, summaryVersion: version + 1, summaryUpdatedById: me.userId, summaryUpdatedAt: now, updatedAt: now })
          .where(eq(cases.id, current.id));
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "case.summary_edited",
          before: JSON.stringify(current.summary),
          after: JSON.stringify(content),
        });
        return true;
      });
      const { summary } = await view(me.organizationId, number);
      if (!saved) throw new StaleSummary(summary);
      return summary;
    },

    async auditLog(organizationId: string, number: number, filter: CaseAuditFilter) {
      return listCaseAudit(db, await findId(organizationId, number), filter);
    },
  };
}

export type CaseStore = ReturnType<typeof caseStore>;
