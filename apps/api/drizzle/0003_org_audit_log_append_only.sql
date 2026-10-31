-- The Organization Audit Log is append-only. REVOKE covers ordinary roles; the trigger also
-- stops the table owner and superusers, who are not bound by privileges.
REVOKE UPDATE, DELETE, TRUNCATE ON "org_audit_log" FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION org_audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'org_audit_log is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER org_audit_log_no_update_delete BEFORE UPDATE OR DELETE ON "org_audit_log"
  FOR EACH ROW EXECUTE FUNCTION org_audit_log_append_only();--> statement-breakpoint
CREATE TRIGGER org_audit_log_no_truncate BEFORE TRUNCATE ON "org_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION org_audit_log_append_only();--> statement-breakpoint
-- Exactly one Owner per Organization: at most one here, at least one kept by the API.
CREATE UNIQUE INDEX "member_one_owner_per_org" ON "member" ("organization_id") WHERE "role" = 'owner';
