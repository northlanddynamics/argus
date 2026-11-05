import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { CaseSummary } from "../cases/case-summary";
import { CASE_TYPES, RESOLUTIONS, SEVERITIES, STATUSES } from "../cases/vocabulary";
import { STORED_LINK_TYPES } from "../case-links/vocabulary";
import { ASSET_TYPES, OBSERVABLE_TYPES } from "../observables/vocabulary";
import { PROVIDERS } from "../integrations/vocabulary";
import { NOTIFICATION_KINDS } from "../notifications/vocabulary";
import { TEAMS_POST_KINDS } from "../teams/vocabulary";
import { type Citation, PROMOTION_SOURCES } from "../timeline/vocabulary";
import { FALCON_IOC_ACTIONS, RESPONSE_ACTION_KINDS, RESPONSE_ACTION_ORIGINS, RESPONSE_ACTION_STATES } from "../response-actions/vocabulary";
import {
  ALERT_KINDS,
  ALERT_STATUSES,
  DISMISSAL_REASONS,
  FALCON_CLOUDS,
  INTEGRATION_HEALTH,
  WRITE_BACK_ACTIONS,
  WRITE_BACK_STATES,
} from "../alerts/vocabulary";
import { organization, session, user } from "./auth-schema";

/**
 * A Postgres `tsvector`: the words a row is found by in global search (`search/search.ts`). Each is a
 * stored generated column, kept up to date by Postgres, under the `simple` configuration (no
 * stemming or stop words, so hashes, IPs and host names stay whole) and with a GIN index.
 */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

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
    actorType: text("actor_type", { enum: ["member", "operator", "crowdstrike", "system"] }).notNull(),
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
    /** Its title (weighted A) and the text of its Case Summary (B). */
    search: tsvector("search")
      .notNull()
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', jsonb_path_query_array(summary, 'strict $.**.text')), 'B')`,
      ),
  },
  (t) => [
    uniqueIndex("cases_org_number_idx").on(t.organizationId, t.number),
    index("cases_org_updated_idx").on(t.organizationId, t.updatedAt),
    index("cases_search_idx").using("gin", t.search),
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
    /** Hidden from Guests on the Case (`access/policy.ts`). */
    internal: boolean("internal").notNull().default(false),
    /** The due date its owner was last told it is overdue for, so they are told once per due date. */
    overdueNotifiedFor: date("overdue_notified_for", { mode: "string" }),
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
    /** Null for a synced Falcon comment, which has no author in Argus. */
    authorId: text("author_id").references(() => user.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    retractedAt: timestamp("retracted_at", { withTimezone: true }),
    /** Hidden from Guests on the Case (`access/policy.ts`). */
    internal: boolean("internal").notNull().default(false),
    /**
     * A comment made in Falcon on an Alert attached to the Case, synced in (ADR 0002): the Alert, the
     * comment's identity in Falcon, and the Falcon user who made it, if Falcon said.
     */
    alertId: text("alert_id").references((): AnyPgColumn => alerts.id, { onDelete: "restrict" }),
    falconCommentId: text("falcon_comment_id"),
    falconAuthor: text("falcon_author"),
  },
  (t) => [
    index("discussion_messages_case_idx").on(t.caseId, t.seq),
    uniqueIndex("discussion_messages_falcon_comment_idx")
      .on(t.caseId, t.alertId, t.falconCommentId)
      .where(sql`${t.falconCommentId} IS NOT NULL`),
    check(
      "discussion_messages_author",
      sql`(${t.authorId} IS NULL) = (${t.falconCommentId} IS NOT NULL) AND (${t.falconCommentId} IS NULL) = (${t.alertId} IS NULL)`,
    ),
  ],
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
    /** Hidden from Guests on the Case (`access/policy.ts`). */
    internal: boolean("internal").notNull().default(false),
    /** The Response Action whose state change Argus recorded with this entry; it is Internal exactly when that is. */
    responseActionId: text("response_action_id").references((): AnyPgColumn => responseActions.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("timeline_entries_case_idx").on(t.caseId, t.occurredStart),
    index("timeline_entries_response_action_idx").on(t.responseActionId).where(sql`${t.responseActionId} IS NOT NULL`),
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
 * deleted (ADR 0003): migration 0013 makes UPDATE, DELETE and TRUNCATE fail at the database, and
 * migration 0019 lets only its Internal marking change. Every view and download is recorded in the
 * Case Audit Log.
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
    /** Hidden from Guests on the Case (`access/policy.ts`); the one column that can change (migration 0019). */
    internal: boolean("internal").notNull().default(false),
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
 *
 * A link's `alert_id` is set when attaching that Alert linked the item (the item was among those the
 * Alert names, in `alert_links`), and null when someone linked it by hand. `alert_links` holds what
 * each Alert names: added as detections arrive, and never removed.
 */
function heldOncePerOrganization(
  names: { items: string; links: string; itemId: string; alertLinks: string },
  types: readonly string[],
) {
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
      /** Its value as shown and as normalised. */
      search: tsvector("search")
        .notNull()
        .generatedAlwaysAs(sql`to_tsvector('simple', value || ' ' || match_key)`),
    },
    (t) => [
      uniqueIndex(`${names.items}_org_key_idx`).on(t.organizationId, t.type, t.matchKey),
      index(`${names.items}_search_idx`).using("gin", t.search),
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
      /** The Alert whose attachment linked it; null when linked by hand. */
      alertId: text("alert_id").references((): AnyPgColumn => alerts.id, { onDelete: "restrict" }),
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
  const alertLinks = pgTable(
    names.alertLinks,
    {
      organizationId: text("organization_id")
        .notNull()
        .references(() => organization.id, { onDelete: "restrict" }),
      alertId: text("alert_id")
        .notNull()
        .references((): AnyPgColumn => alerts.id, { onDelete: "restrict" }),
      itemId: text(names.itemId)
        .notNull()
        .references(() => items.id, { onDelete: "restrict" }),
      /** Insertion order: the order the detection named them in. */
      seq: bigserial("seq", { mode: "number" }).notNull(),
    },
    (t) => [primaryKey({ columns: [t.alertId, t.itemId] }), index(`${names.alertLinks}_item_idx`).on(t.itemId)],
  );
  return { items, links, alertLinks };
}

/** Observables (an IP, domain, URL, email address or hash) and the Cases they are linked to. */
export const { items: observables, links: caseObservables, alertLinks: alertObservables } = heldOncePerOrganization(
  { items: "observables", links: "case_observables", itemId: "observable_id", alertLinks: "alert_observables" },
  OBSERVABLE_TYPES,
);

/** Assets (a host or account) and the Cases they are linked to. */
export const { items: assets, links: caseAssets, alertLinks: alertAssets } = heldOncePerOrganization(
  { items: "assets", links: "case_assets", itemId: "asset_id", alertLinks: "alert_assets" },
  ASSET_TYPES,
);

/**
 * The Organization's Ignored Observables: Observables or Assets an Admin has marked as too common to
 * mean anything. Each entry names exactly one of the two. An item has at most one active entry;
 * removing it from the list ends the entry and keeps the row (ADR 0003), and adding it again adds a
 * new one. Ignoring changes nothing else about the item: it stays held, linked and searchable.
 */
export const ignoredObservables = pgTable(
  "ignored_observables",
  {
    id: text("id").primaryKey(),
    /** Insertion order, to sort entries added at the same instant. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    observableId: text("observable_id").references(() => observables.id, { onDelete: "restrict" }),
    assetId: text("asset_id").references(() => assets.id, { onDelete: "restrict" }),
    ignoredById: text("ignored_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    ignoredAt: timestamp("ignored_at", { withTimezone: true }).notNull(),
    endedById: text("ended_by_id").references(() => user.id, { onDelete: "restrict" }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("ignored_observables_observable_active_idx")
      .on(t.observableId)
      .where(sql`${t.endedAt} IS NULL AND ${t.observableId} IS NOT NULL`),
    uniqueIndex("ignored_observables_asset_active_idx")
      .on(t.assetId)
      .where(sql`${t.endedAt} IS NULL AND ${t.assetId} IS NOT NULL`),
    index("ignored_observables_org_idx")
      .on(t.organizationId, t.seq)
      .where(sql`${t.endedAt} IS NULL`),
    check("ignored_observables_one_item", sql`(${t.observableId} IS NULL) <> (${t.assetId} IS NULL)`),
    check("ignored_observables_ended", sql`(${t.endedAt} IS NULL) = (${t.endedById} IS NULL)`),
  ],
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

/**
 * An Integration: an Organization's connection to an external security tool from a Provider
 * (ADR 0002, 0007). `credentials` are the Provider's API credentials, sealed
 * (`integrations/credentials.ts`); `credentials_revision` moves on with every rotation so the worker
 * holding the stream reconnects with the new ones. `write_back` says whether Argus may write changes
 * to Alerts back to Falcon; off, the Integration only reads. `response_actions` says whether Response
 * Actions may be taken through it.
 *
 * The rest is the worker's account of the Event Streams connection: `stream_offset` is the offset of
 * the last event it processed (it resumes after it), and `last_gap_*` the last stretch of the stream
 * Falcon could no longer replay. Never deleted (ADR 0003); migration 0017 refuses deletes.
 */
export const integrations = pgTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    /** What it connects to, which fixes what it can do (`integrations/vocabulary.ts`, ADR 0007). */
    provider: text("provider", { enum: PROVIDERS }).notNull(),
    name: text("name").notNull(),
    cloud: text("cloud", { enum: FALCON_CLOUDS }).notNull(),
    credentials: text("credentials").notNull(),
    /** The last four characters of the client id, so Admins can tell which credentials are in use. */
    clientIdHint: text("client_id_hint").notNull(),
    credentialsRevision: integer("credentials_revision").notNull(),
    credentialsUpdatedAt: timestamp("credentials_updated_at", { withTimezone: true }).notNull(),
    paused: boolean("paused").notNull().default(false),
    writeBack: boolean("write_back").notNull().default(false),
    /** Whether Response Actions may be taken through it (ADR 0007); separate from write-back, off until an Admin turns it on. */
    responseActions: boolean("response_actions").notNull().default(false),
    health: text("health", { enum: INTEGRATION_HEALTH }).notNull(),
    healthDetail: text("health_detail"),
    healthChangedAt: timestamp("health_changed_at", { withTimezone: true }).notNull(),
    /** The worker that holds the stream, while one does. */
    workerId: text("worker_id"),
    streamOffset: bigint("stream_offset", { mode: "number" }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    sessionRefreshAt: timestamp("session_refresh_at", { withTimezone: true }),
    lastGapAt: timestamp("last_gap_at", { withTimezone: true }),
    lastGapFromOffset: bigint("last_gap_from_offset", { mode: "number" }),
    lastGapToOffset: bigint("last_gap_to_offset", { mode: "number" }),
    createdById: text("created_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("integrations_org_name_idx").on(t.organizationId, sql`lower(${t.name})`),
    check(
      "integrations_gap",
      sql`(${t.lastGapAt} IS NULL) = (${t.lastGapFromOffset} IS NULL) AND (${t.lastGapAt} IS NULL) = (${t.lastGapToOffset} IS NULL)`,
    ),
  ],
);

/**
 * An Alert: a detection received from an Integration. `external_id` is Falcon's `CompositeId`, unique
 * per Integration, so a detection delivered again updates its Alert instead of adding another.
 * `payload` is the detection event as Falcon sent it last. `version` moves on whenever the Alert
 * changes. Never deleted (ADR 0003); migration 0017 refuses deletes.
 *
 * An Alert is on at most one Case: `case_id` is set exactly while its Status is Attached, and
 * `dismissal_reason` exactly while it is Dismissed (`alerts_status`).
 */
export const alerts = pgTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    /** Insertion order, to sort Alerts received at the same instant. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "restrict" }),
    externalId: text("external_id").notNull(),
    kind: text("kind", { enum: ALERT_KINDS }).notNull(),
    status: text("status", { enum: ALERT_STATUSES }).notNull(),
    severity: text("severity", { enum: SEVERITIES }).notNull(),
    title: text("title").notNull(),
    description: text("description"),
    host: text("host"),
    userName: text("user_name"),
    /** When Falcon raised the detection, if it said. */
    detectedAt: timestamp("detected_at", { withTimezone: true }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    version: integer("version").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    caseId: text("case_id").references(() => cases.id, { onDelete: "restrict" }),
    attachedById: text("attached_by_id").references(() => user.id, { onDelete: "restrict" }),
    attachedAt: timestamp("attached_at", { withTimezone: true }),
    dismissalReason: text("dismissal_reason", { enum: DISMISSAL_REASONS }),
    dismissalComment: text("dismissal_comment"),
    dismissedById: text("dismissed_by_id").references(() => user.id, { onDelete: "restrict" }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    /** Hidden from Guests on the Case it is attached to; every attachment makes it Internal again. */
    internal: boolean("internal").notNull().default(true),
    /**
     * The Alert as Falcon has it: its status, assignee and tags there, each with the time of the
     * Falcon change that set it, so an older change arriving late never overwrites a newer one.
     */
    falconStatus: text("falcon_status"),
    falconStatusAt: timestamp("falcon_status_at", { withTimezone: true }),
    falconAssignee: text("falcon_assignee"),
    falconAssigneeAt: timestamp("falcon_assignee_at", { withTimezone: true }),
    falconTags: jsonb("falcon_tags").$type<string[]>().notNull().default([]),
    falconTagsAt: timestamp("falcon_tags_at", { withTimezone: true }),
    /**
     * Fetching the Alert's comments from Falcon (`crowdstrike/comment-sync.ts`): whether a fetch is
     * wanted, when the last one finished, and why it failed, if it did.
     */
    falconCommentsDue: boolean("falcon_comments_due").notNull().default(false),
    falconCommentsSyncedAt: timestamp("falcon_comments_synced_at", { withTimezone: true }),
    falconCommentsError: text("falcon_comments_error"),
    /** Its title, Falcon's id for it, host and user (weighted A), and its description (B). */
    search: tsvector("search")
      .notNull()
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('simple', title || ' ' || external_id || ' ' || coalesce(host, '') || ' ' || coalesce(user_name, '')), 'A') || setweight(to_tsvector('simple', coalesce(description, '')), 'B')`,
      ),
  },
  (t) => [
    uniqueIndex("alerts_integration_external_idx").on(t.integrationId, t.externalId),
    index("alerts_search_idx").using("gin", t.search),
    index("alerts_org_received_idx").on(t.organizationId, t.receivedAt),
    index("alerts_case_idx").on(t.caseId),
    index("alerts_falcon_comments_due_idx").on(t.id).where(sql`${t.falconCommentsDue}`),
    check(
      "alerts_status",
      sql`(${t.status} = 'attached') = (${t.caseId} IS NOT NULL) AND (${t.status} = 'dismissed') = (${t.dismissalReason} IS NOT NULL)`,
    ),
  ],
);

/**
 * The Falcon write-back outbox (ADR 0002): one row per change to one Alert that Argus is to write
 * back to Falcon, queued in the transaction that made the change, and sent by the worker. Rows for
 * the same Alert are sent in `seq` order, each only once those before it are done. A failed send
 * stays `pending` with `next_attempt_at` pushed back; `attempts` counts the failures.
 *
 * `falcon_status` and `comment` are what to set; for `assign`, `assignee_email` names the Falcon
 * user to assign to by email, and null unassigns.
 */
export const falconWriteBacks = pgTable(
  "falcon_write_backs",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "restrict" }),
    alertId: text("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "restrict" }),
    /** Falcon's composite ID for the Alert. */
    externalId: text("external_id").notNull(),
    action: text("action", { enum: WRITE_BACK_ACTIONS }).notNull(),
    falconStatus: text("falcon_status"),
    comment: text("comment"),
    assigneeEmail: text("assignee_email"),
    state: text("state", { enum: WRITE_BACK_STATES }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** When it was sent, skipped, cancelled or given up on. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("falcon_write_backs_due_idx").on(t.nextAttemptAt).where(sql`${t.state} = 'pending'`),
    index("falcon_write_backs_alert_idx").on(t.alertId, t.seq),
    index("falcon_write_backs_integration_idx").on(t.integrationId, t.state),
  ],
);

/**
 * The comments made on an Alert in Falcon, as fetched from there (ADR 0002), each held once by its
 * identity in Falcon. Comments Argus wrote itself (write-backs) are left out. While the Alert is
 * attached to a Case, each is also a message in that Case's Discussion.
 */
export const alertFalconComments = pgTable(
  "alert_falcon_comments",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    alertId: text("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "restrict" }),
    /** Falcon's id for the comment, or one derived from its time, author and text when Falcon gives none. */
    falconCommentId: text("falcon_comment_id").notNull(),
    /** The Falcon user who made it, if Falcon said. */
    author: text("author"),
    body: text("body").notNull(),
    /** When it was made in Falcon, if Falcon said. */
    createdAt: timestamp("created_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("alert_falcon_comments_alert_comment_idx").on(t.alertId, t.falconCommentId)],
);

/**
 * In-app notifications, one per recipient, and their email. Each names what it is about by id, so it
 * reads with current names, and the access policy decides at read time whether its recipient may
 * still see it. `email_pending` rows are the email outbox (`notifications/notifications.ts`).
 */
export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    recipientId: text("recipient_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    /** Who caused it; null when nobody did (a Task falling overdue). */
    actorId: text("actor_id").references(() => user.id, { onDelete: "restrict" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    messageId: text("message_id").references(() => discussionMessages.id, { onDelete: "restrict" }),
    /** The Guest added, for `guest_added`. */
    guestId: text("guest_id").references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    emailPending: boolean("email_pending").notNull().default(true),
    emailAttempts: integer("email_attempts").notNull().default(0),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
  },
  (t) => [
    index("notifications_recipient_idx").on(t.recipientId, t.seq),
    index("notifications_email_pending_idx").on(t.seq).where(sql`${t.emailPending}`),
  ],
);

/**
 * The Organization's Teams channel: the incoming webhook its posts go to, sealed at rest like
 * Integration credentials, since anyone holding the URL can post to the channel.
 */
export const teamsChannels = pgTable("teams_channels", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "restrict" }),
  webhookUrl: text("webhook_url").notNull(),
  /** The webhook's host and last four characters, so Admins can tell which one is in use. */
  urlHint: text("url_hint").notNull(),
  updatedById: text("updated_by_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/**
 * Posts to the Organization's Teams channel, queued in the transaction that made the change and
 * sent after it commits (`teams/teams.ts`). They name the Case by id, so each is written from the
 * Case as it is when sent; a Restricted Case gets a link only.
 */
export const teamsPosts = pgTable(
  "teams_posts",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: TEAMS_POST_KINDS }).notNull(),
    /** The Case's Severity when it happened. */
    severity: text("severity", { enum: SEVERITIES }).notNull(),
    /** How many Alerts the Case was opened from; null when it wasn't. */
    alertCount: integer("alert_count"),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    pending: boolean("pending").notNull().default(true),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("teams_posts_due_idx").on(t.nextAttemptAt).where(sql`${t.pending}`)],
);

/**
 * Response Actions (ADR 0007): what Argus does in an external tool against one Observable linked to a
 * Case, through one Integration. Never deleted (ADR 0003). `target_type` and `target_value` are what
 * the tool is sent, `external_id` the tool's id for what Argus created there. `falcon_action` and
 * `severity` are a Falcon IOC's parameters, `severity` mapped from the Case's when it was taken.
 * `state_changed_at` is when it reached its state; `sent_at` when the tool accepted it.
 * `last_error` is why the latest attempt failed, while it is retrying or Failed.
 *
 * `origin` says whether Argus created it in the tool, found it `already_present` (sent by Argus from
 * a Case before; `present_from_id` is that Response Action), or found it `in_tool` already. At most
 * one Pending or Active `created` Response Action exists per Integration, kind and target, so Argus
 * never sends the same thing twice. `dismissed_by_id` and `dismissed_at` say who dismissed an
 * "already present" record from its Case, and when.
 */
export const responseActions = pgTable(
  "response_actions",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "restrict" }),
    observableId: text("observable_id")
      .notNull()
      .references(() => observables.id, { onDelete: "restrict" }),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: RESPONSE_ACTION_KINDS }).notNull(),
    targetType: text("target_type").notNull(),
    targetValue: text("target_value").notNull(),
    falconAction: text("falcon_action", { enum: FALCON_IOC_ACTIONS }),
    severity: text("severity", { enum: SEVERITIES }),
    state: text("state", { enum: RESPONSE_ACTION_STATES }).notNull(),
    externalId: text("external_id"),
    lastError: text("last_error"),
    /** Hidden from Guests on the Case, with the Timeline Entries recording it. */
    internal: boolean("internal").notNull().default(false),
    createdById: text("created_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    stateChangedAt: timestamp("state_changed_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    origin: text("origin", { enum: RESPONSE_ACTION_ORIGINS }).notNull().default("created"),
    presentFromId: text("present_from_id").references((): AnyPgColumn => responseActions.id, { onDelete: "restrict" }),
    dismissedById: text("dismissed_by_id").references(() => user.id, { onDelete: "restrict" }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  },
  (t) => [
    index("response_actions_case_idx").on(t.caseId, t.seq),
    index("response_actions_observable_idx").on(t.observableId),
    index("response_actions_present_from_idx").on(t.presentFromId).where(sql`${t.presentFromId} IS NOT NULL`),
    uniqueIndex("response_actions_one_created_idx")
      .on(t.integrationId, t.kind, t.targetType, t.targetValue)
      .where(sql`${t.origin} = 'created' AND ${t.state} IN ('pending', 'active')`),
    check("response_actions_falcon", sql`(${t.kind} = 'falcon_ioc') = (${t.falconAction} IS NOT NULL AND ${t.severity} IS NOT NULL)`),
    check("response_actions_present_from", sql`(${t.origin} = 'already_present') = (${t.presentFromId} IS NOT NULL)`),
    check("response_actions_dismissed", sql`(${t.dismissedAt} IS NULL) = (${t.dismissedById} IS NULL)`),
  ],
);

/**
 * The Response Action outbox: one row per attempt to carry out a Response Action in its tool, queued
 * in the transaction that asked for it and sent by the worker (`response-actions/sender.ts`), as the
 * Falcon write-back outbox is. A failed send stays `pending` with `next_attempt_at` pushed back;
 * `attempts` counts the failures, and when they run out the row is `failed` and so is its Response
 * Action. A Retry queues a new row.
 */
export const responseActionOutbox = pgTable(
  "response_action_outbox",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    responseActionId: text("response_action_id")
      .notNull()
      .references(() => responseActions.id, { onDelete: "restrict" }),
    operation: text("operation", { enum: ["send"] }).notNull(),
    state: text("state", { enum: ["pending", "done", "failed"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("response_action_outbox_due_idx").on(t.nextAttemptAt).where(sql`${t.state} = 'pending'`),
    index("response_action_outbox_action_idx").on(t.responseActionId, t.seq),
  ],
);
