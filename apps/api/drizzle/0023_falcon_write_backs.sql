CREATE TABLE "falcon_write_backs" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"alert_id" text NOT NULL,
	"external_id" text NOT NULL,
	"action" text NOT NULL,
	"falcon_status" text,
	"comment" text,
	"assignee_email" text,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "falcon_write_backs" ADD CONSTRAINT "falcon_write_backs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "falcon_write_backs" ADD CONSTRAINT "falcon_write_backs_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "falcon_write_backs" ADD CONSTRAINT "falcon_write_backs_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "falcon_write_backs_due_idx" ON "falcon_write_backs" USING btree ("next_attempt_at") WHERE "falcon_write_backs"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "falcon_write_backs_alert_idx" ON "falcon_write_backs" USING btree ("alert_id","seq");--> statement-breakpoint
CREATE INDEX "falcon_write_backs_integration_idx" ON "falcon_write_backs" USING btree ("integration_id","state");