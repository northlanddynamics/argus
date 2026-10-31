import { and, asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { canSeeCase, visibleCases } from "../access/policy";
import { actorOf, CaseNotFound, lockCase } from "../cases/cases";
import { type CaseAuditEntry, recordCaseAudit } from "../cases/case-audit-log";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { cases, tasks, user } from "../db/schema";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import { memberOf } from "../members/members";
import { publish } from "../realtime/signals";

/**
 * Tasks on a Case: created, edited, completed and reopened by anyone who can see the Case, while it
 * isn't Closed. Every change is in the Case Audit Log. Edits carry the version they were based on,
 * and one based on an older version is refused with the Task as it is now.
 */

export type NewTask = { title: string; description: string; ownerId: string; dueDate: string | null };
export type TaskEdit = Partial<NewTask>;

/** The owner would be someone who can't see the Case (or isn't a Member at all). */
export class OwnerCannotSeeCase extends Error {
  constructor() {
    super("A Task's owner must be someone who can see the Case");
  }
}
export class TaskNotFound extends Error {
  constructor() {
    super("Task not found");
  }
}
type Person = { id: string; name: string };
export type TaskView = {
  id: string;
  title: string;
  description: string;
  owner: Person;
  /** YYYY-MM-DD, or null for no due date. */
  dueDate: string | null;
  /** Not done, and its due date has passed. */
  overdue: boolean;
  done: boolean;
  completed: { by: Person; at: string } | null;
  version: number;
  createdBy: Person;
  createdAt: string;
  updatedAt: string;
};

export class StaleTask extends Error {
  readonly current: TaskView;
  constructor(current: TaskView) {
    super("The Task changed since you opened it");
    this.current = current;
  }
}

const owner = alias(user, "owner");
const completedBy = alias(user, "completed_by");
const createdBy = alias(user, "created_by");

/** Today's date, as Tasks' due dates are written (YYYY-MM-DD, UTC). */
const today = (now: Date) => now.toISOString().slice(0, 10);

const columns = {
  id: tasks.id,
  caseId: tasks.caseId,
  title: tasks.title,
  description: tasks.description,
  ownerId: owner.id,
  ownerName: owner.name,
  dueDate: tasks.dueDate,
  done: tasks.done,
  completedById: completedBy.id,
  completedByName: completedBy.name,
  completedAt: tasks.completedAt,
  version: tasks.version,
  createdById: createdBy.id,
  createdByName: createdBy.name,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
};

/** Locks a Task on the locked Case for the rest of `tx`, or throws `TaskNotFound`. */
const lock = async (tx: Tx, caseId: string, id: string) => {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.caseId, caseId)))
    .for("update");
  if (!row) throw new TaskNotFound();
  return row;
};

/** The owner's name, once they are known to be a Member who can see the Case; else `OwnerCannotSeeCase`. */
const ownerName = async (tx: Tx, me: Membership, theCase: Awaited<ReturnType<typeof lockCase>>, ownerId: string) => {
  const who = await memberOf(tx, me.organizationId, ownerId);
  if (!who || !canSeeCase(who, theCase)) throw new OwnerCannotSeeCase();
  return who.name;
};

export function taskStore({ db, clock }: { db: Db; clock: Clock }) {
  const select = (from: Db | Tx = db) =>
    from
      .select(columns)
      .from(tasks)
      .innerJoin(owner, eq(tasks.ownerId, owner.id))
      .innerJoin(createdBy, eq(tasks.createdById, createdBy.id))
      .leftJoin(completedBy, eq(tasks.completedById, completedBy.id));

  type Row = Awaited<ReturnType<typeof select>>[number];
  const toView = (row: Row): TaskView => ({
    id: row.id,
    title: row.title,
    description: row.description,
    owner: { id: row.ownerId, name: row.ownerName },
    dueDate: row.dueDate,
    overdue: !row.done && row.dueDate !== null && row.dueDate < today(clock.now()),
    done: row.done,
    completed:
      row.done && row.completedById && row.completedAt
        ? { by: { id: row.completedById, name: row.completedByName ?? "" }, at: row.completedAt.toISOString() }
        : null,
    version: row.version,
    createdBy: { id: row.createdById, name: row.createdByName },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  /** The Task on Case `number`, as `me` sees it; throws `TaskNotFound` (also when they can't see the Case). */
  const view = async (me: Membership, number: number, id: string) => {
    const [row] = await select()
      .innerJoin(cases, eq(tasks.caseId, cases.id))
      .where(and(visibleCases(me), eq(cases.number, number), eq(tasks.id, id)))
      .limit(1);
    if (!row) throw new TaskNotFound();
    return toView(row);
  };

  return {
    /** The Case's Tasks, oldest first. */
    async list(me: Membership, number: number) {
      // Throws `CaseNotFound` when `me` can't see it.
      const [found] = await db
        .select({ id: cases.id })
        .from(cases)
        .where(and(visibleCases(me), eq(cases.number, number)))
        .limit(1);
      if (!found) throw new CaseNotFound();
      const rows = await select().where(eq(tasks.caseId, found.id)).orderBy(asc(tasks.createdAt), asc(tasks.id));
      return rows.map(toView);
    },

    async create(me: Membership, number: number, input: NewTask) {
      const now = clock.now();
      const id = secureId();
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const name = await ownerName(tx, me, current, input.ownerId);
        await tx.insert(tasks).values({
          id,
          organizationId: me.organizationId,
          caseId: current.id,
          title: input.title,
          description: input.description,
          ownerId: input.ownerId,
          dueDate: input.dueDate,
          done: false,
          version: 1,
          createdById: me.userId,
          createdAt: now,
          updatedAt: now,
        });
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "task.created",
          target: input.title,
          after: name,
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id });
      });
      return view(me, number, id);
    },

    /**
     * Applies the fields that differ from the Task's, one Audit Log entry each, if `version` is still
     * current; otherwise throws `StaleTask` with the Task as it is now.
     */
    async edit(me: Membership, number: number, id: string, changes: TaskEdit, version: number) {
      const now = clock.now();
      const saved = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const task = await lock(tx, current.id, id);
        if (task.version !== version) return false;
        const entries: CaseAuditEntry[] = [];
        const entry = (action: CaseAuditEntry["action"], before: string | null, after: string | null) =>
          entries.push({
            organizationId: me.organizationId,
            caseId: current.id,
            occurredAt: now,
            actor: actorOf(me),
            action,
            // Named as it was before this edit; a new title shows in the entry's "after".
            target: task.title,
            before,
            after,
          });
        const set: Partial<typeof tasks.$inferInsert> = {};
        if (changes.title !== undefined && changes.title !== task.title) {
          set.title = changes.title;
          entry("task.title_changed", task.title, changes.title);
        }
        if (changes.description !== undefined && changes.description !== task.description) {
          set.description = changes.description;
          entry("task.description_changed", task.description, changes.description);
        }
        if (changes.ownerId !== undefined && changes.ownerId !== task.ownerId) {
          const after = await ownerName(tx, me, current, changes.ownerId);
          const [before] = await tx.select({ name: user.name }).from(user).where(eq(user.id, task.ownerId));
          set.ownerId = changes.ownerId;
          entry("task.owner_changed", before?.name ?? null, after);
        }
        if (changes.dueDate !== undefined && changes.dueDate !== task.dueDate) {
          set.dueDate = changes.dueDate;
          entry("task.due_date_changed", task.dueDate, changes.dueDate);
        }
        if (!entries.length) return true;
        await tx
          .update(tasks)
          .set({ ...set, version: version + 1, updatedAt: now })
          .where(eq(tasks.id, task.id));
        for (const e of entries) await recordCaseAudit(tx, e);
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id });
        return true;
      });
      const task = await view(me, number, id);
      if (!saved) throw new StaleTask(task);
      return task;
    },

    /** Marks the Task done, or not done again. Setting it to what it already is changes nothing. */
    async setDone(me: Membership, number: number, id: string, done: boolean) {
      const now = clock.now();
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const task = await lock(tx, current.id, id);
        if (task.done === done) return;
        await tx
          .update(tasks)
          .set(done ? { done, completedById: me.userId, completedAt: now, updatedAt: now } : { done, completedById: null, completedAt: null, updatedAt: now })
          .where(eq(tasks.id, task.id));
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: done ? "task.completed" : "task.reopened",
          target: task.title,
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id });
      });
      return view(me, number, id);
    },
  };
}

export type TaskStore = ReturnType<typeof taskStore>;
