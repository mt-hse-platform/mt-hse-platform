-- Checks for migration 0007 (CI runs it after 0001-0007). Everything is rolled back at the end.
BEGIN;
INSERT INTO organizations (id, name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Org A'), ('00000000-0000-0000-0000-0000000000b2', 'Org B');
INSERT INTO roles (id, org_id, key, name, is_system) VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'inspector', 'Inspector', true);
INSERT INTO users (id, firebase_uid, email, full_name) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'fb-n1', 'n1@example.com', 'Person One'),
  ('00000000-0000-0000-0000-0000000000d2', 'fb-n2', 'n2@example.com', 'Person Two'),
  ('00000000-0000-0000-0000-0000000000d3', 'fb-n3', 'n3@example.com', 'Left The Company');
INSERT INTO memberships (org_id, user_id, role_id, status) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'active'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1', 'active'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1', 'inactive');
INSERT INTO actions (id, org_id, title, type, priority, status, owner_id, assignee_id, due_date, completed_at) VALUES
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000000a1', 'Late action', 'corrective', 'high', 'todo', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2', '2026-10-01', NULL),
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000000a1', 'Not late yet', 'corrective', 'high', 'todo', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2', '2026-10-09', NULL),
  ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-0000000000a1', 'Done long ago', 'corrective', 'high', 'completed', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2', '2026-09-01', now()),
  ('00000000-0000-0000-0000-00000000a004', '00000000-0000-0000-0000-0000000000a1', 'Assignee left', 'corrective', 'high', 'todo', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d3', '2026-10-01', NULL),
  ('00000000-0000-0000-0000-00000000a005', '00000000-0000-0000-0000-0000000000a1', 'Nobody assigned', 'corrective', 'high', 'todo', '00000000-0000-0000-0000-0000000000d1', NULL, '2026-10-01', NULL);
INSERT INTO issues (id, org_id, title, type, priority, status, reporter_id, assignee_id, due_date) VALUES
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000a1', 'Late issue', 'hazard', 'high', 'in_progress', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2', '2026-10-02');

SET LOCAL ROLE app_user;
DO $$
DECLARE n int;
BEGIN
  -- the overdue sweep: only open, assigned, active-member, past-due items; once only
  n := generate_overdue_notifications('2026-10-03');
  ASSERT n = 2, format('expected 2 overdue notifications (1 action + 1 issue), got %s', n);
  ASSERT generate_overdue_notifications('2026-10-03') = 0, 'sweep is not idempotent';
  ASSERT generate_overdue_notifications('2026-10-04') = 0, 'overdue items are notified once, not every day';
END $$;

SET LOCAL app.org_id = '00000000-0000-0000-0000-0000000000a1';
SET LOCAL app.user_id = '00000000-0000-0000-0000-0000000000d2';
DO $$
DECLARE n int; u1 constant uuid := '00000000-0000-0000-0000-0000000000d1'; u2 constant uuid := '00000000-0000-0000-0000-0000000000d2';
        org_a constant uuid := '00000000-0000-0000-0000-0000000000a1'; mine uuid;
BEGIN
  SELECT count(*) INTO n FROM notifications; ASSERT n = 2, format('person two should see 2, sees %s', n);

  -- notifying a colleague is allowed, reading it back is not
  INSERT INTO notifications (org_id, user_id, type, entity_type, entity_id, actor_user_id, data)
    VALUES (org_a, u1, 'comment_added', 'action', '00000000-0000-0000-0000-00000000a001', u2, '{"entityTitle":"x"}');
  SELECT count(*) INTO n FROM notifications WHERE user_id = u1; ASSERT n = 0, 'a notification for someone else is visible';

  BEGIN INSERT INTO notifications (org_id, user_id, type, entity_type, entity_id) VALUES (org_a, u1, 'spam', 'action', '00000000-0000-0000-0000-00000000a001');
    RAISE EXCEPTION 'unknown type accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO notifications (org_id, user_id, type, entity_type, entity_id) VALUES ('00000000-0000-0000-0000-0000000000b2', u1, 'comment_added', 'action', '00000000-0000-0000-0000-00000000a001');
    RAISE EXCEPTION 'cross-org notification accepted'; EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;

  SELECT id INTO mine FROM notifications WHERE read_at IS NULL LIMIT 1;
  UPDATE notifications SET read_at = now() WHERE id = mine;
  SELECT count(*) INTO n FROM notifications WHERE read_at IS NULL; ASSERT n = 1, 'read_at did not change';
  BEGIN UPDATE notifications SET type = 'issue_assigned' WHERE id = mine; RAISE EXCEPTION 'type was updated'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE notifications SET user_id = u1 WHERE id = mine; RAISE EXCEPTION 'owner was changed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM notifications; RAISE EXCEPTION 'delete allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;

SET LOCAL app.user_id = '00000000-0000-0000-0000-0000000000d1';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM notifications; ASSERT n = 1, format('person one should see 1, sees %s', n);
  UPDATE notifications SET read_at = now() WHERE type <> 'comment_added';
  GET DIAGNOSTICS n = ROW_COUNT; ASSERT n = 0, 'person one marked person two''s notification as read';
END $$;

ROLLBACK;
SELECT 'notification constraints: all checks passed' AS result;
