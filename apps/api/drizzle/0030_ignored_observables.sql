CREATE TABLE "ignored_observables" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"observable_id" text,
	"asset_id" text,
	"ignored_by_id" text NOT NULL,
	"ignored_at" timestamp with time zone NOT NULL,
	"ended_by_id" text,
	"ended_at" timestamp with time zone,
	CONSTRAINT "ignored_observables_one_item" CHECK (("ignored_observables"."observable_id" IS NULL) <> ("ignored_observables"."asset_id" IS NULL)),
	CONSTRAINT "ignored_observables_ended" CHECK (("ignored_observables"."ended_at" IS NULL) = ("ignored_observables"."ended_by_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "ignored_observables" ADD CONSTRAINT "ignored_observables_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ignored_observables" ADD CONSTRAINT "ignored_observables_observable_id_observables_id_fk" FOREIGN KEY ("observable_id") REFERENCES "public"."observables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ignored_observables" ADD CONSTRAINT "ignored_observables_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ignored_observables" ADD CONSTRAINT "ignored_observables_ignored_by_id_user_id_fk" FOREIGN KEY ("ignored_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ignored_observables" ADD CONSTRAINT "ignored_observables_ended_by_id_user_id_fk" FOREIGN KEY ("ended_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ignored_observables_observable_active_idx" ON "ignored_observables" USING btree ("observable_id") WHERE "ignored_observables"."ended_at" IS NULL AND "ignored_observables"."observable_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ignored_observables_asset_active_idx" ON "ignored_observables" USING btree ("asset_id") WHERE "ignored_observables"."ended_at" IS NULL AND "ignored_observables"."asset_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ignored_observables_org_idx" ON "ignored_observables" USING btree ("organization_id","seq") WHERE "ignored_observables"."ended_at" IS NULL;