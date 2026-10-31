-- The Case Audit Log is append-only, and Cases are never deleted (ADR 0003). REVOKE covers ordinary
-- roles; the triggers also stop the table owner and superusers, who are not bound by privileges.
REVOKE UPDATE, DELETE, TRUNCATE ON "case_audit_log" FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION case_audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'case_audit_log is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER case_audit_log_no_update_delete BEFORE UPDATE OR DELETE ON "case_audit_log"
  FOR EACH ROW EXECUTE FUNCTION case_audit_log_append_only();--> statement-breakpoint
CREATE TRIGGER case_audit_log_no_truncate BEFORE TRUNCATE ON "case_audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION case_audit_log_append_only();--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "cases" FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION cases_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cases cannot be deleted: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER cases_no_delete BEFORE DELETE ON "cases"
  FOR EACH ROW EXECUTE FUNCTION cases_no_delete();--> statement-breakpoint
CREATE TRIGGER cases_no_truncate BEFORE TRUNCATE ON "cases"
  FOR EACH STATEMENT EXECUTE FUNCTION cases_no_delete();
