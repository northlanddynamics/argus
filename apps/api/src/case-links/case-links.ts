import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { visibleCases } from "../access/policy";
import { recordCaseAudit } from "../cases/case-audit-log";
import { actorOf, CaseClosed, CaseNotFound, closeLocked, lockCase } from "../cases/cases";
import { caseRef, type Resolution, type Status } from "../cases/vocabulary";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { caseLinks, cases, user } from "../db/schema";
import { secureId } from "../ids";
import type { Membership, Participant } from "../members/membership";
import { publish } from "../realtime/signals";
import { type LinkSide, linkSideLabel, type LinkType, sideOf, type StoredLinkType, storedLink } from "./vocabulary";

/**
 * Case Links: typed relationships between two Cases in one Organization (Related, Duplicate of,
 * Parent/Child). Two Cases have at most one link at a time.
 *
 * Anyone who can see both Cases links them, from a Case that isn't Closed; the other Case may be
 * Closed, since a new Case is often a duplicate of one already closed. Marking a Case Duplicate of
 * another closes it with Resolution Duplicate. A link is removed from either Case while that Case
 * isn't Closed; removing a Duplicate-of link doesn't reopen anything.
 *
 * Both Cases' Audit Logs record each link and its removal, naming the other Case by number only. A
 * Case lists only the links to Cases the actor can see, so a Restricted Case stays out of sight.
 */

/** No Case with that number that the actor can see. */
export class TargetNotFound extends Error {
  constructor(number: number) {
    super(`There is no Case ${caseRef(number)} you can see`);
  }
}
export class LinkToSelf extends Error {
  constructor() {
    super("A Case can't be linked to itself");
  }
}
export class AlreadyLinked extends Error {
  constructor(a: number, b: number) {
    super(`${caseRef(a)} and ${caseRef(b)} are already linked; remove that link first`);
  }
}
export class LinkNotFound extends Error {
  constructor() {
    super("Case Link not found");
  }
}

type Person = { id: string; name: string };
export type CaseLinkView = {
  id: string;
  /** How the link reads from this Case: this Case is `side` the other one. */
  side: LinkSide;
  case: { number: number; title: string; status: Status; resolution: Resolution | null };
  linkedBy: Person;
  linkedAt: string;
};

/** The Resolution a Case marked Duplicate of another is closed with. */
const DUPLICATE: Resolution = "duplicate";

/** Records a link's addition or removal in both Cases' Audit Logs, each naming the other. */
async function recordOnBoth(
  tx: Tx,
  me: Membership,
  action: "case_link.added" | "case_link.removed",
  link: { type: StoredLinkType; source: { id: string; number: number }; target: { id: string; number: number } },
  now: Date,
) {
  for (const [self, other, isSource] of [
    [link.source, link.target, true],
    [link.target, link.source, false],
  ] as const) {
    await recordCaseAudit(tx, {
      organizationId: me.organizationId,
      caseId: self.id,
      occurredAt: now,
      actor: actorOf(me),
      action,
      target: `${linkSideLabel[sideOf(link.type, isSource)]} ${caseRef(other.number)}`,
    });
  }
}

export function caseLinkStore({ db, clock }: { db: Db; clock: Clock }) {
  /** The Case's links to Cases `me` can see, oldest first. */
  async function linksOf(me: Participant, caseId: string): Promise<CaseLinkView[]> {
    const rows = await db
      .select({
        id: caseLinks.id,
        sourceCaseId: caseLinks.sourceCaseId,
        targetCaseId: caseLinks.targetCaseId,
        type: caseLinks.type,
        linkedById: user.id,
        linkedByName: user.name,
        linkedAt: caseLinks.linkedAt,
      })
      .from(caseLinks)
      .innerJoin(user, eq(caseLinks.linkedById, user.id))
      .where(and(or(eq(caseLinks.sourceCaseId, caseId), eq(caseLinks.targetCaseId, caseId)), isNull(caseLinks.unlinkedAt)))
      .orderBy(asc(caseLinks.linkedAt), asc(caseLinks.seq));
    if (!rows.length) return [];
    const otherId = (r: (typeof rows)[number]) => (r.sourceCaseId === caseId ? r.targetCaseId : r.sourceCaseId);
    const others = await db
      .select({ id: cases.id, number: cases.number, title: cases.title, status: cases.status, resolution: cases.resolution })
      .from(cases)
      .where(and(visibleCases(me), inArray(cases.id, rows.map(otherId))));
    const byId = new Map(others.map((o) => [o.id, o]));
    return rows.flatMap((r) => {
      const other = byId.get(otherId(r));
      if (!other) return [];
      return [
        {
          id: r.id,
          side: sideOf(r.type, r.sourceCaseId === caseId),
          case: { number: other.number, title: other.title, status: other.status, resolution: other.resolution },
          linkedBy: { id: r.linkedById, name: r.linkedByName },
          linkedAt: r.linkedAt.toISOString(),
        },
      ];
    });
  }

  async function visibleCaseId(me: Participant, number: number) {
    const [found] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(visibleCases(me), eq(cases.number, number)))
      .limit(1);
    if (!found) throw new CaseNotFound();
    return found.id;
  }

  return {
    /** Case `number`'s links. Throws `CaseNotFound` if `me` can't see it. */
    async list(me: Participant, number: number) {
      return linksOf(me, await visibleCaseId(me, number));
    },

    /**
     * Links Case `number` to Case `targetNumber` as `type` ("Child of" makes the target its parent).
     * A Duplicate-of link also closes Case `number` with Resolution Duplicate (`closed`).
     * Returns Case `number`'s links.
     */
    async link(me: Membership, number: number, input: { type: LinkType; targetNumber: number }) {
      if (input.targetNumber === number) throw new LinkToSelf();
      const now = clock.now();
      const { type, fromIsSource } = storedLink(input.type);
      const { caseId, closed } = await db.transaction(async (tx) => {
        // Both rows, locked in a fixed order so two people linking the same pair can't deadlock.
        const rows = await tx
          .select({ id: cases.id, number: cases.number, status: cases.status })
          .from(cases)
          .where(and(visibleCases(me), inArray(cases.number, [number, input.targetNumber])))
          .orderBy(asc(cases.id))
          .for("update");
        const from = rows.find((r) => r.number === number);
        const to = rows.find((r) => r.number === input.targetNumber);
        if (!from) throw new CaseNotFound();
        if (from.status === "closed") throw new CaseClosed();
        if (!to) throw new TargetNotFound(input.targetNumber);
        const [existing] = await tx
          .select({ id: caseLinks.id })
          .from(caseLinks)
          .where(
            and(
              isNull(caseLinks.unlinkedAt),
              or(
                and(eq(caseLinks.sourceCaseId, from.id), eq(caseLinks.targetCaseId, to.id)),
                and(eq(caseLinks.sourceCaseId, to.id), eq(caseLinks.targetCaseId, from.id)),
              ),
            ),
          );
        if (existing) throw new AlreadyLinked(number, input.targetNumber);
        const [source, target] = fromIsSource ? [from, to] : [to, from];
        await tx.insert(caseLinks).values({
          id: secureId(),
          organizationId: me.organizationId,
          sourceCaseId: source.id,
          targetCaseId: target.id,
          type,
          linkedById: me.userId,
          linkedAt: now,
        });
        await recordOnBoth(tx, me, "case_link.added", { type, source, target }, now);
        const closes = type === "duplicate_of";
        if (closes) await closeLocked(tx, me, from, DUPLICATE, now);
        for (const id of [from.id, to.id]) await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: id });
        return { caseId: from.id, closed: closes };
      });
      return { links: await linksOf(me, caseId), closed };
    },

    /**
     * Removes link `linkId` from Case `number`. Throws `LinkNotFound` if the Case has no such link, or
     * it is to a Case `me` can't see. Returns the Case's links.
     */
    async unlink(me: Membership, number: number, linkId: string) {
      const now = clock.now();
      const caseId = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const [link] = await tx
          .select({ id: caseLinks.id, type: caseLinks.type, sourceCaseId: caseLinks.sourceCaseId, targetCaseId: caseLinks.targetCaseId })
          .from(caseLinks)
          .where(
            and(
              eq(caseLinks.id, linkId),
              isNull(caseLinks.unlinkedAt),
              or(eq(caseLinks.sourceCaseId, current.id), eq(caseLinks.targetCaseId, current.id)),
            ),
          );
        if (!link) throw new LinkNotFound();
        const otherId = link.sourceCaseId === current.id ? link.targetCaseId : link.sourceCaseId;
        const [other] = await tx
          .select({ id: cases.id, number: cases.number })
          .from(cases)
          .where(and(visibleCases(me), eq(cases.id, otherId)));
        if (!other) throw new LinkNotFound();
        await tx.update(caseLinks).set({ unlinkedById: me.userId, unlinkedAt: now }).where(eq(caseLinks.id, link.id));
        const self = { id: current.id, number };
        const [source, target] = link.sourceCaseId === current.id ? [self, other] : [other, self];
        await recordOnBoth(tx, me, "case_link.removed", { type: link.type, source, target }, now);
        for (const id of [current.id, other.id]) await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: id });
        return current.id;
      });
      return linksOf(me, caseId);
    },
  };
}

export type CaseLinkStore = ReturnType<typeof caseLinkStore>;
