CREATE TABLE "discussion_mentions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"mentioned_by_id" text NOT NULL,
	"mentioned_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discussion_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"case_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"retracted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "discussion_mentions" ADD CONSTRAINT "discussion_mentions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_mentions" ADD CONSTRAINT "discussion_mentions_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_mentions" ADD CONSTRAINT "discussion_mentions_message_id_discussion_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."discussion_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_mentions" ADD CONSTRAINT "discussion_mentions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_mentions" ADD CONSTRAINT "discussion_mentions_mentioned_by_id_user_id_fk" FOREIGN KEY ("mentioned_by_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discussion_mentions_message_user_idx" ON "discussion_mentions" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE INDEX "discussion_mentions_user_idx" ON "discussion_mentions" USING btree ("user_id","mentioned_at");--> statement-breakpoint
CREATE INDEX "discussion_messages_case_idx" ON "discussion_messages" USING btree ("case_id","seq");--> statement-breakpoint
-- Discussion messages are never deleted (ADR 0003): they are edited or retracted, with the earlier
-- text in the Case Audit Log. Mentions are append-only. REVOKE covers ordinary roles; the triggers
-- also stop the owner.
REVOKE DELETE, TRUNCATE ON "discussion_messages" FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER discussion_messages_no_delete BEFORE DELETE ON "discussion_messages" FOR EACH ROW EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
CREATE TRIGGER discussion_messages_no_truncate BEFORE TRUNCATE ON "discussion_messages" FOR EACH STATEMENT EXECUTE FUNCTION no_hard_delete();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "discussion_mentions" FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER discussion_mentions_no_update_delete BEFORE UPDATE OR DELETE ON "discussion_mentions" FOR EACH ROW EXECUTE FUNCTION append_only();--> statement-breakpoint
CREATE TRIGGER discussion_mentions_no_truncate BEFORE TRUNCATE ON "discussion_mentions" FOR EACH STATEMENT EXECUTE FUNCTION append_only();
