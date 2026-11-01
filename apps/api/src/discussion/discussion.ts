import { and, asc, eq, inArray } from "drizzle-orm";
import { canSeeItem, casePolicy, discussionPolicy, NotPermitted, visibleCases, visibleItems } from "../access/policy";
import { caseRoleHolderIds } from "../case-roles/holders";
import { guestGrantsOf } from "../guests/grants";
import { actorOf, CaseNotFound, lockCase } from "../cases/cases";
import { recordCaseAudit } from "../cases/case-audit-log";
import { peopleWhoCanSee } from "../cases/people";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { cases, discussionMentions, discussionMessages, user } from "../db/schema";
import { secureId } from "../ids";
import type { Participant } from "../members/membership";
import { publish } from "../realtime/signals";
import { GuestCannotSeeInternal } from "../internal/internal";
import { mentionedIds, withNames } from "./mentions";

/**
 * A Case's Discussion. Anyone who can see the Case, Guests included, posts while it isn't Closed; a
 * message's author edits or retracts it, and the Case Audit Log keeps every earlier text (ADR 0003).
 * Members may post Internal messages, which Guests never see.
 *
 * A message may mention only people who can see it: people who can see the Case, and no Guests on
 * an Internal message. Mentioning someone never lets them see it. Who was mentioned where is stored
 * for notifications.
 */

export class MessageNotFound extends Error {
  constructor() {
    super("Message not found");
  }
}
/** A retracted message can't be edited or retracted again. */
export class MessageRetracted extends Error {
  constructor() {
    super("This message has been retracted");
  }
}
/** The text mentions someone who can't see the Case (or isn't a Member at all). */
export class MentionCannotSeeCase extends Error {
  constructor() {
    super("Only people who can see the Case can be mentioned");
  }
}
export { NotPermitted };

type Person = { id: string; name: string };
export type MessageView = {
  id: string;
  author: Person;
  /** With mentions as `<@userId>`; null once retracted. */
  body: string | null;
  /** The people the text mentions now, by id, with their current names. */
  mentions: Person[];
  postedAt: string;
  editedAt: string | null;
  retractedAt: string | null;
  /** Hidden from Guests. */
  internal: boolean;
  /** What the viewer may do to this message, while the Case isn't Closed. */
  can: { edit: boolean; retract: boolean };
};

/** The names of these people, by id. Joins `tx`. */
const namesOf = async (db: Db | Tx, ids: readonly string[]) => {
  if (!ids.length) return new Map<string, string>();
  const rows = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
};

/** Locks a message `me` can see on the locked Case for the rest of `tx`, or throws `MessageNotFound`. */
const lock = async (tx: Tx, me: Participant, caseId: string, id: string) => {
  const [row] = await tx
    .select()
    .from(discussionMessages)
    .where(and(eq(discussionMessages.id, id), eq(discussionMessages.caseId, caseId)))
    .for("update");
  if (!row || !canSeeItem(me, row)) throw new MessageNotFound();
  return row;
};

/**
 * Throws `MentionCannotSeeCase` unless everyone in `ids` can see the locked Case, and
 * `GuestCannotSeeInternal` if the message is Internal and `ids` names a Guest.
 */
const checkMentions = async (tx: Tx, theCase: Awaited<ReturnType<typeof lockCase>>, ids: readonly string[], internal: boolean, at: Date) => {
  if (!ids.length) return;
  const people = new Map((await peopleWhoCanSee(tx, theCase, at)).map((p) => [p.id, p]));
  if (ids.some((id) => !people.has(id))) throw new MentionCannotSeeCase();
  if (internal && ids.some((id) => people.get(id)?.role === "guest")) throw new GuestCannotSeeInternal();
};

/** Records the mentions in `ids` that message `messageId` doesn't have yet. */
const recordMentions = async (tx: Tx, me: Participant, caseId: string, messageId: string, ids: readonly string[], at: Date) => {
  if (!ids.length) return;
  await tx
    .insert(discussionMentions)
    .values(
      ids.map((userId) => ({
        id: secureId(),
        organizationId: me.organizationId,
        caseId,
        messageId,
        userId,
        mentionedById: me.userId,
        mentionedAt: at,
      })),
    )
    .onConflictDoNothing();
};

export function discussionStore({ db, clock }: { db: Db; clock: Clock }) {
  /** The Case's messages (or just `id`) as `me` sees them, oldest first. */
  const select = async (me: Participant, number: number, id?: string): Promise<MessageView[]> => {
    const [found] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(visibleCases(me), eq(cases.number, number)))
      .limit(1);
    if (!found) throw new CaseNotFound();
    const rows = await db
      .select({
        id: discussionMessages.id,
        authorId: discussionMessages.authorId,
        authorName: user.name,
        body: discussionMessages.body,
        postedAt: discussionMessages.postedAt,
        editedAt: discussionMessages.editedAt,
        retractedAt: discussionMessages.retractedAt,
        internal: discussionMessages.internal,
      })
      .from(discussionMessages)
      .innerJoin(user, eq(discussionMessages.authorId, user.id))
      .where(
        and(
          eq(discussionMessages.caseId, found.id),
          id ? eq(discussionMessages.id, id) : undefined,
          visibleItems(me, discussionMessages.internal),
        ),
      )
      .orderBy(asc(discussionMessages.seq));
    const live = rows.filter((r) => !r.retractedAt);
    const names = await namesOf(db, [...new Set(live.flatMap((r) => mentionedIds(r.body)))]);
    return rows.map((r) => {
      const retracted = r.retractedAt !== null;
      const mine = discussionPolicy.canChangeMessage(me, r);
      return {
        id: r.id,
        author: { id: r.authorId, name: r.authorName },
        body: retracted ? null : r.body,
        mentions: retracted ? [] : mentionedIds(r.body).map((m) => ({ id: m, name: names.get(m) ?? "unknown" })),
        postedAt: r.postedAt.toISOString(),
        editedAt: r.editedAt?.toISOString() ?? null,
        retractedAt: r.retractedAt?.toISOString() ?? null,
        internal: r.internal,
        can: { edit: mine && !retracted, retract: mine && !retracted },
      };
    });
  };

  const view = async (me: Participant, number: number, id: string) => {
    const [message] = await select(me, number, id);
    if (!message) throw new MessageNotFound();
    return message;
  };

  return {
    /** The Case's messages, oldest first; throws `CaseNotFound` when `me` can't see it. */
    list: (me: Participant, number: number) => select(me, number),

    /** The people `me` may mention on the Case: everyone who can see it (Members first, then Guests). */
    async mentionable(me: Participant, number: number) {
      const [found] = await db
        .select({ id: cases.id, organizationId: cases.organizationId, restricted: cases.restricted, assigneeId: cases.assigneeId })
        .from(cases)
        .where(and(visibleCases(me), eq(cases.number, number)))
        .limit(1);
      if (!found) throw new CaseNotFound();
      const facts = { ...found, caseRoleHolderIds: await caseRoleHolderIds(db, found.id), guests: await guestGrantsOf(db, found.id) };
      return peopleWhoCanSee(db, facts, clock.now());
    },

    /** Posts a message; with `internal` (Members only), hidden from Guests. */
    async post(me: Participant, number: number, body: string, internal = false) {
      const now = clock.now();
      const id = secureId();
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        if (internal && !casePolicy.canMarkInternal(me)) throw new NotPermitted();
        const mentions = mentionedIds(body);
        await checkMentions(tx, current, mentions, internal, now);
        await tx.insert(discussionMessages).values({
          id,
          organizationId: me.organizationId,
          caseId: current.id,
          authorId: me.userId,
          body,
          postedAt: now,
          internal,
        });
        await recordMentions(tx, me, current.id, id, mentions, now);
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "discussion.message_posted",
          target: internal ? "Internal" : null,
          after: withNames(body, await namesOf(tx, mentions)),
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id, membersOnly: internal });
      });
      return view(me, number, id);
    },

    /**
     * Replaces the message's text. Its author only. People it newly mentions must be able to see
     * the message; those it mentioned already stay, even if they no longer can.
     */
    async edit(me: Participant, number: number, id: string, body: string) {
      const now = clock.now();
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const message = await lock(tx, me, current.id, id);
        if (!discussionPolicy.canChangeMessage(me, message)) throw new NotPermitted();
        if (message.retractedAt) throw new MessageRetracted();
        if (body === message.body) return;
        const before = mentionedIds(message.body);
        const after = mentionedIds(body);
        const added = after.filter((m) => !before.includes(m));
        await checkMentions(tx, current, added, message.internal, now);
        await tx.update(discussionMessages).set({ body, editedAt: now }).where(eq(discussionMessages.id, id));
        await recordMentions(tx, me, current.id, id, added, now);
        const names = await namesOf(tx, [...new Set([...before, ...after])]);
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "discussion.message_edited",
          before: withNames(message.body, names),
          after: withNames(body, names),
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id, membersOnly: message.internal });
      });
      return view(me, number, id);
    },

    /** Withdraws the message: its text is no longer shown, and stays in the Audit Log. Its author only. */
    async retract(me: Participant, number: number, id: string) {
      const now = clock.now();
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const message = await lock(tx, me, current.id, id);
        if (!discussionPolicy.canChangeMessage(me, message)) throw new NotPermitted();
        if (message.retractedAt) throw new MessageRetracted();
        await tx.update(discussionMessages).set({ retractedAt: now }).where(eq(discussionMessages.id, id));
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "discussion.message_retracted",
          before: withNames(message.body, await namesOf(tx, mentionedIds(message.body))),
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id, membersOnly: message.internal });
      });
      return view(me, number, id);
    },
  };
}

export type DiscussionStore = ReturnType<typeof discussionStore>;
