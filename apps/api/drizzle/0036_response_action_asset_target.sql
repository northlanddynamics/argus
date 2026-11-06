DROP INDEX "response_actions_observable_idx";--> statement-breakpoint
ALTER TABLE "response_actions" ALTER COLUMN "observable_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "response_actions" ADD COLUMN "asset_id" text;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "response_actions_asset_idx" ON "response_actions" USING btree ("asset_id") WHERE "response_actions"."asset_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "response_actions_observable_idx" ON "response_actions" USING btree ("observable_id") WHERE "response_actions"."observable_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "response_actions" ADD CONSTRAINT "response_actions_one_target" CHECK (("response_actions"."observable_id" IS NULL) <> ("response_actions"."asset_id" IS NULL));