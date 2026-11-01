ALTER TABLE "alerts" ADD COLUMN "internal" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "discussion_messages" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "timeline_entries" ADD COLUMN "internal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Evidence stays unalterable (ADR 0003), except for its Internal marking: who may see the file
-- changes, never the file or its record. Everything else still fails at the database.
GRANT UPDATE ("internal") ON "evidence" TO PUBLIC;--> statement-breakpoint
DROP TRIGGER evidence_no_update_delete ON "evidence";--> statement-breakpoint
CREATE FUNCTION evidence_only_internal_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'internal') = (to_jsonb(OLD) - 'internal') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Evidence cannot be altered or deleted: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER evidence_no_update_delete BEFORE UPDATE OR DELETE ON "evidence" FOR EACH ROW EXECUTE FUNCTION evidence_only_internal_changes();
