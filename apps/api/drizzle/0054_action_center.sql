CREATE TABLE "action_log" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"action" text NOT NULL,
	"response_action_id" text,
	"observable_id" text,
	"asset_id" text,
	"value_type" text NOT NULL,
	"value" text NOT NULL,
	"integration_id" text,
	"case_id" text,
	"source" text NOT NULL,
	"outcome" text,
	"detail" text,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "action_log_response_action" CHECK (("action_log"."action" = 'response_action') = ("action_log"."response_action_id" IS NOT NULL)),
	CONSTRAINT "action_log_outcome" CHECK (("action_log"."action" = 'response_action') = ("action_log"."outcome" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "response_actions" ALTER COLUMN "case_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "response_actions" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_response_action_id_response_actions_id_fk" FOREIGN KEY ("response_action_id") REFERENCES "public"."response_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_observable_id_observables_id_fk" FOREIGN KEY ("observable_id") REFERENCES "public"."observables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_log_org_idx" ON "action_log" USING btree ("organization_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "action_log_response_action_idx" ON "action_log" USING btree ("response_action_id") WHERE "action_log"."response_action_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "response_actions_no_case_idx" ON "response_actions" USING btree ("organization_id","seq") WHERE "response_actions"."case_id" IS NULL;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_case_or_reason" CHECK ("response_actions"."case_id" IS NOT NULL OR "response_actions"."reason" IS NOT NULL);--> statement-breakpoint
CREATE TRIGGER action_log_no_delete BEFORE DELETE ON "action_log" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER action_log_no_truncate BEFORE TRUNCATE ON "action_log" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();