import { and, asc, count, eq, isNull } from "drizzle-orm";
import { visibleCases } from "../access/policy";
import { recordCaseAudit } from "../cases/case-audit-log";
import { actorOf, lockCase } from "../cases/cases";
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import { cases, caseTags } from "../db/schema";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import { publish } from "../realtime/signals";
import { normaliseTag, TAG_EXPECTED, tagLabel } from "./vocabulary";

/**
 * Tags on Cases. Anyone who can see a Case adds and removes its Tags while it isn't Closed; both are
 * recorded in the Case Audit Log, and a removed Tag's row is kept (ADR 0003). Adding a Tag the Case
 * already has changes nothing. A Case's Tags come with it in the Case list and view.
 */

/** Not a valid Tag. */
export class InvalidTag extends Error {
  constructor() {
    super(TAG_EXPECTED);
  }
}
export class TagNotFound extends Error {
  constructor() {
    super("This Case doesn't have that Tag");
  }
}

export function tagStore({ db, clock }: { db: Db; clock: Clock }) {
  /** The Case's current Tags, alphabetical. */
  const tagsOf = async (caseId: string) =>
    (
      await db
        .select({ tag: caseTags.tag })
        .from(caseTags)
        .where(and(eq(caseTags.caseId, caseId), isNull(caseTags.removedAt)))
        .orderBy(asc(caseTags.tag))
    ).map((r) => r.tag);

  return {
    /** The Tags on Cases `me` can see, with how many of those Cases have each; for filtering the Case list. */
    async inUse(me: Membership) {
      return db
        .select({ tag: caseTags.tag, cases: count() })
        .from(caseTags)
        .innerJoin(cases, eq(caseTags.caseId, cases.id))
        .where(and(isNull(caseTags.removedAt), visibleCases(me)))
        .groupBy(caseTags.tag)
        .orderBy(asc(caseTags.tag));
    },

    /**
     * Adds Tag `raw` to Case `number`. `added` is false if the Case already had it, and nothing changed.
     * Returns the Case's Tags. Throws `InvalidTag` if `raw` isn't a valid Tag.
     */
    async add(me: Membership, number: number, raw: string) {
      const tag = normaliseTag(raw);
      if (!tag) throw new InvalidTag();
      const now = clock.now();
      const { caseId, added } = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const [already] = await tx
          .select({ id: caseTags.id })
          .from(caseTags)
          .where(and(eq(caseTags.caseId, current.id), eq(caseTags.tag, tag), isNull(caseTags.removedAt)));
        if (already) return { caseId: current.id, added: false };
        await tx.insert(caseTags).values({
          id: secureId(),
          organizationId: me.organizationId,
          caseId: current.id,
          tag,
          addedById: me.userId,
          addedAt: now,
        });
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "tag.added",
          target: tagLabel(tag),
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id });
        return { caseId: current.id, added: true };
      });
      return { tags: await tagsOf(caseId), added };
    },

    /** Removes Tag `raw` from Case `number`; throws `TagNotFound` if it doesn't have it. Returns the Case's Tags. */
    async remove(me: Membership, number: number, raw: string) {
      const tag = normaliseTag(raw);
      if (!tag) throw new TagNotFound();
      const now = clock.now();
      const caseId = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const [row] = await tx
          .select({ id: caseTags.id })
          .from(caseTags)
          .where(and(eq(caseTags.caseId, current.id), eq(caseTags.tag, tag), isNull(caseTags.removedAt)));
        if (!row) throw new TagNotFound();
        await tx.update(caseTags).set({ removedById: me.userId, removedAt: now }).where(eq(caseTags.id, row.id));
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "tag.removed",
          target: tagLabel(tag),
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id });
        return current.id;
      });
      return tagsOf(caseId);
    },
  };
}

export type TagStore = ReturnType<typeof tagStore>;
