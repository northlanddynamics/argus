import { sql } from "drizzle-orm";
import { bigserial, boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { CaseSummary } from "../cases/case-summary";
import { CASE_TYPES, RESOLUTIONS, SEVERITIES, STATUSES } from "../cases/vocabulary";
import { organization, user } from "./auth-schema";

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
