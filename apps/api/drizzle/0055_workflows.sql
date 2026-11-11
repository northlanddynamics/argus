CREATE TABLE "falcon_workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean NOT NULL,
	"on_demand" boolean NOT NULL,
	"inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"case_id" text,
	"reason" text,
	"inputs" jsonb NOT NULL,
	"state" text NOT NULL,
	"execution_id" text,
	"falcon_status" text,
	"activities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" jsonb,
	"last_error" text,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"checks" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workflow_runs_case_or_reason" CHECK ("workflow_runs"."case_id" IS NOT NULL OR "workflow_runs"."reason" IS NOT NULL),
	CONSTRAINT "workflow_runs_execution" CHECK ("workflow_runs"."state" NOT IN ('running', 'completed', 'cancelled', 'timed_out') OR "workflow_runs"."execution_id" IS NOT NULL),
	CONSTRAINT "workflow_runs_due" CHECK (("workflow_runs"."state" IN ('pending', 'running')) = ("workflow_runs"."next_check_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "action_log" DROP CONSTRAINT "action_log_outcome";--> statement-breakpoint
ALTER TABLE "action_log" ADD COLUMN "workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "workflows" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "workflows_due" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "workflows_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "workflows_error" text;--> statement-breakpoint
ALTER TABLE "falcon_workflows" ADD CONSTRAINT "falcon_workflows_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "falcon_workflows" ADD CONSTRAINT "falcon_workflows_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_falcon_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."falcon_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "falcon_workflows_definition_idx" ON "falcon_workflows" USING btree ("integration_id","definition_id");--> statement-breakpoint
CREATE INDEX "falcon_workflows_org_idx" ON "falcon_workflows" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_due_idx" ON "workflow_runs" USING btree ("next_check_at") WHERE "workflow_runs"."state" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "workflow_runs_case_idx" ON "workflow_runs" USING btree ("case_id","seq") WHERE "workflow_runs"."case_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_log_workflow_run_idx" ON "action_log" USING btree ("workflow_run_id") WHERE "action_log"."workflow_run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_workflow_run" CHECK (("action_log"."action" = 'workflow_run') = ("action_log"."workflow_run_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_outcome" CHECK (("action_log"."action" IN ('response_action', 'workflow_run')) = ("action_log"."outcome" IS NULL));--> statement-breakpoint
CREATE TRIGGER workflow_runs_no_delete BEFORE DELETE ON "workflow_runs" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER workflow_runs_no_truncate BEFORE TRUNCATE ON "workflow_runs" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();