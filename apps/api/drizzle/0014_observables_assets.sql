CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"match_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "assets_type" CHECK ("assets"."type" IN ('host', 'account'))
);
--> statement-breakpoint
CREATE TABLE "case_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"linked_by_id" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"unlinked_by_id" text,
	"unlinked_at" timestamp with time zone,
	CONSTRAINT "case_assets_unlinked" CHECK (("case_assets"."unlinked_at" IS NULL) = ("case_assets"."unlinked_by_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "case_observables" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"observable_id" text NOT NULL,
	"linked_by_id" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"unlinked_by_id" text,
	"unlinked_at" timestamp with time zone,
	CONSTRAINT "case_observables_unlinked" CHECK (("case_observables"."unlinked_at" IS NULL) = ("case_observables"."unlinked_by_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "observables" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"match_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "observables_type" CHECK ("observables"."type" IN ('ip', 'domain', 'url', 'email', 'md5', 'sha1', 'sha256'))
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_assets" ADD CONSTRAINT "case_assets_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_assets" ADD CONSTRAINT "case_assets_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_assets" ADD CONSTRAINT "case_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_assets" ADD CONSTRAINT "case_assets_linked_by_id_user_id_fk" FOREIGN KEY ("linked_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_assets" ADD CONSTRAINT "case_assets_unlinked_by_id_user_id_fk" FOREIGN KEY ("unlinked_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_observables" ADD CONSTRAINT "case_observables_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_observables" ADD CONSTRAINT "case_observables_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_observables" ADD CONSTRAINT "case_observables_observable_id_observables_id_fk" FOREIGN KEY ("observable_id") REFERENCES "public"."observables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_observables" ADD CONSTRAINT "case_observables_linked_by_id_user_id_fk" FOREIGN KEY ("linked_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_observables" ADD CONSTRAINT "case_observables_unlinked_by_id_user_id_fk" FOREIGN KEY ("unlinked_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observables" ADD CONSTRAINT "observables_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_org_key_idx" ON "assets" USING btree ("organization_id","type","match_key");--> statement-breakpoint
CREATE UNIQUE INDEX "case_assets_active_idx" ON "case_assets" USING btree ("case_id","asset_id") WHERE "case_assets"."unlinked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "case_assets_item_idx" ON "case_assets" USING btree ("asset_id","case_id") WHERE "case_assets"."unlinked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "case_observables_active_idx" ON "case_observables" USING btree ("case_id","observable_id") WHERE "case_observables"."unlinked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "case_observables_item_idx" ON "case_observables" USING btree ("observable_id","case_id") WHERE "case_observables"."unlinked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "observables_org_key_idx" ON "observables" USING btree ("organization_id","type","match_key");--> statement-breakpoint
-- Observables and Assets are never altered or deleted, and their links to Cases are ended rather than
-- deleted (ADR 0003). REVOKE covers ordinary roles; the triggers also stop the table owner.
REVOKE UPDATE, DELETE, TRUNCATE ON "observables", "assets" FROM PUBLIC;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "case_observables", "case_assets" FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION held_once_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be altered or deleted: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER observables_immutable BEFORE UPDATE OR DELETE ON "observables" FOR EACH ROW EXECUTE FUNCTION held_once_immutable();--> statement-breakpoint
CREATE TRIGGER observables_no_truncate BEFORE TRUNCATE ON "observables" FOR EACH STATEMENT EXECUTE FUNCTION held_once_immutable();--> statement-breakpoint
CREATE TRIGGER assets_immutable BEFORE UPDATE OR DELETE ON "assets" FOR EACH ROW EXECUTE FUNCTION held_once_immutable();--> statement-breakpoint
CREATE TRIGGER assets_no_truncate BEFORE TRUNCATE ON "assets" FOR EACH STATEMENT EXECUTE FUNCTION held_once_immutable();--> statement-breakpoint
CREATE TRIGGER case_observables_no_delete BEFORE DELETE ON "case_observables" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER case_observables_no_truncate BEFORE TRUNCATE ON "case_observables" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER case_assets_no_delete BEFORE DELETE ON "case_assets" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER case_assets_no_truncate BEFORE TRUNCATE ON "case_assets" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();
