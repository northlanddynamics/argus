ALTER TABLE "alerts" ADD COLUMN "falcon_status" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "falcon_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "falcon_assignee" text;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "falcon_assignee_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "falcon_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "falcon_tags_at" timestamp with time zone;