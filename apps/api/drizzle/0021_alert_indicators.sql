CREATE TABLE "alert_assets" (
	"organization_id" text NOT NULL,
	"alert_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"seq" bigserial NOT NULL,
	CONSTRAINT "alert_assets_alert_id_asset_id_pk" PRIMARY KEY("alert_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "alert_observables" (
	"organization_id" text NOT NULL,
	"alert_id" text NOT NULL,
	"observable_id" text NOT NULL,
	"seq" bigserial NOT NULL,
	CONSTRAINT "alert_observables_alert_id_observable_id_pk" PRIMARY KEY("alert_id","observable_id")
);
--> statement-breakpoint
ALTER TABLE "case_assets" ADD COLUMN "alert_id" text;--> statement-breakpoint
ALTER TABLE "case_observables" ADD COLUMN "alert_id" text;--> statement-breakpoint
ALTER TABLE "alert_assets" ADD CONSTRAINT "alert_assets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_assets" ADD CONSTRAINT "alert_assets_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_assets" ADD CONSTRAINT "alert_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_observables" ADD CONSTRAINT "alert_observables_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_observables" ADD CONSTRAINT "alert_observables_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_observables" ADD CONSTRAINT "alert_observables_observable_id_observables_id_fk" FOREIGN KEY ("observable_id") REFERENCES "public"."observables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_assets_item_idx" ON "alert_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "alert_observables_item_idx" ON "alert_observables" USING btree ("observable_id");--> statement-breakpoint
ALTER TABLE "case_assets" ADD CONSTRAINT "case_assets_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_observables" ADD CONSTRAINT "case_observables_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- What an Alert names is only ever added to (ADR 0003).
REVOKE UPDATE, DELETE, TRUNCATE ON "alert_observables", "alert_assets" FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER alert_observables_immutable BEFORE UPDATE OR DELETE ON "alert_observables" FOR EACH ROW EXECUTE FUNCTION held_once_immutable();--> statement-breakpoint
CREATE TRIGGER alert_observables_no_truncate BEFORE TRUNCATE ON "alert_observables" FOR EACH STATEMENT EXECUTE FUNCTION held_once_immutable();--> statement-breakpoint
CREATE TRIGGER alert_assets_immutable BEFORE UPDATE OR DELETE ON "alert_assets" FOR EACH ROW EXECUTE FUNCTION held_once_immutable();--> statement-breakpoint
CREATE TRIGGER alert_assets_no_truncate BEFORE TRUNCATE ON "alert_assets" FOR EACH STATEMENT EXECUTE FUNCTION held_once_immutable();
