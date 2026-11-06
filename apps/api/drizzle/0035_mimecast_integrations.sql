ALTER TABLE "integrations" ALTER COLUMN "cloud" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "health_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_cloud" CHECK (("integrations"."provider" = 'crowdstrike') = ("integrations"."cloud" IS NOT NULL));