CREATE TABLE "mapbox_tokens" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"updated_by_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mapbox_tokens" ADD CONSTRAINT "mapbox_tokens_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapbox_tokens" ADD CONSTRAINT "mapbox_tokens_updated_by_id_user_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;