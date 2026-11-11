import { and, asc, count, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { type Actor, type CaseAccessFacts, type InternalFact, visibleCases, visibleItems } from "../access/policy";
import { caseRoleHolderIds } from "../case-roles/holders";
import { peopleWhoCanSee } from "../cases/people";
import { caseRef } from "../cases/vocabulary";
import type { Db, Tx } from "../db/client";
import { cases, discussionMessages, notifications, organization, tasks, user } from "../db/schema";
import type { Deps } from "../deps";
import { guestGrantsOf } from "../guests/grants";
import { secureId } from "../ids";
import { publish } from "../realtime/signals";
import type { NotificationKind } from "./vocabulary";

/**
 * Notifications: in-app (live, with a toast) and by email, to the people a change concerns.
 *
 * Modules call `notify` in the transaction that makes the change, naming the Case and, for a
 * Task or Discussion message, whether it is Internal. Only people who can see the Case and that
 * item are notified, and never the person who acted. Reading them, the access policy is asked
 * again: a notification about a Case or item its recipient can no longer see is left out.
 *
 * Each notification is also an email, queued in the same row (`email_pending`) and sent once the
 * change has committed: by the module that made it (`sendNotificationEmails`), and by the worker for
 * anything left over. Overdue Tasks are found by the worker too (`createNotificationWorker`).
 */

/** Sending an email is given up after this many failures. */
export const MAX_EMAIL_ATTEMPTS = 5;
/** The most emails, or overdue Tasks, handled in one batch. */
const BATCH = 100;

/** What happened, for one person. */
export type Notice = {
  recipientId: string;
  kind: NotificationKind;
  /** Who caused it; null when nobody did. */
  actorId: string | null;
  taskId?: string;
  messageId?: string;
  guestId?: string;
};

/** A Case, locked or otherwise read in the same transaction, as `notify` needs it. */
export type NotifiedCase = CaseAccessFacts & { id: string };

/**
 * Notifies people of a change on `theCase`, in the transaction that makes it. With `item`, the
 * notices are about that Task or message: nobody who can't see it is notified.
 */
export async function notify(tx: Tx, theCase: NotifiedCase, notices: readonly Notice[], now: Date, item?: InternalFact) {
  const wanted = notices.filter((n) => n.recipientId !== n.actorId);
  if (!wanted.length) return;
  const canSee = new Set((await peopleWhoCanSee(tx, theCase, now, item)).map((p) => p.id));
  const seen = new Set<string>();
  const rows = wanted.filter((n) => {
    const key = `${n.kind}:${n.recipientId}`;
    if (!canSee.has(n.recipientId) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!rows.length) return;
  await tx.insert(notifications).values(
    rows.map((n) => ({
      id: secureId(),
      organizationId: theCase.organizationId,
      caseId: theCase.id,
      recipientId: n.recipientId,
      kind: n.kind,
      actorId: n.actorId,
      taskId: n.taskId ?? null,
      messageId: n.messageId ?? null,
      guestId: n.guestId ?? null,
      createdAt: now,
    })),
  );
  await publish(tx, { kind: "notifications", organizationId: theCase.organizationId, userIds: [...new Set(rows.map((n) => n.recipientId))] });
}

/** Everyone taking part in a Case, as Severity changes reach them: its Assignee, Case Role holders and Guests. */
export const participantsOf = (theCase: NotifiedCase) => [
  ...new Set([...(theCase.assigneeId ? [theCase.assigneeId] : []), ...theCase.caseRoleHolderIds, ...theCase.guests.map((g) => g.userId)]),
];

const actor = alias(user, "notification_actor");
const guest = alias(user, "notification_guest");
const recipient = alias(user, "notification_recipient");

const columns = {
  id: notifications.id,
  kind: notifications.kind,
  createdAt: notifications.createdAt,
  readAt: notifications.readAt,
  number: cases.number,
  caseTitle: cases.title,
  actorId: actor.id,
  actorName: actor.name,
  taskId: tasks.id,
  taskTitle: tasks.title,
  taskDueDate: tasks.dueDate,
  guestName: guest.name,
};

type Row = {
  kind: NotificationKind;
  number: number;
  actorName: string | null;
  taskTitle: string | null;
  taskDueDate: string | null;
  guestName: string | null;
};

/** What happened, in a line, as the bell, the toast and the email's subject say it. */
export function headline(n: Row) {
  const who = n.actorName ?? "Someone";
  const ref = caseRef(n.number);
  switch (n.kind) {
    case "case_assigned":
      return `${who} made you Assignee of ${ref}`;
    case "task_assigned":
      return `${who} gave you the Task "${n.taskTitle ?? ""}" on ${ref}`;
    case "mentioned":
      return `${who} mentioned you on ${ref}`;
    case "guest_added":
      return `${who} added ${n.guestName ?? "a Guest"} to ${ref} as a Guest`;
    case "severity_critical":
      return `${who} raised ${ref} to Critical`;
    case "task_overdue":
      return `Your Task "${n.taskTitle ?? ""}" on ${ref} is overdue`;
    case "response_action_failed":
      return `A Response Action you took on ${ref} failed`;
    case "response_action_removal_failed":
      return `A Response Action you asked to remove from ${ref} could not be removed`;
    case "workflow_run_failed":
      return `A Workflow you ran for ${ref} failed`;
  }
}

/** The Case page section a notification opens. */
export const sectionOf = (kind: NotificationKind) =>
  kind === "task_assigned" || kind === "task_overdue"
    ? "tasks"
    : kind === "mentioned"
      ? "timeline"
      : kind === "response_action_failed" || kind === "response_action_removal_failed"
        ? "observables"
        : null;

const from = (db: Db | Tx) =>
  db
    .select(columns)
    .from(notifications)
    .innerJoin(cases, eq(notifications.caseId, cases.id))
    .leftJoin(actor, eq(notifications.actorId, actor.id))
    .leftJoin(guest, eq(notifications.guestId, guest.id))
    .leftJoin(tasks, eq(notifications.taskId, tasks.id))
    .leftJoin(discussionMessages, eq(notifications.messageId, discussionMessages.id));

/**
 * The notifications `me` may see now: theirs, on Cases they can see in the Organization they are
 * acting in, leaving out those about items hidden from them. Joins what `from` joins.
 */
const visibleTo = (me: Actor) => {
  const item = (id: AnyPgColumn, internal: AnyPgColumn) => {
    const visible = visibleItems(me, internal);
    return visible && or(isNull(id), visible);
  };
  return and(
    eq(notifications.recipientId, me.userId),
    visibleCases(me),
    item(notifications.taskId, tasks.internal),
    item(notifications.messageId, discussionMessages.internal),
  );
};

export type NotificationView = {
  id: string;
  kind: NotificationKind;
  headline: string;
  case: { number: number; title: string };
  /** The Case page section it opens, if not the Case's overview. */
  section: "tasks" | "timeline" | "observables" | null;
  actor: { id: string; name: string } | null;
  task: { id: string; title: string } | null;
  createdAt: string;
  read: boolean;
};

type ViewRow = Row & { id: string; createdAt: Date; readAt: Date | null; caseTitle: string; actorId: string | null; taskId: string | null };

const toView = (r: ViewRow): NotificationView => ({
  id: r.id,
  kind: r.kind,
  headline: headline(r),
  case: { number: r.number, title: r.caseTitle },
  section: sectionOf(r.kind),
  actor: r.actorId ? { id: r.actorId, name: r.actorName ?? "" } : null,
  task: r.taskId ? { id: r.taskId, title: r.taskTitle ?? "" } : null,
  createdAt: r.createdAt.toISOString(),
  read: r.readAt !== null,
});

/**
 * Sends the queued notification emails, each by one process however many try at once. A failure is
 * retried on the next call, up to `MAX_EMAIL_ATTEMPTS`. Never throws.
 */
export async function sendNotificationEmails({ db, mailer, baseUrl }: Pick<Deps, "db" | "mailer" | "baseUrl">) {
  try {
    for (;;) {
      const sent = await db.transaction(async (tx) => {
        const due = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(eq(notifications.emailPending, true))
          .orderBy(asc(notifications.seq))
          .limit(BATCH)
          .for("update", { skipLocked: true });
        if (!due.length) return 0;
        const rows = await tx
          .select({ ...columns, email: recipient.email, organizationName: organization.name, attempts: notifications.emailAttempts })
          .from(notifications)
          .innerJoin(cases, eq(notifications.caseId, cases.id))
          .innerJoin(recipient, eq(notifications.recipientId, recipient.id))
          .innerJoin(organization, eq(notifications.organizationId, organization.id))
          .leftJoin(actor, eq(notifications.actorId, actor.id))
          .leftJoin(guest, eq(notifications.guestId, guest.id))
          .leftJoin(tasks, eq(notifications.taskId, tasks.id))
          .where(inArray(notifications.id, due.map((d) => d.id)))
          .orderBy(asc(notifications.seq));
        for (const r of rows) {
          const section = sectionOf(r.kind);
          const link = `${baseUrl}/cases/${r.number}${section ? `/${section}` : ""}`;
          const line = headline(r);
          try {
            await mailer.send({
              to: r.email,
              subject: `${line} · Argus`,
              text: [
                `${line}.`,
                "",
                `${caseRef(r.number)} · ${r.caseTitle} at ${r.organizationName}`,
                ...(r.kind === "task_overdue" && r.taskDueDate ? [`It was due ${r.taskDueDate}.`] : []),
                "",
                `Open it in Argus: ${link}`,
              ].join("\n"),
            });
            await tx.update(notifications).set({ emailPending: false, emailedAt: new Date() }).where(eq(notifications.id, r.id));
          } catch (e) {
            console.error("notifications: email:", e);
            const attempts = r.attempts + 1;
            await tx
              .update(notifications)
              .set({ emailAttempts: attempts, emailPending: attempts < MAX_EMAIL_ATTEMPTS })
              .where(eq(notifications.id, r.id));
            return -1;
          }
        }
        return rows.length;
      });
      // Stop on an empty batch, and on a failure until the next call.
      if (sent <= 0) return;
    }
  } catch (e) {
    console.error("notifications: email:", e);
  }
}

/** Today's date, as Tasks' due dates are written (YYYY-MM-DD, UTC). */
const today = (now: Date) => now.toISOString().slice(0, 10);

/**
 * Tells each Task's owner, once per due date, when their Task falls overdue: not done, its due date
 * passed, on a Case that isn't Closed. Returns how many Tasks fell overdue.
 */
export async function notifyOverdueTasks({ db, clock }: Pick<Deps, "db" | "clock">) {
  const now = clock.now();
  return db.transaction(async (tx) => {
    const due = await tx
      .select({
        id: tasks.id,
        ownerId: tasks.ownerId,
        dueDate: tasks.dueDate,
        internal: tasks.internal,
        caseId: cases.id,
        organizationId: cases.organizationId,
        restricted: cases.restricted,
        assigneeId: cases.assigneeId,
      })
      .from(tasks)
      .innerJoin(cases, eq(tasks.caseId, cases.id))
      .where(
        and(
          eq(tasks.done, false),
          lt(tasks.dueDate, today(now)),
          ne(cases.status, "closed"),
          sql`${tasks.overdueNotifiedFor} IS DISTINCT FROM ${tasks.dueDate}`,
        ),
      )
      .orderBy(asc(tasks.dueDate), asc(tasks.id))
      .limit(BATCH)
      .for("update", { of: tasks, skipLocked: true });
    for (const t of due) {
      const theCase = {
        id: t.caseId,
        organizationId: t.organizationId,
        restricted: t.restricted,
        assigneeId: t.assigneeId,
        caseRoleHolderIds: await caseRoleHolderIds(tx, t.caseId),
        guests: await guestGrantsOf(tx, t.caseId),
      };
      await notify(tx, theCase, [{ recipientId: t.ownerId, kind: "task_overdue", actorId: null, taskId: t.id }], now, t);
      await tx.update(tasks).set({ overdueNotifiedFor: t.dueDate }).where(eq(tasks.id, t.id));
    }
    return due.length;
  });
}

/** The worker's part: overdue Tasks, and emails nobody sent yet. Call `tick` regularly. */
export function createNotificationWorker(deps: Pick<Deps, "db" | "clock" | "mailer" | "baseUrl">) {
  return {
    async tick() {
      while ((await notifyOverdueTasks(deps)) === BATCH);
      await sendNotificationEmails(deps);
    },
  };
}

export function notificationStore({ db, clock }: Pick<Deps, "db" | "clock">) {
  /** Tells `me`'s other tabs their notifications changed. */
  const changed = (me: Actor) => publish(db, { kind: "notifications", organizationId: me.organizationId, userIds: [me.userId] });

  return {
    /** `me`'s latest notifications, newest first, and how many are unread. */
    async list(me: Actor, limit = 50) {
      const rows = await from(db)
        .where(visibleTo(me))
        .orderBy(desc(notifications.seq))
        .limit(limit);
      const [unread] = await db
        .select({ n: count() })
        .from(notifications)
        .innerJoin(cases, eq(notifications.caseId, cases.id))
        .leftJoin(tasks, eq(notifications.taskId, tasks.id))
        .leftJoin(discussionMessages, eq(notifications.messageId, discussionMessages.id))
        .where(and(visibleTo(me), isNull(notifications.readAt)));
      return { notifications: rows.map(toView), unread: unread?.n ?? 0 };
    },

    /** Marks one of `me`'s notifications read. Returns false when they have none by that id. */
    async markRead(me: Actor, id: string) {
      const [found] = await from(db).where(and(visibleTo(me), eq(notifications.id, id))).limit(1);
      if (!found) return false;
      if (found.readAt) return true;
      await db
        .update(notifications)
        .set({ readAt: clock.now() })
        .where(and(eq(notifications.id, id), isNull(notifications.readAt)));
      await changed(me);
      return true;
    },

    /** Marks every notification `me` can see read. */
    async markAllRead(me: Actor) {
      const unread = await from(db).where(and(visibleTo(me), isNull(notifications.readAt)));
      if (!unread.length) return;
      await db
        .update(notifications)
        .set({ readAt: clock.now() })
        .where(and(inArray(notifications.id, unread.map((r) => r.id)), isNull(notifications.readAt)));
      await changed(me);
    },
  };
}

export type NotificationStore = ReturnType<typeof notificationStore>;
