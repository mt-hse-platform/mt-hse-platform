-- RLS isolation test. Run against a database that already has migration 0001 applied:
--   docker compose -f docker-compose.dev.yml exec -T postgres psql -U postgres -d mthse -v ON_ERROR_STOP=1 < db/tests/rls_isolation.sql
-- STATUS: written but not yet executed (no PostgreSQL in the authoring sandbox).
-- Everything is rolled back at the end. Any failed ASSERT aborts the script with an error.

BEGIN;

-- Fixture (as owner, which bypasses RLS)
INSERT INTO organizations (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Org A'),
  ('00000000-0000-0000-0000-0000000000b2', 'Org B');
INSERT INTO sites (org_id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Site of A'),
  ('00000000-0000-0000-0000-0000000000b2', 'Site of B');
INSERT INTO roles (id, org_id, name) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'Role A'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b2', 'Role B');
INSERT INTO users (id, firebase_uid, email, full_name) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'fb-a', 'a@example.com', 'User A'),
  ('00000000-0000-0000-0000-0000000000d2', 'fb-b', 'b@example.com', 'User B');
INSERT INTO memberships (org_id, user_id, role_id) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c2');

-- Switch to the application role and impersonate a user of Org A
SET LOCAL ROLE app_user;
SET LOCAL app.org_id  = '00000000-0000-0000-0000-0000000000a1';
SET LOCAL app.user_id = '00000000-0000-0000-0000-0000000000d1';

DO $$
DECLARE n int;
BEGIN
  -- 1. sees only own org rows
  SELECT count(*) INTO n FROM sites;
  ASSERT n = 1, format('expected 1 site visible, got %s', n);
  SELECT count(*) INTO n FROM sites WHERE name = 'Site of B';
  ASSERT n = 0, 'Org B site leaked';
  SELECT count(*) INTO n FROM organizations;
  ASSERT n = 1, 'organizations leaked';
  SELECT count(*) INTO n FROM users;
  ASSERT n = 1, format('expected only users of own org, got %s', n);

  -- 2. cannot insert into another org
  BEGIN
    INSERT INTO sites (org_id, name) VALUES ('00000000-0000-0000-0000-0000000000b2', 'Injected');
    RAISE EXCEPTION 'cross-org INSERT was allowed';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;  -- RLS violation = expected
  END;

  -- 3. cannot move own row to another org
  BEGIN
    UPDATE sites SET org_id = '00000000-0000-0000-0000-0000000000b2';
    RAISE EXCEPTION 'cross-org UPDATE was allowed';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;

  -- 4. audit log is append-only
  INSERT INTO audit_logs (org_id, entity_type, entity_id, action)
    VALUES ('00000000-0000-0000-0000-0000000000a1', 'site', 'x', 'created');
  BEGIN
    UPDATE audit_logs SET action = 'tampered';
    RAISE EXCEPTION 'audit UPDATE was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM audit_logs;
    RAISE EXCEPTION 'audit DELETE was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- 5. no org context => sees nothing
  RESET app.org_id;
  SELECT count(*) INTO n FROM sites;
  ASSERT n = 0, 'rows visible without org context';
END $$;

ROLLBACK;
SELECT 'RLS isolation: all checks passed' AS result;
