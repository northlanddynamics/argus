ALTER TABLE "response_actions" ADD COLUMN "origin" text DEFAULT 'created' NOT NULL;--> statement-breakpoint
ALTER TABLE "response_actions" ADD COLUMN "present_from_id" text;--> statement-breakpoint
ALTER TABLE "response_actions" ADD COLUMN "dismissed_by_id" text;--> statement-breakpoint
ALTER TABLE "response_actions" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_present_from_id_response_actions_id_fk" FOREIGN KEY ("present_from_id") REFERENCES "public"."response_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_dismissed_by_id_user_id_fk" FOREIGN KEY ("dismissed_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "response_actions_present_from_idx" ON "response_actions" USING btree ("present_from_id") WHERE "response_actions"."present_from_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "response_actions_one_created_idx" ON "response_actions" USING btree ("integration_id","kind","target_type","target_value") WHERE "response_actions"."origin" = 'created' AND "response_actions"."state" IN ('pending', 'active');--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_present_from" CHECK (("response_actions"."origin" = 'already_present') = ("response_actions"."present_from_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_dismissed" CHECK (("response_actions"."dismissed_at" IS NULL) = ("response_actions"."dismissed_by_id" IS NULL));