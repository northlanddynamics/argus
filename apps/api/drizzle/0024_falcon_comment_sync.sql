CREATE TABLE "alert_falcon_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"alert_id" text NOT NULL,
	"falcon_comment_id" text NOT NULL,
	"author" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discussion_messages" ALTER COLUMN "author_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "falcon_comments_due" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "falcon_comments_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "falcon_comments_error" text;--> statement-breakpoint
ALTER TABLE "discussion_messages" ADD COLUMN "alert_id" text;--> statement-breakpoint
ALTER TABLE "discussion_messages" ADD COLUMN "falcon_comment_id" text;--> statement-breakpoint
ALTER TABLE "discussion_messages" ADD COLUMN "falcon_author" text;--> statement-breakpoint
ALTER TABLE "alert_falcon_comments" ADD CONSTRAINT "alert_falcon_comments_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_falcon_comments" ADD CONSTRAINT "alert_falcon_comments_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_falcon_comments_alert_comment_idx" ON "alert_falcon_comments" USING btree ("alert_id","falcon_comment_id");--> statement-breakpoint
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_falcon_comments_due_idx" ON "alerts" USING btree ("id") WHERE "alerts"."falcon_comments_due";--> statement-breakpoint
CREATE UNIQUE INDEX "discussion_messages_falcon_comment_idx" ON "discussion_messages" USING btree ("case_id","alert_id","falcon_comment_id") WHERE "discussion_messages"."falcon_comment_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_author" CHECK (("discussion_messages"."author_id" IS NULL) = ("discussion_messages"."falcon_comment_id" IS NOT NULL) AND ("discussion_messages"."falcon_comment_id" IS NULL) = ("discussion_messages"."alert_id" IS NULL));