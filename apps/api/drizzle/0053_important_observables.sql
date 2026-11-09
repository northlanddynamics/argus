CREATE TABLE "important_observables" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"observable_id" text NOT NULL,
	"marked_by_id" text NOT NULL,
	"marked_at" timestamp with time zone NOT NULL,
	"ended_by_id" text,
	"ended_at" timestamp with time zone,
	CONSTRAINT "important_observables_ended" CHECK (("important_observables"."ended_at" IS NULL) = ("important_observables"."ended_by_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "important_observables" ADD CONSTRAINT "important_observables_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "important_observables" ADD CONSTRAINT "important_observables_observable_id_observables_id_fk" FOREIGN KEY ("observable_id") REFERENCES "public"."observables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "important_observables" ADD CONSTRAINT "important_observables_marked_by_id_user_id_fk" FOREIGN KEY ("marked_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "important_observables" ADD CONSTRAINT "important_observables_ended_by_id_user_id_fk" FOREIGN KEY ("ended_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "important_observables_active_idx" ON "important_observables" USING btree ("observable_id") WHERE "important_observables"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "important_observables_org_idx" ON "important_observables" USING btree ("organization_id","seq") WHERE "important_observables"."ended_at" IS NULL;