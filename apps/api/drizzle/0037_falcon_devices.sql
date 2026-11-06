CREATE TABLE "asset_falcon_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"device_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_falcon_devices" ADD CONSTRAINT "asset_falcon_devices_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_falcon_devices" ADD CONSTRAINT "asset_falcon_devices_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_falcon_devices" ADD CONSTRAINT "asset_falcon_devices_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_falcon_devices_unique_idx" ON "asset_falcon_devices" USING btree ("asset_id","integration_id","device_id");--> statement-breakpoint
CREATE INDEX "asset_falcon_devices_device_idx" ON "asset_falcon_devices" USING btree ("integration_id","device_id");--> statement-breakpoint
-- Hand-written: a recorded device is never changed or removed (ADR 0003).
CREATE TRIGGER asset_falcon_devices_immutable BEFORE UPDATE OR DELETE ON "asset_falcon_devices" FOR EACH ROW EXECUTE FUNCTION held_once_immutable();--> statement-breakpoint
CREATE TRIGGER asset_falcon_devices_no_truncate BEFORE TRUNCATE ON "asset_falcon_devices" FOR EACH STATEMENT EXECUTE FUNCTION held_once_immutable();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "asset_falcon_devices" FROM PUBLIC;
