CREATE TABLE "ip_lookups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"ip" text NOT NULL,
	"details" jsonb,
	"bogon" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone,
	"checked_at" timestamp with time zone NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "ip_lookups" ADD CONSTRAINT "ip_lookups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_lookups" ADD CONSTRAINT "ip_lookups_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ip_lookups_ip_idx" ON "ip_lookups" USING btree ("integration_id","ip");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_one_ipinfo_idx" ON "integrations" USING btree ("organization_id") WHERE "integrations"."provider" = 'ipinfo';