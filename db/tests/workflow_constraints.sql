-- Constraint + RLS checks for migration 0002. Run after 0001 and 0002 are applied (CI does this).
-- Everything is rolled back at the end. A failed ASSERT/unexpected success aborts with an error.
BEGIN;

INSERT INTO organizations (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Org A'),
  ('00000000-0000-0000-0000-0000000000b2', 'Org B');
INSERT INTO users (id, firebase_uid, email, full_name) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'fb-wf-a', 'wfa@example.com', 'User A');
INSERT INTO sites (id, org_id, name) VALUES
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000000a1', 'Site A'),
  ('00000000-0000-0000-0000-0000000005b2', '00000000-0000-0000-0000-0000000000b2', 'Site B');

SET LOCAL ROLE app_user;
SET LOCAL app.org_id  = '00000000-0000-0000-0000-0000000000a1';
SET LOCAL app.user_id = '00000000-0000-0000-0000-0000000000d1';

DO $$
DECLARE
  n int;
  org_a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  usr   constant uuid := '00000000-0000-0000-0000-0000000000d1';
  issue_id uuid;
BEGIN
  -- valid issue and action
  INSERT INTO issues (org_id, title, type, priority, reporter_id, site_id)
    VALUES (org_a, 'Leaking hose', 'hazard', 'high', usr, '00000000-0000-0000-0000-0000000005a1') RETURNING id INTO issue_id;
  INSERT INTO actions (org_id, title, type, priority, owner_id, issue_id)
    VALUES (org_a, 'Replace hose', 'corrective', 'high', usr, issue_id);

  -- invalid enum values are rejected
  BEGIN
    INSERT INTO issues (org_id, title, type, priority, reporter_id) VALUES (org_a, 'Bad type', 'nonsense', 'high', usr);
    RAISE EXCEPTION 'invalid issue type accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO issues (org_id, title, type, priority, status, reporter_id) VALUES (org_a, 'Bad status', 'hazard', 'high', 'weird', usr);
    RAISE EXCEPTION 'invalid issue status accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- assigned issue must have an assignee
  BEGIN
    INSERT INTO issues (org_id, title, type, priority, status, reporter_id) VALUES (org_a, 'No assignee', 'hazard', 'high', 'assigned', usr);
    RAISE EXCEPTION 'assigned issue without assignee accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- completed_at must match status
  BEGIN
    INSERT INTO actions (org_id, title, type, priority, status, owner_id) VALUES (org_a, 'Done w/o date', 'corrective', 'low', 'completed', usr);
    RAISE EXCEPTION 'completed action without completed_at accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- cross-organization site reference is rejected (composite FK)
  BEGIN
    INSERT INTO issues (org_id, title, type, priority, reporter_id, site_id)
      VALUES (org_a, 'Foreign site', 'hazard', 'low', usr, '00000000-0000-0000-0000-0000000005b2');
    RAISE EXCEPTION 'issue referencing another org site accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;

  -- RLS: cannot insert into another org
  BEGIN
    INSERT INTO issues (org_id, title, type, priority, reporter_id)
      VALUES ('00000000-0000-0000-0000-0000000000b2', 'Injected', 'hazard', 'low', usr);
    RAISE EXCEPTION 'cross-org insert accepted';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;

  -- timeline is append-only
  INSERT INTO timeline_events (org_id, entity_type, entity_id, event, actor_user_id)
    VALUES (org_a, 'issue', issue_id, 'created', usr);
  BEGIN
    UPDATE timeline_events SET event = 'tampered';
    RAISE EXCEPTION 'timeline UPDATE allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM actions;
    RAISE EXCEPTION 'actions DELETE allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  SELECT count(*) INTO n FROM issues;
  ASSERT n = 1, format('expected 1 issue, got %s', n);
END $$;

ROLLBACK;
SELECT 'workflow constraints: all checks passed' AS result;
