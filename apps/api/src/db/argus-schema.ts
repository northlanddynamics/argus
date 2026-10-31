import { sql } from "drizzle-orm";
import { bigserial, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
    before: text("before"),
    after: text("after"),
  },
  (t) => [index("case_audit_log_case_idx").on(t.caseId, t.occurredAt)],
);
