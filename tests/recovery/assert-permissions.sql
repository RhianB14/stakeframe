SET ROLE stk_fixture_reader;
DO $$
BEGIN
  IF (SELECT count(*) FROM recovery_probe.entries) <> 2 THEN RAISE EXCEPTION 'ROW_COUNT_MISMATCH'; END IF;
  BEGIN
    INSERT INTO recovery_probe.entries (amount, occurred_at, payload) VALUES (1, now(), '{}');
    RAISE EXCEPTION 'READER_WRITE_WAS_ALLOWED';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
SET ROLE stk_fixture_owner;
DO $$
BEGIN
  BEGIN
    INSERT INTO recovery_probe.references VALUES (999);
    RAISE EXCEPTION 'FOREIGN_KEY_WAS_NOT_ENFORCED';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
CREATE TABLE recovery_probe.after_restore (id integer);
RESET ROLE;
DO $$
BEGIN
  IF NOT has_table_privilege('stk_fixture_reader', 'recovery_probe.after_restore', 'SELECT') THEN
    RAISE EXCEPTION 'DEFAULT_PRIVILEGE_WAS_NOT_RESTORED';
  END IF;
END $$;
