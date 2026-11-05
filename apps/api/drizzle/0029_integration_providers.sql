ALTER TABLE "integrations" RENAME COLUMN "type" TO "provider";--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "response_actions" boolean DEFAULT false NOT NULL;
