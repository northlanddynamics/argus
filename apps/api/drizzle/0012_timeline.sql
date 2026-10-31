CREATE TABLE "timeline_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"occurred_kind" text NOT NULL,
	"occurred_start" timestamp with time zone NOT NULL,
	"occurred_end" timestamp with time zone,
	"occurred_precision_minutes" integer,
	"body" text NOT NULL,
	"citations" jsonb NOT NULL,
	"source_kind" text,
	"source_id" text,
	"version" integer NOT NULL,
	"recorded_by_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"retracted_by_id" text,
	"retracted_at" timestamp with time zone,
	"retraction_reason" text,
	CONSTRAINT "timeline_entries_occurred" CHECK (CASE "timeline_entries"."occurred_kind"
        WHEN 'exact' THEN "timeline_entries"."occurred_end" IS NULL AND "timeline_entries"."occurred_precision_minutes" IS NULL
        WHEN 'range' THEN "timeline_entries"."occurred_end" > "timeline_entries"."occurred_start" AND "timeline_entries"."occurred_precision_minutes" IS NULL
        WHEN 'approximate' THEN "timeline_entries"."occurred_end" IS NULL AND "timeline_entries"."occurred_precision_minutes" > 0
      END),
	CONSTRAINT "timeline_entries_source" CHECK (("timeline_entries"."source_kind" IS NULL) = ("timeline_entries"."source_id" IS NULL)),
	CONSTRAINT "timeline_entries_retracted" CHECK (("timeline_entries"."retracted_at" IS NULL) = ("timeline_entries"."retracted_by_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "timeline_entries" ADD CONSTRAINT "timeline_entries_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_entries" ADD CONSTRAINT "timeline_entries_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_entries" ADD CONSTRAINT "timeline_entries_recorded_by_id_user_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_entries" ADD CONSTRAINT "timeline_entries_retracted_by_id_user_id_fk" FOREIGN KEY ("retracted_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timeline_entries_case_idx" ON "timeline_entries" USING btree ("case_id","occurred_start");--> statement-breakpoint
CREATE UNIQUE INDEX "timeline_entries_source_idx" ON "timeline_entries" USING btree ("case_id","source_kind","source_id") WHERE "timeline_entries"."source_kind" IS NOT NULL AND "timeline_entries"."retracted_at" IS NULL;--> statement-breakpoint
-- Timeline Entries are never deleted (ADR 0003): they are edited or retracted, with every earlier
-- version in the Case Audit Log. REVOKE covers ordinary roles; the triggers also stop the owner.
REVOKE DELETE, TRUNCATE ON "timeline_entries" FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER timeline_entries_no_delete BEFORE DELETE ON "timeline_entries" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER timeline_entries_no_truncate BEFORE TRUNCATE ON "timeline_entries" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();
