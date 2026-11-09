DROP INDEX "integrations_org_name_idx";--> statement-breakpoint
DROP INDEX "integrations_one_ipinfo_idx";--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "deleted_by_id" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_deleted_by_id_user_id_fk" FOREIGN KEY ("deleted_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_org_name_idx" ON "integrations" USING btree ("organization_id",lower("name")) WHERE "integrations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_one_ipinfo_idx" ON "integrations" USING btree ("organization_id") WHERE "integrations"."provider" = 'ipinfo' AND "integrations"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_deleted" CHECK (("integrations"."deleted_at" IS NULL) = ("integrations"."deleted_by_id" IS NULL) AND ("integrations"."deleted_at" IS NULL OR "integrations"."paused"));