import { and, count, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { type Actor, canSeeCase, casePermissions, casePolicy, NotPermitted, visibleCases } from "../access/policy";
import { caseRoleAssignmentsOf, caseRoleHolderIds } from "../case-roles/holders";
import { cases, organization, user } from "../db/schema";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import { memberName } from "../members/members";
import { publish } from "../realtime/signals";
import { taskCounts } from "../tasks/task-counts";
import { type CaseActor, type CaseAuditEntry, listCaseAudit, recordCaseAudit, type CaseAuditFilter } from "./case-audit-log";
import { type CaseSummary, emptySummary } from "./case-summary";
import { type CaseType, REOPENED_STATUS, type Resolution, type Severity, type Status } from "./vocabulary";

/**
 * Cases within one Organization. Every read and write goes through here and is limited by the
 * access policy to the Cases the acting Member can see, so any other Case is simply not found.
 */

export type OpenCaseInput = { title: string; caseType: CaseType; severity: Severity; summary?: CaseSummary };
export type CaseChanges = {
  status?: Status;
  severity?: Severity;
  caseType?: CaseType;
  assigneeId?: string | null;
  restricted?: boolean;
};
export type CaseListView = "open" | "mine" | "unassigned" | "closed";
export type CaseListFilter = { view?: CaseListView; status?: Status; severity?: Severity; caseType?: CaseType };

export class CaseNotFound extends Error {}
export class NotAMember extends Error {}
export { NotPermitted };
/** The Case is Closed, so it can't be changed until an Admin reopens it. */
export class CaseClosed extends Error {
  constructor() {
    super("This Case is Closed and read-only; an Admin can reopen it");
  }
}
/** Only a Closed Case can be reopened. */
export class CaseNotClosed extends Error {
  constructor() {
    super("Only a Closed Case can be reopened");
  }
}
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
const closedBy = alias(user, "closed_by");

const listColumns = {
  number: cases.number,
  title: cases.title,
  status: cases.status,
  severity: cases.severity,
  caseType: cases.caseType,
  resolution: cases.resolution,
  restricted: cases.restricted,
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
  resolution: Resolution | null;
  restricted: boolean;
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
  resolution: row.resolution,
  restricted: row.restricted,
  assignee: row.assigneeId ? { id: row.assigneeId, name: row.assigneeName ?? "" } : null,
  openedAt: row.openedAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** The acting Member as the Case Audit Log records them. */
export const actorOf = (me: Membership): CaseActor => ({ type: "member", id: me.userId, name: me.name });

/**
 * Locks the Case's row for the rest of `tx` and returns its current values, with who holds Case Roles
 * on it. Throws `CaseNotFound` when the Member can't see it, and `CaseClosed` when it's Closed unless
 * `closed` is "allow". Anything that changes a Case, or something on it, starts here.
 */
export const lockCase = async (tx: Tx, me: Membership, number: number, closed: "refuse" | "allow" = "refuse") => {
  const [current] = await tx
    .select({
      id: cases.id,
      organizationId: cases.organizationId,
      restricted: cases.restricted,
      status: cases.status,
      resolution: cases.resolution,
      severity: cases.severity,
      caseType: cases.caseType,
      assigneeId: cases.assigneeId,
      summary: cases.summary,
      summaryVersion: cases.summaryVersion,
    })
    .from(cases)
    .where(and(visibleCases(me), eq(cases.number, number)))
    .for("update");
  if (!current) throw new CaseNotFound();
  if (closed === "refuse" && current.status === "closed") throw new CaseClosed();
  return { ...current, caseRoleHolderIds: await caseRoleHolderIds(tx, current.id) };
};

export function caseStore({ db, clock }: { db: Db; clock: Clock }) {
  /** The Case's internal id, or throws `CaseNotFound` when `me` can't see it. */
  const findId = async (me: Actor, number: number) => {
    const [row] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(visibleCases(me), eq(cases.number, number)))
      .limit(1);
    if (!row) throw new CaseNotFound();
    return row.id;
  };

  /** The Case as `me` sees it, with what they may do to it; throws `CaseNotFound` when they can't see it. */
  const view = async (me: Actor, number: number) => {
    const [row] = await db
      .select({
        ...listColumns,
        id: cases.id,
        openedById: openedBy.id,
        openedByName: openedBy.name,
        summary: cases.summary,
        summaryVersion: cases.summaryVersion,
        summaryById: summaryBy.id,
        summaryByName: summaryBy.name,
        summaryUpdatedAt: cases.summaryUpdatedAt,
        closedById: closedBy.id,
        closedByName: closedBy.name,
        closedAt: cases.closedAt,
      })
      .from(cases)
      .leftJoin(assignee, eq(cases.assigneeId, assignee.id))
      .leftJoin(closedBy, eq(cases.closedById, closedBy.id))
      .innerJoin(openedBy, eq(cases.openedById, openedBy.id))
      .innerJoin(summaryBy, eq(cases.summaryUpdatedById, summaryBy.id))
      .where(and(visibleCases(me), eq(cases.number, number)))
      .limit(1);
    if (!row) throw new CaseNotFound();
    const [caseRoles, tasks] = await Promise.all([caseRoleAssignmentsOf(db, row.id), taskCounts(db, row.id)]);
    return {
      ...listItem(row),
      can: casePermissions(me, { assigneeId: row.assigneeId }),
      openedBy: { id: row.openedById, name: row.openedByName },
      closed:
        row.closedById && row.closedAt
          ? { by: { id: row.closedById, name: row.closedByName ?? "" }, at: row.closedAt.toISOString() }
          : null,
      summary: {
        content: row.summary,
        version: row.summaryVersion,
        updatedBy: { id: row.summaryById, name: row.summaryByName },
        updatedAt: row.summaryUpdatedAt.toISOString(),
      } satisfies CaseSummaryView,
      caseRoles,
      tasks,
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
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: id });
        return last + 1;
      });
      return view(me, number);
    },

    /** The Cases `me` can see, in one of the list views, with the number of Cases in each view. */
    async list(me: Actor, filter: CaseListFilter = {}) {
      const notClosed = ne(cases.status, "closed");
      const views: Record<CaseListView, SQL | undefined> = {
        open: notClosed,
        mine: and(notClosed, eq(cases.assigneeId, me.userId)),
        unassigned: and(notClosed, isNull(cases.assigneeId)),
        closed: eq(cases.status, "closed"),
      };
      const visible = visibleCases(me);
      const rows = await db
        .select(listColumns)
        .from(cases)
        .leftJoin(assignee, eq(cases.assigneeId, assignee.id))
        .where(
          and(
            visible,
            views[filter.view ?? "open"],
            filter.status ? eq(cases.status, filter.status) : undefined,
            filter.severity ? eq(cases.severity, filter.severity) : undefined,
            filter.caseType ? eq(cases.caseType, filter.caseType) : undefined,
          ),
        )
        .orderBy(desc(cases.updatedAt), desc(cases.number))
        .limit(500);
      const countOf = async (where: SQL | undefined) =>
        (await db.select({ n: count() }).from(cases).where(and(visible, where)))[0]?.n ?? 0;
      const [mine, unassigned, open, closed] = await Promise.all(
        (["mine", "unassigned", "open", "closed"] as const).map((v) => countOf(views[v])),
      );
      return { cases: rows.map(listItem), counts: { mine, unassigned, open, closed } };
    },

    /**
     * Applies the fields that differ from the Case's current values, one Audit Log entry each.
     * Returns the changed Case, or null when the change leaves `me` unable to see it
     * (an Analyst unassigning a Restricted Case from themself).
     */
    async change(me: Membership, number: number, changes: CaseChanges) {
      const now = clock.now();
      const result = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
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
        if (changes.restricted !== undefined && changes.restricted !== current.restricted) {
          // Judged on the Case as it was, before any other change in this request.
          if (!casePolicy.canRestrict(me, current)) throw new NotPermitted();
          set.restricted = changes.restricted;
          entries.push(entry("case.restricted_changed", String(current.restricted), String(changes.restricted)));
        }
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
          let after: string | null = null;
          if (changes.assigneeId !== null) {
            after = await memberName(tx, me.organizationId, changes.assigneeId);
            if (after === null) throw new NotAMember();
          }
          const before = current.assigneeId
            ? ((await tx.select({ name: user.name }).from(user).where(eq(user.id, current.assigneeId)))[0]?.name ?? null)
            : null;
          set.assigneeId = changes.assigneeId;
          entries.push(entry("case.assignee_changed", before, after));
        }
        const next = { ...current, ...set };
        if (!entries.length) return next;
        await tx.update(cases).set({ ...set, updatedAt: now }).where(eq(cases.id, current.id));
        for (const e of entries) await recordCaseAudit(tx, e);
        const before = { restricted: current.restricted, assigneeId: current.assigneeId };
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id, before });
        return next;
      });
      return canSeeCase(me, result) ? view(me, number) : null;
    },

    /** Replaces the Case Summary if `version` is still current; otherwise throws `StaleSummary` with what is. */
    async saveSummary(me: Membership, number: number, content: CaseSummary, version: number) {
      const now = clock.now();
      const saved = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        if (current.summaryVersion !== version) return false;
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
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id });
        return true;
      });
      const { summary } = await view(me, number);
      if (!saved) throw new StaleSummary(summary);
      return summary;
    },

    /** Closes the Case with `resolution`; from then on it is read-only until an Admin reopens it. */
    async close(me: Membership, number: number, resolution: Resolution) {
      const now = clock.now();
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        await tx
          .update(cases)
          .set({ status: "closed", resolution, closedById: me.userId, closedAt: now, updatedAt: now })
          .where(eq(cases.id, current.id));
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "case.closed",
          before: current.status,
          after: resolution,
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id });
      });
      return view(me, number);
    },

    /** Reopens a Closed Case to In Progress and clears its Resolution. Only Admins and the Owner may. */
    async reopen(me: Membership, number: number) {
      const now = clock.now();
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number, "allow");
        if (!casePolicy.canReopen(me)) throw new NotPermitted();
        if (current.status !== "closed") throw new CaseNotClosed();
        await tx
          .update(cases)
          .set({ status: REOPENED_STATUS, resolution: null, closedById: null, closedAt: null, updatedAt: now })
          .where(eq(cases.id, current.id));
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "case.reopened",
          before: current.resolution,
          after: REOPENED_STATUS,
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id });
      });
      return view(me, number);
    },

    async auditLog(me: Actor, number: number, filter: CaseAuditFilter) {
      return listCaseAudit(db, await findId(me, number), filter);
    },
  };
}

export type CaseStore = ReturnType<typeof caseStore>;
