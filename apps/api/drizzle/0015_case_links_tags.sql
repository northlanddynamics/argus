CREATE TABLE "case_links" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"source_case_id" text NOT NULL,
	"target_case_id" text NOT NULL,
	"type" text NOT NULL,
	"linked_by_id" text NOT NULL,
	"linked_at" timestamp with time zone NOT NULL,
	"unlinked_by_id" text,
	"unlinked_at" timestamp with time zone,
	CONSTRAINT "case_links_not_self" CHECK ("case_links"."source_case_id" <> "case_links"."target_case_id"),
	CONSTRAINT "case_links_type" CHECK ("case_links"."type" IN ('related', 'duplicate_of', 'parent_of')),
	CONSTRAINT "case_links_unlinked" CHECK (("case_links"."unlinked_at" IS NULL) = ("case_links"."unlinked_by_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "case_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"tag" text NOT NULL,
	"added_by_id" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"removed_by_id" text,
	"removed_at" timestamp with time zone,
	CONSTRAINT "case_tags_removed" CHECK (("case_tags"."removed_at" IS NULL) = ("case_tags"."removed_by_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "case_links" ADD CONSTRAINT "case_links_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_links" ADD CONSTRAINT "case_links_source_case_id_cases_id_fk" FOREIGN KEY ("source_case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_links" ADD CONSTRAINT "case_links_target_case_id_cases_id_fk" FOREIGN KEY ("target_case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_links" ADD CONSTRAINT "case_links_linked_by_id_user_id_fk" FOREIGN KEY ("linked_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_links" ADD CONSTRAINT "case_links_unlinked_by_id_user_id_fk" FOREIGN KEY ("unlinked_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_tags" ADD CONSTRAINT "case_tags_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_tags" ADD CONSTRAINT "case_tags_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_tags" ADD CONSTRAINT "case_tags_added_by_id_user_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_tags" ADD CONSTRAINT "case_tags_removed_by_id_user_id_fk" FOREIGN KEY ("removed_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "case_links_active_pair_idx" ON "case_links" USING btree (least("source_case_id", "target_case_id"),greatest("source_case_id", "target_case_id")) WHERE "case_links"."unlinked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "case_links_source_idx" ON "case_links" USING btree ("source_case_id") WHERE "case_links"."unlinked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "case_links_target_idx" ON "case_links" USING btree ("target_case_id") WHERE "case_links"."unlinked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "case_tags_active_idx" ON "case_tags" USING btree ("case_id","tag") WHERE "case_tags"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "case_tags_org_tag_idx" ON "case_tags" USING btree ("organization_id","tag") WHERE "case_tags"."removed_at" IS NULL;--> statement-breakpoint
-- Case Links and Tags are ended rather than deleted (ADR 0003). REVOKE covers ordinary roles; the
-- triggers also stop the table owner.
REVOKE DELETE, TRUNCATE ON "case_links", "case_tags" FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER case_links_no_delete BEFORE DELETE ON "case_links" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER case_links_no_truncate BEFORE TRUNCATE ON "case_links" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER case_tags_no_delete BEFORE DELETE ON "case_tags" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER case_tags_no_truncate BEFORE TRUNCATE ON "case_tags" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();
