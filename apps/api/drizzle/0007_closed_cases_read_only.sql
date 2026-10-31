-- A Closed Case is read-only: its row may change only by being reopened (Status moves off Closed).
-- The application refuses these changes first; this stops anything that goes around it.
CREATE FUNCTION cases_closed_read_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status = 'closed' THEN
    RAISE EXCEPTION 'Case % is Closed and read-only', OLD.number USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER cases_closed_read_only BEFORE UPDATE ON "cases"
  FOR EACH ROW EXECUTE FUNCTION cases_closed_read_only();
