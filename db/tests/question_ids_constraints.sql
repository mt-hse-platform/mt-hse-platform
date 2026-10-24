-- Checks for migration 0008 (CI runs it after 0001-0008). Everything is rolled back at the end.
BEGIN;
INSERT INTO organizations (id, name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Org A');
INSERT INTO users (id, firebase_uid, email, full_name) VALUES ('00000000-0000-0000-0000-0000000000d1', 'fb-qid', 'qid@example.com', 'User');

SET LOCAL ROLE app_user;
SET LOCAL app.org_id = '00000000-0000-0000-0000-0000000000a1';
SET LOCAL app.user_id = '00000000-0000-0000-0000-0000000000d1';

DO $$
DECLARE
  org constant uuid := '00000000-0000-0000-0000-0000000000a1';
  usr constant uuid := '00000000-0000-0000-0000-0000000000d1';
  i uuid; a uuid; got text;
BEGIN
  -- the case that used to fail: a template question id such as q_helmet
  INSERT INTO issues (org_id, title, type, priority, reporter_id, question_id) VALUES (org, 'From a flag', 'hazard', 'high', usr, 'q_helmet') RETURNING id INTO i;
  SELECT question_id INTO got FROM issues WHERE id = i;
  IF got IS DISTINCT FROM 'q_helmet' THEN RAISE EXCEPTION 'issue question id not kept: %', got; END IF;
  INSERT INTO actions (org_id, title, type, priority, owner_id, question_id) VALUES (org, 'Fix it', 'corrective', 'high', usr, 'q_helmet') RETURNING id INTO a;
  SELECT question_id INTO got FROM actions WHERE id = a;
  IF got IS DISTINCT FROM 'q_helmet' THEN RAISE EXCEPTION 'action question id not kept: %', got; END IF;

  -- still optional
  INSERT INTO issues (org_id, title, type, priority, reporter_id) VALUES (org, 'No source', 'hazard', 'low', usr);
  INSERT INTO actions (org_id, title, type, priority, owner_id) VALUES (org, 'No source', 'other', 'low', usr);

  -- same format rule as inspection_responses
  BEGIN INSERT INTO issues (org_id, title, type, priority, reporter_id, question_id) VALUES (org, 'Bad id', 'hazard', 'low', usr, 'bad id!');
    RAISE EXCEPTION 'issue accepted a malformed question id'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO actions (org_id, title, type, priority, owner_id, question_id) VALUES (org, 'Bad id', 'other', 'low', usr, 'bad id!');
    RAISE EXCEPTION 'action accepted a malformed question id'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO actions (org_id, title, type, priority, owner_id, question_id) VALUES (org, 'Too long', 'other', 'low', usr, repeat('a', 65));
    RAISE EXCEPTION 'action accepted a 65-character question id'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;

ROLLBACK;
