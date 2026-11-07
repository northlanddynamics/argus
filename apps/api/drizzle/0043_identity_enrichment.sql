CREATE TABLE "asset_falcon_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "falcon_identity_lookups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"due" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "falcon_identity_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"due" boolean DEFAULT false NOT NULL,
	"identity" jsonb,
	"fetched_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "identity_enrichment_error" text;--> statement-breakpoint
ALTER TABLE "asset_falcon_identities" ADD CONSTRAINT "asset_falcon_identities_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_falcon_identities" ADD CONSTRAINT "asset_falcon_identities_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_falcon_identities" ADD CONSTRAINT "asset_falcon_identities_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "falcon_identity_lookups" ADD CONSTRAINT "falcon_identity_lookups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "falcon_identity_lookups" ADD CONSTRAINT "falcon_identity_lookups_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "falcon_identity_lookups" ADD CONSTRAINT "falcon_identity_lookups_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "falcon_identity_snapshots" ADD CONSTRAINT "falcon_identity_snapshots_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "falcon_identity_snapshots" ADD CONSTRAINT "falcon_identity_snapshots_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_falcon_identities_unique_idx" ON "asset_falcon_identities" USING btree ("asset_id","integration_id","entity_id");--> statement-breakpoint
CREATE INDEX "asset_falcon_identities_entity_idx" ON "asset_falcon_identities" USING btree ("integration_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "falcon_identity_lookups_account_idx" ON "falcon_identity_lookups" USING btree ("asset_id","integration_id");--> statement-breakpoint
CREATE INDEX "falcon_identity_lookups_due_idx" ON "falcon_identity_lookups" USING btree ("due") WHERE "falcon_identity_lookups"."due";--> statement-breakpoint
CREATE UNIQUE INDEX "falcon_identity_snapshots_entity_idx" ON "falcon_identity_snapshots" USING btree ("integration_id","entity_id");--> statement-breakpoint
CREATE INDEX "falcon_identity_snapshots_due_idx" ON "falcon_identity_snapshots" USING btree ("due") WHERE "falcon_identity_snapshots"."due";