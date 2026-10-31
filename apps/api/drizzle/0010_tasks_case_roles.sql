CREATE TABLE "case_role_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"case_role_id" text NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by_id" text NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL,
	"ended_by_id" text,
	"ended_at" timestamp with time zone,
	CONSTRAINT "case_role_assignments_ended" CHECK (("case_role_assignments"."ended_at" IS NULL) = ("case_role_assignments"."ended_by_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "case_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"owner_id" text NOT NULL,
	"due_date" date,
	"done" boolean DEFAULT false NOT NULL,
	"completed_by_id" text,
	"completed_at" timestamp with time zone,
	"version" integer NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tasks_done_has_completion" CHECK ("tasks"."done" = ("tasks"."completed_by_id" IS NOT NULL) AND "tasks"."done" = ("tasks"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "case_audit_log" ADD COLUMN "target" text;--> statement-breakpoint
ALTER TABLE "case_role_assignments" ADD CONSTRAINT "case_role_assignments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_role_assignments" ADD CONSTRAINT "case_role_assignments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_role_assignments" ADD CONSTRAINT "case_role_assignments_case_role_id_case_roles_id_fk" FOREIGN KEY ("case_role_id") REFERENCES "public"."case_roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_role_assignments" ADD CONSTRAINT "case_role_assignments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_role_assignments" ADD CONSTRAINT "case_role_assignments_assigned_by_id_user_id_fk" FOREIGN KEY ("assigned_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_role_assignments" ADD CONSTRAINT "case_role_assignments_ended_by_id_user_id_fk" FOREIGN KEY ("ended_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_roles" ADD CONSTRAINT "case_roles_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_id_user_id_fk" FOREIGN KEY ("completed_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_role_assignments_active_idx" ON "case_role_assignments" USING btree ("case_id","case_role_id","user_id") WHERE "case_role_assignments"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "case_role_assignments_user_idx" ON "case_role_assignments" USING btree ("user_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_roles_org_active_name_idx" ON "case_roles" USING btree ("organization_id",lower("name")) WHERE "case_roles"."retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tasks_case_idx" ON "tasks" USING btree ("case_id","created_at");--> statement-breakpoint
-- Tasks, Case Roles and Case Role assignments are never deleted (ADR 0003): Case Roles are retired
-- and assignments ended instead. REVOKE covers ordinary roles; the triggers also stop the owner.
REVOKE DELETE, TRUNCATE ON "tasks", "case_roles", "case_role_assignments" FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION no_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be deleted: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER tasks_no_delete BEFORE DELETE ON "tasks" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER tasks_no_truncate BEFORE TRUNCATE ON "tasks" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER case_roles_no_delete BEFORE DELETE ON "case_roles" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER case_roles_no_truncate BEFORE TRUNCATE ON "case_roles" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER case_role_assignments_no_delete BEFORE DELETE ON "case_role_assignments" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER case_role_assignments_no_truncate BEFORE TRUNCATE ON "case_role_assignments" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();
