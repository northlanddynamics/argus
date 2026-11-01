import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Actor, casePolicy, visibleCases, visibleItems } from "../access/policy";
import { actorOf, CaseNotFound, lockCase } from "../cases/cases";
import { recordCaseAudit } from "../cases/case-audit-log";
import type { CaseAuditAction } from "../cases/vocabulary";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { caseAuditLog, cases, discussionMessages, tasks, timelineEntries, user } from "../db/schema";
import { secureId } from "../ids";
import type { Membership, Participant } from "../members/membership";
import { publish } from "../realtime/signals";
import { describeOccurredAt, type OccurredAt } from "./occurred-at";
import type { Citation, PromotionSource } from "./vocabulary";

/**
 * A Case's Timeline: what happened in the real world, ordered by when it happened. Anyone who can see
 * the Case adds, edits and retracts Timeline Entries while it isn't Closed, and every earlier version
 * stays in the Case Audit Log (ADR 0003). Edits carry the version they were based on; one based on an
 * older version is refused with the entry as it is now.
 *
 * Promotion turns a Discussion message or a Case Audit Log entry into a Timeline Entry that links
 * back to it. A source is Promoted into at most one entry at a time (retracting that entry frees it).
 *
 * Internal entries are hidden from Guests, and so are an entry's citations of Internal Tasks and
 * its link to an Internal message. Promoting an Internal message makes an Internal entry unless
 * the Member says otherwise.
 */

export type { Citation, OccurredAt, PromotionSource };
export type TimelineEntryInput = { occurredAt: OccurredAt; body: string; citations: Citation[] };
/** A new entry; `internal` hides it from Guests (by default only when Promoting an Internal message). */
export type NewTimelineEntry = TimelineEntryInput & { internal?: boolean };

export class TimelineEntryNotFound extends Error {
  constructor() {
    super("Timeline Entry not found");
  }
}
/** A retracted entry can't be edited or retracted again. */
export class TimelineEntryRetracted extends Error {
  constructor() {
    super("This Timeline Entry has been retracted");
  }
}
/** A citation names something that isn't on this Case. */
export class CitationNotFound extends Error {
  constructor() {
    super("Entries can only cite items on the same Case");
  }
}
/** The Promotion source isn't on this Case. */
export class SourceNotFound extends Error {
  constructor() {
    super("Nothing to Promote: the source isn't on this Case");
  }
}
/** A retracted Discussion message can't be Promoted. */
export class SourceRetracted extends Error {
  constructor() {
    super("A retracted message can't be Promoted");
  }
}
/** The source is already Promoted into an entry that hasn't been retracted. */
export class AlreadyPromoted extends Error {
  readonly entryId: string;
  constructor(entryId: string) {
    super("This is already on the Timeline");
    this.entryId = entryId;
  }
}

type Person = { id: string; name: string };
export type CitationView = Citation & { label: string };
export type SourceView =
  | { kind: "discussion_message"; id: string; author: Person; postedAt: string }
  | { kind: "audit_log_entry"; id: string; action: CaseAuditAction; actor: string; occurredAt: string };
export type TimelineEntryView = {
  id: string;
  occurredAt: OccurredAt;
  body: string;
  citations: CitationView[];
  /** What it was Promoted from, if anything. */
  source: SourceView | null;
  /** Hidden from Guests. */
  internal: boolean;
  version: number;
  recordedBy: Person;
  recordedAt: string;
  editedAt: string | null;
  retracted: { by: Person; at: string; reason: string | null } | null;
};

export class StaleTimelineEntry extends Error {
  readonly current: TimelineEntryView;
  constructor(current: TimelineEntryView) {
    super("The Timeline Entry changed since you opened it");
    this.current = current;
  }
}

const recordedBy = alias(user, "recorded_by");
const retractedBy = alias(user, "retracted_by");

type Row = typeof timelineEntries.$inferSelect;

/** The columns that hold occurred-at, from what was asked for; times as stored (to the millisecond). */
const occurredColumns = (o: OccurredAt) => {
  switch (o.kind) {
    case "exact":
      return { occurredKind: o.kind, occurredStart: new Date(o.at), occurredEnd: null, occurredPrecisionMinutes: null };
    case "range":
      return { occurredKind: o.kind, occurredStart: new Date(o.start), occurredEnd: new Date(o.end), occurredPrecisionMinutes: null };
    case "approximate":
      return { occurredKind: o.kind, occurredStart: new Date(o.at), occurredEnd: null, occurredPrecisionMinutes: o.precisionMinutes };
  }
};

const occurredAtOf = (r: Pick<Row, "occurredKind" | "occurredStart" | "occurredEnd" | "occurredPrecisionMinutes">): OccurredAt => {
  const start = r.occurredStart.toISOString();
  switch (r.occurredKind) {
    case "exact":
      return { kind: "exact", at: start };
    case "range":
      return { kind: "range", start, end: r.occurredEnd!.toISOString() };
    case "approximate":
      return { kind: "approximate", at: start, precisionMinutes: r.occurredPrecisionMinutes! };
  }
};

/** Each citation once, in the order given, as stored. */
const distinct = (citations: readonly Citation[]): Citation[] => {
  const seen = new Set<string>();
  return citations
    .filter((c) => {
      const key = `${c.kind}:${c.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c) => ({ kind: c.kind, id: c.id }));
};

/**
 * "Task: Contain host" for each cited item on Case `caseId`, keyed "kind:id"; with `viewer`, only
 * the items they can see. Joins `tx`.
 */
async function citationLabels(db: Db | Tx, caseId: string, citations: readonly Citation[], viewer?: Actor) {
  const labels = new Map<string, string>();
  const taskIds = citations.filter((c) => c.kind === "task").map((c) => c.id);
  if (taskIds.length) {
    const rows = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.caseId, caseId), inArray(tasks.id, taskIds), viewer ? visibleItems(viewer, tasks.internal) : undefined));
    for (const r of rows) labels.set(`task:${r.id}`, `Task: ${r.title}`);
  }
  return labels;
}

/** How the Case Audit Log records an entry: when, what, and what it cites. */
const describe = (occurredAt: OccurredAt, body: string, citations: readonly Citation[], labels: ReadonlyMap<string, string>) => {
  const cited = citations.map((c) => labels.get(`${c.kind}:${c.id}`) ?? c.kind);
  return [describeOccurredAt(occurredAt), body, ...(cited.length ? [`cites ${cited.join(", ")}`] : [])].join(" · ");
};

/** Locks an entry on the locked Case for the rest of `tx`, or throws `TimelineEntryNotFound`. */
const lock = async (tx: Tx, caseId: string, id: string) => {
  const [row] = await tx
    .select()
    .from(timelineEntries)
    .where(and(eq(timelineEntries.id, id), eq(timelineEntries.caseId, caseId)))
    .for("update");
  if (!row) throw new TimelineEntryNotFound();
  return row;
};

/** The citations' labels, once each is known to be on Case `caseId`; else `CitationNotFound`. */
const checkCitations = async (tx: Tx, caseId: string, citations: readonly Citation[]) => {
  const labels = await citationLabels(tx, caseId, citations);
  if (citations.some((c) => !labels.has(`${c.kind}:${c.id}`))) throw new CitationNotFound();
  return labels;
};

/**
 * Throws unless `source` is on Case `caseId`, can be Promoted, and isn't on the Timeline already.
 * Returns whether it is Internal.
 */
const checkSource = async (tx: Tx, caseId: string, source: PromotionSource) => {
  let internal = false;
  if (source.kind === "discussion_message") {
    const [message] = await tx
      .select({ retractedAt: discussionMessages.retractedAt, internal: discussionMessages.internal })
      .from(discussionMessages)
      .where(and(eq(discussionMessages.id, source.id), eq(discussionMessages.caseId, caseId)));
    if (!message) throw new SourceNotFound();
    if (message.retractedAt) throw new SourceRetracted();
    internal = message.internal;
  } else {
    const [entry] = await tx
      .select({ id: caseAuditLog.id })
      .from(caseAuditLog)
      .where(and(eq(caseAuditLog.id, source.id), eq(caseAuditLog.caseId, caseId)));
    if (!entry) throw new SourceNotFound();
  }
  const [existing] = await tx
    .select({ id: timelineEntries.id })
    .from(timelineEntries)
    .where(
      and(
        eq(timelineEntries.caseId, caseId),
        eq(timelineEntries.sourceKind, source.kind),
        eq(timelineEntries.sourceId, source.id),
        isNull(timelineEntries.retractedAt),
      ),
    );
  if (existing) throw new AlreadyPromoted(existing.id);
  return internal;
};

const SOURCE_NAMES = { discussion_message: "from Discussion message", audit_log_entry: "from Audit Log entry" } as const;

export function timelineStore({ db, clock }: { db: Db; clock: Clock }) {
  /** The id of Case `number`, or `CaseNotFound` when `me` can't see it. */
  const findCase = async (me: Participant, number: number) => {
    const [found] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(visibleCases(me), eq(cases.number, number)))
      .limit(1);
    if (!found) throw new CaseNotFound();
    return found.id;
  };

  /** The Case's entries (or just `id`) that `me` can see, in Timeline order. */
  const select = async (me: Actor, caseId: string, id?: string): Promise<TimelineEntryView[]> => {
    const rows = await db
      .select({
        entry: timelineEntries,
        recordedByName: recordedBy.name,
        retractedByName: retractedBy.name,
      })
      .from(timelineEntries)
      .innerJoin(recordedBy, eq(timelineEntries.recordedById, recordedBy.id))
      .leftJoin(retractedBy, eq(timelineEntries.retractedById, retractedBy.id))
      .where(and(eq(timelineEntries.caseId, caseId), id ? eq(timelineEntries.id, id) : undefined, visibleItems(me, timelineEntries.internal)))
      .orderBy(
        asc(timelineEntries.occurredStart),
        sql`${timelineEntries.occurredEnd} asc nulls first`,
        asc(timelineEntries.recordedAt),
        asc(timelineEntries.seq),
      );
    const entries = rows.map((r) => r.entry);
    const labels = await citationLabels(db, caseId, entries.flatMap((e) => e.citations), me);
    const sources = await sourceViews(me, caseId, entries);
    const hidden = !casePolicy.canMarkInternal(me);
    return rows.map(({ entry: e, recordedByName, retractedByName }) => ({
      id: e.id,
      occurredAt: occurredAtOf(e),
      body: e.body,
      citations: e.citations
        // A Guest doesn't learn of the Internal items an entry cites.
        .filter((c) => !hidden || labels.has(`${c.kind}:${c.id}`))
        .map((c) => ({ ...c, label: labels.get(`${c.kind}:${c.id}`) ?? "(not found)" })),
      source: e.sourceId ? (sources.get(e.sourceId) ?? null) : null,
      internal: e.internal,
      version: e.version,
      recordedBy: { id: e.recordedById, name: recordedByName },
      recordedAt: e.recordedAt.toISOString(),
      editedAt: e.editedAt?.toISOString() ?? null,
      retracted:
        e.retractedAt && e.retractedById
          ? { by: { id: e.retractedById, name: retractedByName ?? "" }, at: e.retractedAt.toISOString(), reason: e.retractionReason }
          : null,
    }));
  };

  /** What the entries were Promoted from, by source id; only the sources `me` can see. */
  const sourceViews = async (me: Actor, caseId: string, entries: readonly Row[]) => {
    const ids = (kind: PromotionSource["kind"]) => entries.filter((e) => e.sourceKind === kind).map((e) => e.sourceId!);
    const views = new Map<string, SourceView>();
    const messageIds = ids("discussion_message");
    if (messageIds.length) {
      const rows = await db
        .select({ id: discussionMessages.id, authorId: user.id, authorName: user.name, postedAt: discussionMessages.postedAt })
        .from(discussionMessages)
        .innerJoin(user, eq(discussionMessages.authorId, user.id))
        .where(
          and(eq(discussionMessages.caseId, caseId), inArray(discussionMessages.id, messageIds), visibleItems(me, discussionMessages.internal)),
        );
      for (const r of rows) {
        views.set(r.id, {
          kind: "discussion_message",
          id: r.id,
          author: { id: r.authorId, name: r.authorName },
          postedAt: r.postedAt.toISOString(),
        });
      }
    }
    const auditIds = ids("audit_log_entry");
    if (auditIds.length) {
      const rows = await db
        .select({ id: caseAuditLog.id, action: caseAuditLog.action, actor: caseAuditLog.actorName, occurredAt: caseAuditLog.occurredAt })
        .from(caseAuditLog)
        .where(and(eq(caseAuditLog.caseId, caseId), inArray(caseAuditLog.id, auditIds)));
      for (const r of rows) {
        views.set(r.id, {
          kind: "audit_log_entry",
          id: r.id,
          action: r.action as CaseAuditAction,
          actor: r.actor,
          occurredAt: r.occurredAt.toISOString(),
        });
      }
    }
    return views;
  };

  const view = async (me: Participant, number: number, id: string) => {
    const [entry] = await select(me, await findCase(me, number), id);
    if (!entry) throw new TimelineEntryNotFound();
    return entry;
  };

  return {
    /** The Case's Timeline, ordered by when things happened; retracted entries included. */
    async list(me: Participant, number: number) {
      const entries = await select(me, await findCase(me, number));
      if (casePolicy.canReadAuditLog(me)) return entries;
      // Guests never see the Audit Log, so not the entry of it a Timeline Entry was Promoted from either.
      return entries.map((e) => (e.source?.kind === "audit_log_entry" ? { ...e, source: null } : e));
    },

    /** Adds an entry; with `source`, Promotes that Discussion message or Audit Log entry into it. */
    async add(me: Membership, number: number, input: NewTimelineEntry, source?: PromotionSource) {
      const now = clock.now();
      const id = secureId();
      const citations = distinct(input.citations);
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const labels = await checkCitations(tx, current.id, citations);
        const sourceInternal = source ? await checkSource(tx, current.id, source) : false;
        const internal = input.internal ?? sourceInternal;
        const occurred = occurredColumns(input.occurredAt);
        await tx.insert(timelineEntries).values({
          id,
          organizationId: me.organizationId,
          caseId: current.id,
          ...occurred,
          body: input.body,
          citations,
          sourceKind: source?.kind ?? null,
          sourceId: source?.id ?? null,
          internal,
          version: 1,
          recordedById: me.userId,
          recordedAt: now,
        });
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: source ? "timeline.entry_promoted" : "timeline.entry_added",
          target: [...(source ? [SOURCE_NAMES[source.kind]] : []), ...(internal ? ["Internal"] : [])].join(" · ") || null,
          after: describe(occurredAtOf(occurred), input.body, citations, labels),
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id, membersOnly: internal });
      });
      return view(me, number, id);
    },

    /**
     * Replaces the entry's occurred-at, text and citations if `version` is still current; otherwise
     * throws `StaleTimelineEntry` with the entry as it is now. The Audit Log keeps the version before.
     */
    async edit(me: Membership, number: number, id: string, input: TimelineEntryInput, version: number) {
      const now = clock.now();
      const citations = distinct(input.citations);
      const saved = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const entry = await lock(tx, current.id, id);
        if (entry.retractedAt) throw new TimelineEntryRetracted();
        if (entry.version !== version) return false;
        const occurred = occurredColumns(input.occurredAt);
        const before = occurredAtOf(entry);
        const after = occurredAtOf(occurred);
        const unchanged =
          JSON.stringify(before) === JSON.stringify(after) &&
          input.body === entry.body &&
          // jsonb reorders keys, so compare citations as `distinct` writes them.
          JSON.stringify(citations) === JSON.stringify(distinct(entry.citations));
        if (unchanged) return true;
        const labels = await checkCitations(tx, current.id, citations);
        const beforeLabels = await citationLabels(tx, current.id, entry.citations);
        await tx
          .update(timelineEntries)
          .set({ ...occurred, body: input.body, citations, version: version + 1, editedAt: now })
          .where(eq(timelineEntries.id, id));
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "timeline.entry_edited",
          before: describe(before, entry.body, entry.citations, beforeLabels),
          after: describe(after, input.body, citations, labels),
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id, membersOnly: entry.internal });
        return true;
      });
      const entry = await view(me, number, id);
      if (!saved) throw new StaleTimelineEntry(entry);
      return entry;
    },

    /** Withdraws the entry: it stays on the Timeline marked retracted, and in the Audit Log. */
    async retract(me: Membership, number: number, id: string, reason: string | null) {
      const now = clock.now();
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const entry = await lock(tx, current.id, id);
        if (entry.retractedAt) throw new TimelineEntryRetracted();
        await tx
          .update(timelineEntries)
          .set({ retractedById: me.userId, retractedAt: now, retractionReason: reason })
          .where(eq(timelineEntries.id, id));
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "timeline.entry_retracted",
          before: describe(occurredAtOf(entry), entry.body, entry.citations, await citationLabels(tx, current.id, entry.citations)),
          after: reason,
        });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: current.id, membersOnly: entry.internal });
      });
      return view(me, number, id);
    },
  };
}

export type TimelineStore = ReturnType<typeof timelineStore>;
