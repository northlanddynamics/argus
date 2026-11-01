CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"added_by_id" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	CONSTRAINT "evidence_sha256" CHECK ("evidence"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "evidence_size" CHECK ("evidence"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_added_by_id_user_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_case_idx" ON "evidence" USING btree ("case_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_storage_key_idx" ON "evidence" USING btree ("storage_key");--> statement-breakpoint
-- Evidence is never altered or deleted (ADR 0003): its row, fingerprint included, is final once added.
-- REVOKE covers ordinary roles; the triggers also stop the table owner and superusers.
REVOKE UPDATE, DELETE, TRUNCATE ON "evidence" FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Evidence cannot be altered or deleted: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER evidence_no_update_delete BEFORE UPDATE OR DELETE ON "evidence" FOR EACH ROW EXECUTE FUNCTION evidence_immutable();--> statement-breakpoint
CREATE TRIGGER evidence_no_truncate BEFORE TRUNCATE ON "evidence" FOR EACH STATEMENT EXECUTE FUNCTION evidence_immutable();
