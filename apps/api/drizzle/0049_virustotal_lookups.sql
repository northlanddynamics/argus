CREATE TABLE "virustotal_lookups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"found" boolean NOT NULL,
	"report" jsonb,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "virustotal_lookups_report" CHECK ("virustotal_lookups"."found" = ("virustotal_lookups"."report" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "virustotal_lookups" ADD CONSTRAINT "virustotal_lookups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "virustotal_lookups_value_idx" ON "virustotal_lookups" USING btree ("organization_id","kind","value");