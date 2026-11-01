import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { CaseSummary } from "../cases/case-summary";
import { CASE_TYPES, RESOLUTIONS, SEVERITIES, STATUSES } from "../cases/vocabulary";
import { STORED_LINK_TYPES } from "../case-links/vocabulary";
import { ASSET_TYPES, OBSERVABLE_TYPES } from "../observables/vocabulary";
import { type Citation, PROMOTION_SOURCES } from "../timeline/vocabulary";
import { organization, session, user } from "./auth-schema";

/**
 * The Organization Audit Log: who did what to the Organization's Members and configuration.
 * Append-only; migration 0003 makes UPDATE, DELETE and TRUNCATE fail at the database.
 */
export const orgAuditLog = pgTable(
  "org_audit_log",
  {
    id: text("id").primaryKey(),
    /** Insertion order, to sort entries that share a timestamp. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    actorType: text("actor_type", { enum: ["member", "operator", "system"] }).notNull(),
    actorId: text("actor_id").references(() => user.id, { onDelete: "restrict" }),
    /** The actor's name when they acted, so the entry reads the same after they leave. */
    actorName: text("actor_name").notNull(),
    category: text("category").notNull(),
    action: text("action").notNull(),
    /** What was acted on, as it was named at the time: a Member's name, an email, the Organization's name. */
    target: text("target"),
    before: text("before"),
    after: text("after"),
  },
  (t) => [index("org_audit_log_org_idx").on(t.organizationId, t.occurredAt)],
);

/**
 * A Case. Never deleted: migration 0005 makes DELETE and TRUNCATE fail at the database (ADR 0003).
 * `number` is the Organization's own sequence ("C-12"), which is how routes name a Case.
 * A Closed Case has a Resolution and nothing else has one; migration 0007 refuses changes to a
 * Closed Case's row other than reopening it.
 */
export const cases = pgTable(
  "cases",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    status: text("status", { enum: STATUSES }).notNull(),
    severity: text("severity", { enum: SEVERITIES }).notNull(),
    caseType: text("case_type", { enum: CASE_TYPES }).notNull(),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "restrict" }),
    /** Hidden from Analysts unless they are assigned to it; see `access/policy.ts`. */
    restricted: boolean("restricted").notNull().default(false),
    resolution: text("resolution", { enum: RESOLUTIONS }),
    closedById: text("closed_by_id").references(() => user.id, { onDelete: "restrict" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    summary: jsonb("summary").$type<CaseSummary>().notNull(),
    /** Moves on with every Case Summary save; a save based on an older version is refused. */
    summaryVersion: integer("summary_version").notNull(),
    summaryUpdatedById: text("summary_updated_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    summaryUpdatedAt: timestamp("summary_updated_at", { withTimezone: true }).notNull(),
    openedById: text("opened_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("cases_org_number_idx").on(t.organizationId, t.number),
    index("cases_org_updated_idx").on(t.organizationId, t.updatedAt),
    check(
      "cases_closed_has_resolution",
      sql`(${t.status} = 'closed') = (${t.resolution} IS NOT NULL)
        AND (${t.status} = 'closed') = (${t.closedById} IS NOT NULL)
        AND (${t.status} = 'closed') = (${t.closedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * The Case Audit Log: every action taken on a Case in Argus.
 * Append-only; migration 0005 makes UPDATE, DELETE and TRUNCATE fail at the database.
 */
export const caseAuditLog = pgTable(
  "case_audit_log",
  {
    id: text("id").primaryKey(),
    /** Insertion order, to sort entries that share a timestamp. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    actorType: text("actor_type", { enum: ["member", "guest", "crowdstrike", "system"] }).notNull(),
    actorId: text("actor_id").references(() => user.id, { onDelete: "restrict" }),
    /** The actor's name when they acted, so the entry reads the same after they leave. */
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    /** What within the Case was acted on, as it was named at the time: a Task's title, a Member's name. */
    target: text("target"),
    before: text("before"),
    after: text("after"),
  },
  (t) => [index("case_audit_log_case_idx").on(t.caseId, t.occurredAt)],
);

/**
 * Who is viewing which Case right now, for presence avatars: one row per live socket on a Case page,
 * shared by every `web` instance. Each instance refreshes `seen_at` for its own sockets; rows not
 * refreshed within the presence timeout (a crashed instance's) are swept. See `realtime/live.ts`.
 */
export const caseViewers = pgTable(
  "case_viewers",
  {
    socketId: text("socket_id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("case_viewers_case_idx").on(t.caseId), index("case_viewers_seen_idx").on(t.seenAt)],
);

/**
 * The Organization's Case Role catalog. Never deleted: a retired Case Role is no longer offered,
 * but the Case Role assignments already made with it stay. Names are unique among the active ones.
 */
export const caseRoles = pgTable(
  "case_roles",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("case_roles_org_active_name_idx")
      .on(t.organizationId, sql`lower(${t.name})`)
      .where(sql`${t.retiredAt} IS NULL`),
  ],
);

/**
 * A Case Role given to a Member on a Case. Counts as assigned for Restricted Case visibility while
 * it hasn't ended (see `access/policy.ts`). Ending it keeps the row (ADR 0003).
 */
export const caseRoleAssignments = pgTable(
  "case_role_assignments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    caseRoleId: text("case_role_id")
      .notNull()
      .references(() => caseRoles.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    assignedById: text("assigned_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull(),
    endedById: text("ended_by_id").references(() => user.id, { onDelete: "restrict" }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("case_role_assignments_active_idx")
      .on(t.caseId, t.caseRoleId, t.userId)
      .where(sql`${t.endedAt} IS NULL`),
    index("case_role_assignments_user_idx").on(t.userId, t.caseId),
    check("case_role_assignments_ended", sql`(${t.endedAt} IS NULL) = (${t.endedById} IS NULL)`),
  ],
);

/**
 * A Task on a Case: one owner, done or not. Never deleted (ADR 0003). `version` moves on with every
 * edit; an edit based on an older version is refused.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    dueDate: date("due_date", { mode: "string" }),
    done: boolean("done").notNull().default(false),
    completedById: text("completed_by_id").references(() => user.id, { onDelete: "restrict" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    version: integer("version").notNull(),
    createdById: text("created_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("tasks_case_idx").on(t.caseId, t.createdAt),
    check(
      "tasks_done_has_completion",
      sql`${t.done} = (${t.completedById} IS NOT NULL) AND ${t.done} = (${t.completedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * A message in a Case's Discussion. Never deleted (ADR 0003): its author edits or retracts it, and
 * the Case Audit Log keeps every earlier text. `body` is plain text in which `<@userId>` mentions
 * someone (see `discussion/mentions.ts`). A retracted message's text is no longer shown.
 */
export const discussionMessages = pgTable(
  "discussion_messages",
  {
    id: text("id").primaryKey(),
    /** Insertion order, to sort messages posted at the same instant. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    retractedAt: timestamp("retracted_at", { withTimezone: true }),
  },
  (t) => [index("discussion_messages_case_idx").on(t.caseId, t.seq)],
);

/**
 * Who was mentioned in which Discussion message, and when they first were: on posting, or on the
 * edit that added them. Append-only, for notifications. A mention never grants access to the Case.
 */
export const discussionMentions = pgTable(
  "discussion_mentions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    messageId: text("message_id")
      .notNull()
      .references(() => discussionMessages.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    mentionedById: text("mentioned_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    mentionedAt: timestamp("mentioned_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("discussion_mentions_message_user_idx").on(t.messageId, t.userId),
    index("discussion_mentions_user_idx").on(t.userId, t.mentionedAt),
  ],
);

/**
 * A Timeline Entry: one real-world occurrence on a Case's Timeline. Never deleted (ADR 0003): it is
 * edited or retracted, and the Case Audit Log keeps every earlier version.
 *
 * Occurred-at is exact (`occurred_start` only), a range (`occurred_start` to `occurred_end`) or
 * approximate (`occurred_start` give or take `occurred_precision_minutes`). The Timeline is ordered
 * by `occurred_start`. `recorded_at` is when it was added to Argus.
 *
 * A Promoted entry names its source: a Discussion message or a Case Audit Log entry on the same Case.
 * `version` moves on with every edit; an edit based on an older version is refused.
 */
export const timelineEntries = pgTable(
  "timeline_entries",
  {
    id: text("id").primaryKey(),
    /** Insertion order, to sort entries recorded at the same instant. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    occurredKind: text("occurred_kind", { enum: ["exact", "range", "approximate"] }).notNull(),
    occurredStart: timestamp("occurred_start", { withTimezone: true }).notNull(),
    occurredEnd: timestamp("occurred_end", { withTimezone: true }),
    occurredPrecisionMinutes: integer("occurred_precision_minutes"),
    body: text("body").notNull(),
    citations: jsonb("citations").$type<Citation[]>().notNull(),
    sourceKind: text("source_kind", { enum: PROMOTION_SOURCES }),
    sourceId: text("source_id"),
    version: integer("version").notNull(),
    recordedById: text("recorded_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    retractedById: text("retracted_by_id").references(() => user.id, { onDelete: "restrict" }),
    retractedAt: timestamp("retracted_at", { withTimezone: true }),
    retractionReason: text("retraction_reason"),
  },
  (t) => [
    index("timeline_entries_case_idx").on(t.caseId, t.occurredStart),
    /** A source is Promoted into at most one entry that hasn't been retracted. */
    uniqueIndex("timeline_entries_source_idx")
      .on(t.caseId, t.sourceKind, t.sourceId)
      .where(sql`${t.sourceKind} IS NOT NULL AND ${t.retractedAt} IS NULL`),
    check(
      "timeline_entries_occurred",
      sql`CASE ${t.occurredKind}
        WHEN 'exact' THEN ${t.occurredEnd} IS NULL AND ${t.occurredPrecisionMinutes} IS NULL
        WHEN 'range' THEN ${t.occurredEnd} > ${t.occurredStart} AND ${t.occurredPrecisionMinutes} IS NULL
        WHEN 'approximate' THEN ${t.occurredEnd} IS NULL AND ${t.occurredPrecisionMinutes} > 0
      END`,
    ),
    check("timeline_entries_source", sql`(${t.sourceKind} IS NULL) = (${t.sourceId} IS NULL)`),
    check("timeline_entries_retracted", sql`(${t.retractedAt} IS NULL) = (${t.retractedById} IS NULL)`),
  ],
);

/**
 * Evidence: a file added to a Case. Its bytes are in Evidence storage under `storage_key`
 * (`evidence/storage.ts`); `sha256` is their fingerprint, computed as they arrived. Never altered or
 * deleted (ADR 0003): migration 0013 makes UPDATE, DELETE and TRUNCATE fail at the database. Every
 * view and download is recorded in the Case Audit Log.
 */
export const evidence = pgTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    /** Insertion order, to sort files added at the same instant. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    /** The file's name as it was added. */
    name: text("name").notNull(),
    /** The media type it was added with, such as `message/rfc822`. */
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** Lowercase hex. */
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    addedById: text("added_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("evidence_case_idx").on(t.caseId, t.seq),
    uniqueIndex("evidence_storage_key_idx").on(t.storageKey),
    check("evidence_sha256", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check("evidence_size", sql`${t.sizeBytes} > 0`),
  ],
);

/**
 * Something held once per Organization and linked to every Case it appears in (an Observable or an
 * Asset), with its links. Both are built here so they have the same shape, and `observables/` works
 * on either.
 *
 * An item is never deleted (ADR 0003). `match_key` is its normalised value
 * (`observables/vocabulary.ts`) and unique per Organization and type; `value` is how it is shown.
 * Unlinking an item from a Case ends the link and keeps the row; linking it again adds a new one.
 */
function heldOncePerOrganization(names: { items: string; links: string; itemId: string }, types: readonly string[]) {
  const items = pgTable(
    names.items,
    {
      id: text("id").primaryKey(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => organization.id, { onDelete: "restrict" }),
      type: text("type").notNull(),
      value: text("value").notNull(),
      matchKey: text("match_key").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    },
    (t) => [
      uniqueIndex(`${names.items}_org_key_idx`).on(t.organizationId, t.type, t.matchKey),
      check(`${names.items}_type`, sql`${t.type} IN (${sql.raw(types.map((x) => `'${x}'`).join(", "))})`),
    ],
  );
  const links = pgTable(
    names.links,
    {
      id: text("id").primaryKey(),
      /** Insertion order, to sort items linked at the same instant. */
      seq: bigserial("seq", { mode: "number" }).notNull(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => organization.id, { onDelete: "restrict" }),
      caseId: text("case_id")
        .notNull()
        .references(() => cases.id, { onDelete: "restrict" }),
      itemId: text(names.itemId)
        .notNull()
        .references(() => items.id, { onDelete: "restrict" }),
      linkedById: text("linked_by_id")
        .notNull()
        .references(() => user.id, { onDelete: "restrict" }),
      linkedAt: timestamp("linked_at", { withTimezone: true }).notNull(),
      unlinkedById: text("unlinked_by_id").references(() => user.id, { onDelete: "restrict" }),
      unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
    },
    (t) => [
      uniqueIndex(`${names.links}_active_idx`)
        .on(t.caseId, t.itemId)
        .where(sql`${t.unlinkedAt} IS NULL`),
      index(`${names.links}_item_idx`)
        .on(t.itemId, t.caseId)
        .where(sql`${t.unlinkedAt} IS NULL`),
      check(`${names.links}_unlinked`, sql`(${t.unlinkedAt} IS NULL) = (${t.unlinkedById} IS NULL)`),
    ],
  );
  return { items, links };
}

/** Observables (an IP, domain, URL, email address or hash) and the Cases they are linked to. */
export const { items: observables, links: caseObservables } = heldOncePerOrganization(
  { items: "observables", links: "case_observables", itemId: "observable_id" },
  OBSERVABLE_TYPES,
);

/** Assets (a host or account) and the Cases they are linked to. */
export const { items: assets, links: caseAssets } = heldOncePerOrganization(
  { items: "assets", links: "case_assets", itemId: "asset_id" },
  ASSET_TYPES,
);

/**
 * Case Links: a typed relationship from one Case (`source`) to another (`target`) in the same
 * Organization, stored once and read from either side (`case-links/vocabulary.ts`). Two Cases have at
 * most one link at a time. Removing a link ends it and keeps the row (ADR 0003).
 */
export const caseLinks = pgTable(
  "case_links",
  {
    id: text("id").primaryKey(),
    /** Insertion order, to sort links made at the same instant. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    sourceCaseId: text("source_case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    targetCaseId: text("target_case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    type: text("type", { enum: STORED_LINK_TYPES }).notNull(),
    linkedById: text("linked_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull(),
    unlinkedById: text("unlinked_by_id").references(() => user.id, { onDelete: "restrict" }),
    unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("case_links_active_pair_idx")
      .on(sql`least(${t.sourceCaseId}, ${t.targetCaseId})`, sql`greatest(${t.sourceCaseId}, ${t.targetCaseId})`)
      .where(sql`${t.unlinkedAt} IS NULL`),
    index("case_links_source_idx")
      .on(t.sourceCaseId)
      .where(sql`${t.unlinkedAt} IS NULL`),
    index("case_links_target_idx")
      .on(t.targetCaseId)
      .where(sql`${t.unlinkedAt} IS NULL`),
    check("case_links_not_self", sql`${t.sourceCaseId} <> ${t.targetCaseId}`),
    check("case_links_type", sql`${t.type} IN (${sql.raw(STORED_LINK_TYPES.map((x) => `'${x}'`).join(", "))})`),
    check("case_links_unlinked", sql`(${t.unlinkedAt} IS NULL) = (${t.unlinkedById} IS NULL)`),
  ],
);

/**
 * Tags on Cases. `tag` is in its stored form (`tags/vocabulary.ts`). Removing a Tag ends the row
 * and keeps it (ADR 0003); adding it again adds a new one.
 */
export const caseTags = pgTable(
  "case_tags",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    tag: text("tag").notNull(),
    addedById: text("added_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
    removedById: text("removed_by_id").references(() => user.id, { onDelete: "restrict" }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("case_tags_active_idx")
      .on(t.caseId, t.tag)
      .where(sql`${t.removedAt} IS NULL`),
    index("case_tags_org_tag_idx")
      .on(t.organizationId, t.tag)
      .where(sql`${t.removedAt} IS NULL`),
    check("case_tags_removed", sql`(${t.removedAt} IS NULL) = (${t.removedById} IS NULL)`),
  ],
);

/**
 * A Guest grant: a person from outside the Organization let into one Case, optionally until
 * `expires_at`. Counts for visibility while it hasn't ended or expired (see `access/policy.ts`).
 * Removing a Guest ends the grant and keeps the row (ADR 0003); migration 0016 refuses deletes.
 */
export const caseGuests = pgTable(
  "case_guests",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    invitedById: text("invited_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull(),
    endedById: text("ended_by_id").references(() => user.id, { onDelete: "restrict" }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("case_guests_active_idx").on(t.caseId, t.userId).where(sql`${t.endedAt} IS NULL`),
    index("case_guests_user_idx").on(t.userId, t.caseId),
    check("case_guests_ended", sql`(${t.endedAt} IS NULL) = (${t.endedById} IS NULL)`),
  ],
);

/**
 * A Guest's Better Auth session as Argus judges it: it ends at `expires_at` (about 12 hours after it
 * started, by Argus's clock), and `organization_id` is the Organization the Guest is working in.
 * Goes with the session when it is signed out.
 */
export const guestSessions = pgTable("guest_sessions", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => session.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "set null" }),
});
