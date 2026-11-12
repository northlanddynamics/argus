CREATE TABLE "falcon_ip_lookups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"ip" text NOT NULL,
	"device_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone,
	"checked_at" timestamp with time zone NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "falcon_ip_lookups" ADD CONSTRAINT "falcon_ip_lookups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "falcon_ip_lookups" ADD CONSTRAINT "falcon_ip_lookups_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "falcon_ip_lookups_ip_idx" ON "falcon_ip_lookups" USING btree ("integration_id","ip");