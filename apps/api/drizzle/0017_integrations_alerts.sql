CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"host" text,
	"user_name" text,
	"detected_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"version" integer NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"cloud" text NOT NULL,
	"credentials" text NOT NULL,
	"client_id_hint" text NOT NULL,
	"credentials_revision" integer NOT NULL,
	"credentials_updated_at" timestamp with time zone NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"health" text NOT NULL,
	"health_detail" text,
	"health_changed_at" timestamp with time zone NOT NULL,
	"worker_id" text,
	"stream_offset" bigint,
	"last_event_at" timestamp with time zone,
	"session_refresh_at" timestamp with time zone,
	"last_gap_at" timestamp with time zone,
	"last_gap_from_offset" bigint,
	"last_gap_to_offset" bigint,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "integrations_gap" CHECK (("integrations"."last_gap_at" IS NULL) = ("integrations"."last_gap_from_offset" IS NULL) AND ("integrations"."last_gap_at" IS NULL) = ("integrations"."last_gap_to_offset" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_integration_external_idx" ON "alerts" USING btree ("integration_id","external_id");--> statement-breakpoint
CREATE INDEX "alerts_org_received_idx" ON "alerts" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_org_name_idx" ON "integrations" USING btree ("organization_id",lower("name"));--> statement-breakpoint
-- Integrations are paused, not deleted, and Alerts are dismissed, not deleted (ADR 0003). REVOKE covers
-- ordinary roles; the triggers also stop the table owner.
REVOKE DELETE, TRUNCATE ON "integrations", "alerts" FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER integrations_no_delete BEFORE DELETE ON "integrations" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER integrations_no_truncate BEFORE TRUNCATE ON "integrations" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER alerts_no_delete BEFORE DELETE ON "alerts" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER alerts_no_truncate BEFORE TRUNCATE ON "alerts" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();
