CREATE TABLE "teams_channels" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"webhook_url" text NOT NULL,
	"url_hint" text NOT NULL,
	"updated_by_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"alert_count" integer,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"pending" boolean DEFAULT true NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "teams_channels" ADD CONSTRAINT "teams_channels_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_channels" ADD CONSTRAINT "teams_channels_updated_by_id_user_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_posts" ADD CONSTRAINT "teams_posts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_posts" ADD CONSTRAINT "teams_posts_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_posts" ADD CONSTRAINT "teams_posts_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teams_posts_due_idx" ON "teams_posts" USING btree ("next_attempt_at") WHERE "teams_posts"."pending";