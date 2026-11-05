CREATE TABLE "response_action_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"response_action_id" text NOT NULL,
	"operation" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "response_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"observable_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_type" text NOT NULL,
	"target_value" text NOT NULL,
	"falcon_action" text,
	"severity" text,
	"state" text NOT NULL,
	"external_id" text,
	"last_error" text,
	"internal" boolean DEFAULT false NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "response_actions_falcon" CHECK (("response_actions"."kind" = 'falcon_ioc') = ("response_actions"."falcon_action" IS NOT NULL AND "response_actions"."severity" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "timeline_entries" ADD COLUMN "response_action_id" text;--> statement-breakpoint
ALTER TABLE "response_action_outbox" ADD CONSTRAINT "response_action_outbox_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_action_outbox" ADD CONSTRAINT "response_action_outbox_response_action_id_response_actions_id_fk" FOREIGN KEY ("response_action_id") REFERENCES "public"."response_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_observable_id_observables_id_fk" FOREIGN KEY ("observable_id") REFERENCES "public"."observables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "response_action_outbox_due_idx" ON "response_action_outbox" USING btree ("next_attempt_at") WHERE "response_action_outbox"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "response_action_outbox_action_idx" ON "response_action_outbox" USING btree ("response_action_id","seq");--> statement-breakpoint
CREATE INDEX "response_actions_case_idx" ON "response_actions" USING btree ("case_id","seq");--> statement-breakpoint
CREATE INDEX "response_actions_observable_idx" ON "response_actions" USING btree ("observable_id");--> statement-breakpoint
ALTER TABLE "timeline_entries" ADD CONSTRAINT "timeline_entries_response_action_id_response_actions_id_fk" FOREIGN KEY ("response_action_id") REFERENCES "public"."response_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timeline_entries_response_action_idx" ON "timeline_entries" USING btree ("response_action_id") WHERE "timeline_entries"."response_action_id" IS NOT NULL;--> statement-breakpoint
-- Response Actions are never deleted (ADR 0003): they move to Removed. REVOKE covers ordinary roles;
-- the triggers also stop the table owner.
REVOKE DELETE, TRUNCATE ON "response_actions" FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER response_actions_no_delete BEFORE DELETE ON "response_actions" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER response_actions_no_truncate BEFORE TRUNCATE ON "response_actions" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();
