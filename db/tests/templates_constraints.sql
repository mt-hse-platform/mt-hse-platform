-- Constraint + immutability checks for migration 0003 (CI runs it after 0001-0003). Rolled back at the end.
BEGIN;

INSERT INTO organizations (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Org A'),
  ('00000000-0000-0000-0000-0000000000b2', 'Org B');
INSERT INTO users (id, firebase_uid, email, full_name) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'fb-tpl-a', 'tpla@example.com', 'User A');

SET LOCAL ROLE app_user;
SET LOCAL app.org_id  = '00000000-0000-0000-0000-0000000000a1';
SET LOCAL app.user_id = '00000000-0000-0000-0000-0000000000d1';

DO $$
DECLARE
  org_a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  usr   constant uuid := '00000000-0000-0000-0000-0000000000d1';
  tpl uuid; ver uuid; n int;
BEGIN
  INSERT INTO templates (org_id, name, created_by) VALUES (org_a, '{"en":"Batching plant"}', usr) RETURNING id INTO tpl;
  INSERT INTO template_versions (org_id, template_id, version_no, content, created_by)
    VALUES (org_a, tpl, 1, '{"pages":[]}', usr) RETURNING id INTO ver;

  -- only one draft per template
  BEGIN
    INSERT INTO template_versions (org_id, template_id, version_no, content, created_by) VALUES (org_a, tpl, 2, '{"pages":[]}', usr);
    RAISE EXCEPTION 'second draft accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- a published row needs fingerprint, date and publisher
  BEGIN
    UPDATE template_versions SET status = 'published' WHERE id = ver;
    RAISE EXCEPTION 'published without fingerprint accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- publish properly
  UPDATE template_versions SET status = 'published', fingerprint = 'abc-1', published_at = now(), published_by = usr WHERE id = ver;
  UPDATE templates SET status = 'published', published_version_id = ver WHERE id = tpl;

  -- published version is immutable
  BEGIN
    UPDATE template_versions SET content = '{"pages":[{"id":"hacked"}]}' WHERE id = ver;
    RAISE EXCEPTION 'published content was changed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE template_versions SET status = 'draft', fingerprint = NULL, published_at = NULL, published_by = NULL WHERE id = ver;
    RAISE EXCEPTION 'published version was reverted to draft';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    DELETE FROM template_versions WHERE id = ver;
    RAISE EXCEPTION 'published version was deleted';
  EXCEPTION WHEN insufficient_privilege OR SQLSTATE '55000' THEN NULL; END;

  -- a new draft after publishing is allowed
  INSERT INTO template_versions (org_id, template_id, version_no, content, created_by) VALUES (org_a, tpl, 2, '{"pages":[]}', usr);

  -- versions are unique per template
  BEGIN
    INSERT INTO template_versions (org_id, template_id, version_no, status, content, fingerprint, published_at, published_by, created_by)
      VALUES (org_a, tpl, 1, 'published', '{}', 'x', now(), usr, usr);
    RAISE EXCEPTION 'duplicate version number accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- cross-organization insert is blocked by RLS
  BEGIN
    INSERT INTO templates (org_id, name, created_by) VALUES ('00000000-0000-0000-0000-0000000000b2', '{"en":"x"}', usr);
    RAISE EXCEPTION 'cross-org template accepted';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;

  SELECT count(*) INTO n FROM templates;
  ASSERT n = 1, format('expected 1 template, got %s', n);
END $$;

ROLLBACK;
SELECT 'template constraints: all checks passed' AS result;
