CREATE TABLE "case_guests" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"invited_by_id" text NOT NULL,
	"invited_at" timestamp with time zone NOT NULL,
	"ended_by_id" text,
	"ended_at" timestamp with time zone,
	CONSTRAINT "case_guests_ended" CHECK (("case_guests"."ended_at" IS NULL) = ("case_guests"."ended_by_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "guest_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"organization_id" text
);
--> statement-breakpoint
ALTER TABLE "case_guests" ADD CONSTRAINT "case_guests_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_guests" ADD CONSTRAINT "case_guests_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_guests" ADD CONSTRAINT "case_guests_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_guests" ADD CONSTRAINT "case_guests_invited_by_id_user_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_guests" ADD CONSTRAINT "case_guests_ended_by_id_user_id_fk" FOREIGN KEY ("ended_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_sessions" ADD CONSTRAINT "guest_sessions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_guests_active_idx" ON "case_guests" USING btree ("case_id","user_id") WHERE "case_guests"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "case_guests_user_idx" ON "case_guests" USING btree ("user_id","case_id");--> statement-breakpoint
-- Removing a Guest ends the grant rather than deleting it (ADR 0003). REVOKE covers ordinary roles; the
-- triggers also stop the table owner.
REVOKE DELETE, TRUNCATE ON "case_guests" FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER case_guests_no_delete BEFORE DELETE ON "case_guests" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER case_guests_no_truncate BEFORE TRUNCATE ON "case_guests" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();