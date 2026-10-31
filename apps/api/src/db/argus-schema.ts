import { bigserial, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
