import { and, eq } from "drizzle-orm";
import { casePolicy, NotPermitted } from "../access/policy";
import { alertLabel } from "../alerts/vocabulary";
import { actorOf, lockCase } from "../cases/cases";
import { recordCaseAudit } from "../cases/case-audit-log";
import { membersAmong } from "../cases/people";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { alerts, discussionMessages, evidence, tasks, timelineEntries, user } from "../db/schema";
import { mentionedIds } from "../discussion/mentions";
import type { Membership } from "../members/membership";
import { publish } from "../realtime/signals";
import { INTERNAL_ITEM_KINDS, type InternalItem } from "./vocabulary";

/**
 * Marking items on a Case Internal, which hides them from the Case's Guests, and showing them to
 * Guests again. Members only, while the Case isn't Closed; every change is in the Case Audit Log.
 * Each item module stores its own item's marking and leaves Internal items out of Guests' reads.
 *
 * Guests can't see Internal items, so an Internal item never mentions a Guest or is owned by one.
 */

export { INTERNAL_ITEM_KINDS, type InternalItem };

export class ItemNotFound extends Error {
  constructor() {
    super("Nothing like that on this Case");
  }
}

/** The item mentions a Guest, or is owned by one, so it can't be Internal. */
export class GuestCannotSeeInternal extends Error {
  constructor() {
    super("Guests can't see Internal items, so an Internal item can't mention a Guest or be owned by one");
  }
}

/** The first `max` characters of `text`, on one line. */
const excerpt = (text: string, max = 60) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What a marking needs to know about the item: whether it's Internal, how the Audit Log names it, and who it involves. */
type Marked = { internal: boolean; label: string; involves: string[] };

const missing = (): never => {
  throw new ItemNotFound();
};

/** Locks the item on the locked Case `caseId` for the rest of `tx`, or throws `ItemNotFound`. */
async function lockItem(tx: Tx, caseId: string, item: InternalItem): Promise<Marked> {
  switch (item.kind) {
    case "task": {
      const [row] = await tx
        .select({ internal: tasks.internal, title: tasks.title, ownerId: tasks.ownerId })
        .from(tasks)
        .where(and(eq(tasks.id, item.id), eq(tasks.caseId, caseId)))
        .for("update");
      return row ? { internal: row.internal, label: `Task: ${row.title}`, involves: [row.ownerId] } : missing();
    }
    case "discussion_message": {
      const [row] = await tx
        .select({ internal: discussionMessages.internal, body: discussionMessages.body, author: user.name })
        .from(discussionMessages)
        .innerJoin(user, eq(discussionMessages.authorId, user.id))
        .where(and(eq(discussionMessages.id, item.id), eq(discussionMessages.caseId, caseId)))
        .for("update", { of: discussionMessages });
      return row ? { internal: row.internal, label: `Message from ${row.author}`, involves: mentionedIds(row.body) } : missing();
    }
    case "timeline_entry": {
      const [row] = await tx
        .select({ internal: timelineEntries.internal, body: timelineEntries.body })
        .from(timelineEntries)
        .where(and(eq(timelineEntries.id, item.id), eq(timelineEntries.caseId, caseId)))
        .for("update");
      return row ? { internal: row.internal, label: `Timeline Entry: ${excerpt(row.body)}`, involves: [] } : missing();
    }
    case "evidence": {
      const [row] = await tx
        .select({ internal: evidence.internal, name: evidence.name })
        .from(evidence)
        .where(and(eq(evidence.id, item.id), eq(evidence.caseId, caseId)))
        .for("update");
      return row ? { internal: row.internal, label: `Evidence: ${row.name}`, involves: [] } : missing();
    }
    case "alert": {
      // Already locked, before the Case (the Alert module's lock order).
      const [row] = await tx
        .select({ internal: alerts.internal, title: alerts.title, externalId: alerts.externalId })
        .from(alerts)
        .where(and(eq(alerts.id, item.id), eq(alerts.caseId, caseId)));
      return row ? { internal: row.internal, label: `Alert: ${alertLabel(row)}`, involves: [] } : missing();
    }
  }
}

async function store(tx: Tx, item: InternalItem, internal: boolean) {
  switch (item.kind) {
    case "task":
      return tx.update(tasks).set({ internal }).where(eq(tasks.id, item.id));
    case "discussion_message":
      return tx.update(discussionMessages).set({ internal }).where(eq(discussionMessages.id, item.id));
    case "timeline_entry":
      return tx.update(timelineEntries).set({ internal }).where(eq(timelineEntries.id, item.id));
    case "evidence":
      return tx.update(evidence).set({ internal }).where(eq(evidence.id, item.id));
    case "alert":
      return tx.update(alerts).set({ internal }).where(eq(alerts.id, item.id));
  }
}

/** Throws `GuestCannotSeeInternal` if any of `ids` is a Guest (anyone who isn't a Member). */
export async function refuseGuestsOnInternal(tx: Tx, organizationId: string, ids: readonly string[]) {
  const members = await membersAmong(tx, organizationId, ids);
  if (ids.some((id) => !members.has(id))) throw new GuestCannotSeeInternal();
}

export function internalStore({ db, clock }: { db: Db; clock: Clock }) {
  return {
    /**
     * Marks the item Internal, or shows it to Guests again. Marking it what it already is changes
     * nothing. Members only; not on a Closed Case.
     */
    async mark(me: Membership, number: number, item: InternalItem, internal: boolean) {
      const now = clock.now();
      await db.transaction(async (tx) => {
        if (item.kind === "alert") {
          await tx
            .select({ id: alerts.id })
            .from(alerts)
            .where(and(eq(alerts.id, item.id), eq(alerts.organizationId, me.organizationId)))
            .for("update");
        }
        const current = await lockCase(tx, me, number);
        if (!casePolicy.canMarkInternal(me)) throw new NotPermitted();
        const marked = await lockItem(tx, current.id, item);
        if (marked.internal === internal) return;
        if (internal) await refuseGuestsOnInternal(tx, me.organizationId, marked.involves);
        await store(tx, item, internal);
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: internal ? "item.marked_internal" : "item.shown_to_guests",
          target: marked.label,
        });
        // Guests hear of it: the item appears to them, or disappears.
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id });
      });
      return { internal };
    },
  };
}

export type InternalStore = ReturnType<typeof internalStore>;
