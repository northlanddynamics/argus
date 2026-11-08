CREATE TABLE "hash_lookups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"hash" text NOT NULL,
	"found" boolean NOT NULL,
	"report" jsonb,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hash_lookups_report" CHECK ("hash_lookups"."found" = ("hash_lookups"."report" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "virustotal_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"member_id" text NOT NULL,
	"key" text NOT NULL,
	"hint" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"error" text,
	"error_at" timestamp with time zone,
	CONSTRAINT "virustotal_keys_member_id_unique" UNIQUE("member_id")
);
--> statement-breakpoint
ALTER TABLE "hash_lookups" ADD CONSTRAINT "hash_lookups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virustotal_keys" ADD CONSTRAINT "virustotal_keys_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virustotal_keys" ADD CONSTRAINT "virustotal_keys_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hash_lookups_hash_idx" ON "hash_lookups" USING btree ("organization_id","hash");