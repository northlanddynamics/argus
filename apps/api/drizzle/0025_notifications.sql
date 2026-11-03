CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text,
	"task_id" text,
	"message_id" text,
	"guest_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	"email_pending" boolean DEFAULT true NOT NULL,
	"email_attempts" integer DEFAULT 0 NOT NULL,
	"emailed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "overdue_notified_for" date;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_message_id_discussion_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."discussion_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_guest_id_user_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_id","seq");--> statement-breakpoint
CREATE INDEX "notifications_email_pending_idx" ON "notifications" USING btree ("seq") WHERE "notifications"."email_pending";--> statement-breakpoint
-- Notifications are never deleted (ADR 0003); they are marked read.
REVOKE DELETE, TRUNCATE ON "notifications" FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER notifications_no_delete BEFORE DELETE ON "notifications" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER notifications_no_truncate BEFORE TRUNCATE ON "notifications" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();
