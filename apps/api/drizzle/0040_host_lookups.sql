CREATE TABLE "falcon_host_lookups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"due" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "falcon_host_lookups" ADD CONSTRAINT "falcon_host_lookups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "falcon_host_lookups" ADD CONSTRAINT "falcon_host_lookups_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "falcon_host_lookups" ADD CONSTRAINT "falcon_host_lookups_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "falcon_host_lookups_host_idx" ON "falcon_host_lookups" USING btree ("asset_id","integration_id");--> statement-breakpoint
CREATE INDEX "falcon_host_lookups_due_idx" ON "falcon_host_lookups" USING btree ("due") WHERE "falcon_host_lookups"."due";