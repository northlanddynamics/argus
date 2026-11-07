CREATE TABLE "alert_falcon_devices" (
	"organization_id" text NOT NULL,
	"alert_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"device_id" text NOT NULL,
	CONSTRAINT "alert_falcon_devices_alert_id_asset_id_device_id_pk" PRIMARY KEY("alert_id","asset_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "alert_falcon_devices" ADD CONSTRAINT "alert_falcon_devices_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_falcon_devices" ADD CONSTRAINT "alert_falcon_devices_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_falcon_devices" ADD CONSTRAINT "alert_falcon_devices_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_falcon_devices_device_idx" ON "alert_falcon_devices" USING btree ("device_id");--> statement-breakpoint
-- Existing Alerts: the devices their detections name, on the hosts they name that hold them.
INSERT INTO "alert_falcon_devices" ("organization_id", "alert_id", "asset_id", "device_id")
SELECT DISTINCT a."organization_id", a."id", d."asset_id", d."device_id"
FROM "alerts" a
JOIN "alert_assets" aa ON aa."alert_id" = a."id"
JOIN "asset_falcon_devices" d ON d."asset_id" = aa."asset_id" AND d."integration_id" = a."integration_id"
WHERE d."device_id" IN (
  lower(a."payload"->>'AgentId'),
  lower(a."payload"->>'SourceEndpointSensorId'),
  lower(a."payload"->>'TargetEndpointSensorId')
)
ON CONFLICT DO NOTHING;
