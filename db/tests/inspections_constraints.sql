-- Checks for migration 0004 (CI runs it after 0001-0004). Everything is rolled back at the end.
BEGIN;

INSERT INTO organizations (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Org A'),
  ('00000000-0000-0000-0000-0000000000b2', 'Org B');
INSERT INTO users (id, firebase_uid, email, full_name) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'fb-insp-a', 'inspa@example.com', 'User A');
-- fixture as owner: a template with one published and one draft version
INSERT INTO templates (id, org_id, name, created_by) VALUES
  ('00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000000a1', '{"en":"T"}', '00000000-0000-0000-0000-0000000000d1');
INSERT INTO template_versions (id, org_id, template_id, version_no, status, content, fingerprint, published_at, published_by, created_by) VALUES
  ('00000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000007a1', 1, 'published',
   '{"pages":[]}', 'fp-1', now(), '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1');
INSERT INTO template_versions (id, org_id, template_id, version_no, status, content, created_by) VALUES
  ('00000000-0000-0000-0000-0000000008a2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000007a1', 2, 'draft',
   '{"pages":[]}', '00000000-0000-0000-0000-0000000000d1');

SET LOCAL ROLE app_user;
SET LOCAL app.org_id  = '00000000-0000-0000-0000-0000000000a1';
SET LOCAL app.user_id = '00000000-0000-0000-0000-0000000000d1';

DO $$
DECLARE
  org_a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  usr   constant uuid := '00000000-0000-0000-0000-0000000000d1';
  tpl   constant uuid := '00000000-0000-0000-0000-0000000007a1';
  v_pub constant uuid := '00000000-0000-0000-0000-0000000008a1';
  v_dr  constant uuid := '00000000-0000-0000-0000-0000000008a2';
  insp uuid; n int;
BEGIN
  -- must start from a published version
  BEGIN
    INSERT INTO inspections (org_id, template_id, template_version_id, started_by) VALUES (org_a, tpl, v_dr, usr);
    RAISE EXCEPTION 'inspection from a draft version accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO inspections (org_id, template_id, template_version_id, started_by) VALUES (org_a, tpl, v_pub, usr) RETURNING id INTO insp;

  -- responses: insert, update, and a bad question id
  INSERT INTO inspection_responses (org_id, inspection_id, question_id, value, updated_by) VALUES (org_a, insp, 'q_helmet', '"yes"', usr);
  UPDATE inspection_responses SET value = '"no"', version = version + 1 WHERE inspection_id = insp AND question_id = 'q_helmet';
  BEGIN
    INSERT INTO inspection_responses (org_id, inspection_id, question_id, value, updated_by) VALUES (org_a, insp, 'bad id!', '"x"', usr);
    RAISE EXCEPTION 'invalid question id accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- status/date consistency
  BEGIN
    UPDATE inspections SET status = 'completed' WHERE id = insp;
    RAISE EXCEPTION 'completed without completed_at accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- flag (unique per question)
  UPDATE inspections SET status = 'completed', completed_at = now(), score_pct = 50, score_earned = 1, score_possible = 2 WHERE id = insp;
  -- (flags are created by the app at completion; here we check the constraint only)
  -- finished inspections are frozen
  BEGIN
    UPDATE inspections SET score_pct = 100 WHERE id = insp;
    RAISE EXCEPTION 'score of a completed inspection was changed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE inspections SET status = 'in_progress' WHERE id = insp;
    RAISE EXCEPTION 'completed inspection was reopened';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE inspection_responses SET value = '"yes"' WHERE inspection_id = insp AND question_id = 'q_helmet';
    RAISE EXCEPTION 'response of a completed inspection was changed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    INSERT INTO inspection_responses (org_id, inspection_id, question_id, value, updated_by) VALUES (org_a, insp, 'q_new', '"x"', usr);
    RAISE EXCEPTION 'new response added to a completed inspection';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;

  -- archiving is the only allowed change
  UPDATE inspections SET status = 'archived' WHERE id = insp;

  -- flags: unique per (inspection, question) and valid severity
  INSERT INTO inspection_flags (org_id, inspection_id, question_id, page_id, severity) VALUES (org_a, insp, 'q_helmet', 'p1', 'high');
  BEGIN
    INSERT INTO inspection_flags (org_id, inspection_id, question_id, page_id, severity) VALUES (org_a, insp, 'q_helmet', 'p1', 'low');
    RAISE EXCEPTION 'duplicate flag accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO inspection_flags (org_id, inspection_id, question_id, page_id, severity) VALUES (org_a, insp, 'q_other', 'p1', 'urgent');
    RAISE EXCEPTION 'invalid severity accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- cross-organization insert blocked by RLS
  BEGIN
    INSERT INTO inspections (org_id, template_id, template_version_id, started_by)
      VALUES ('00000000-0000-0000-0000-0000000000b2', tpl, v_pub, usr);
    RAISE EXCEPTION 'cross-org inspection accepted';
  EXCEPTION WHEN insufficient_privilege OR check_violation OR foreign_key_violation THEN NULL; END;

  -- no deletes anywhere
  BEGIN
    DELETE FROM inspections;
    RAISE EXCEPTION 'inspection DELETE allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  SELECT count(*) INTO n FROM inspections;
  ASSERT n = 1, format('expected 1 inspection, got %s', n);
END $$;

ROLLBACK;
SELECT 'inspection constraints: all checks passed' AS result;
