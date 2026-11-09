ALTER TABLE "integrations" ADD COLUMN "destination_list" jsonb;--> statement-breakpoint
ALTER TABLE "response_actions" ADD COLUMN "destination_list" jsonb;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_destination_list" CHECK ("integrations"."provider" = 'umbrella' OR "integrations"."destination_list" IS NULL);--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_destination_list" CHECK (("response_actions"."kind" = 'umbrella_destination') = ("response_actions"."destination_list" IS NOT NULL));