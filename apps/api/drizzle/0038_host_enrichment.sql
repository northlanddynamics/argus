CREATE TABLE "falcon_host_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"device_id" text NOT NULL,
	"due" boolean DEFAULT false NOT NULL,
	"host" jsonb,
	"fetched_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "host_enrichment_error" text;--> statement-breakpoint
ALTER TABLE "falcon_host_snapshots" ADD CONSTRAINT "falcon_host_snapshots_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "falcon_host_snapshots" ADD CONSTRAINT "falcon_host_snapshots_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "falcon_host_snapshots_device_idx" ON "falcon_host_snapshots" USING btree ("integration_id","device_id");--> statement-breakpoint
CREATE INDEX "falcon_host_snapshots_due_idx" ON "falcon_host_snapshots" USING btree ("due") WHERE "falcon_host_snapshots"."due";