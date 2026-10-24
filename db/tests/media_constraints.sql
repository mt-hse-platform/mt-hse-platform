-- Checks for migration 0006 (CI runs it after 0001-0006). Everything is rolled back at the end.
BEGIN;
INSERT INTO organizations (id, name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Org A'), ('00000000-0000-0000-0000-0000000000b2', 'Org B');
INSERT INTO users (id, firebase_uid, email, full_name) VALUES ('00000000-0000-0000-0000-0000000000d1', 'fb-media', 'media@example.com', 'User');
INSERT INTO templates (id, org_id, name, created_by) VALUES ('00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000000a1', '{"en":"T"}', '00000000-0000-0000-0000-0000000000d1');
INSERT INTO template_versions (id, org_id, template_id, version_no, status, content, fingerprint, published_at, published_by, created_by) VALUES
  ('00000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000007a1', 1, 'published', '{"pages":[]}', 'fp', now(), '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d1');
INSERT INTO inspections (id, org_id, template_id, template_version_id, started_by) VALUES
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000008a1', '00000000-0000-0000-0000-0000000000d1');

SET LOCAL ROLE app_user;
SET LOCAL app.org_id = '00000000-0000-0000-0000-0000000000a1';
SET LOCAL app.user_id = '00000000-0000-0000-0000-0000000000d1';

DO $$
DECLARE
  org_a constant uuid := '00000000-0000-0000-0000-0000000000a1';
  usr constant uuid := '00000000-0000-0000-0000-0000000000d1';
  insp constant uuid := '00000000-0000-0000-0000-00000000e001';
  m uuid; sha constant text := repeat('a', 64); n int;
BEGIN
  INSERT INTO media (org_id, owner_type, owner_id, question_id, kind, mime_type, size_bytes, sha256, storage_key, uploaded_by)
    VALUES (org_a, 'inspection', insp, 'q_photo', 'photo', 'image/jpeg', 1234, sha, 'k1', usr) RETURNING id INTO m;

  -- constraints
  BEGIN INSERT INTO media (org_id, owner_type, owner_id, kind, mime_type, size_bytes, sha256, storage_key, uploaded_by) VALUES (org_a, 'inspection', insp, 'photo', 'image/svg+xml', 10, sha, 'k', usr);
    RAISE EXCEPTION 'svg accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO media (org_id, owner_type, owner_id, kind, mime_type, size_bytes, sha256, storage_key, uploaded_by) VALUES (org_a, 'inspection', insp, 'video', 'image/jpeg', 10, sha, 'k', usr);
    RAISE EXCEPTION 'video kind accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO media (org_id, owner_type, owner_id, kind, mime_type, size_bytes, sha256, storage_key, uploaded_by) VALUES (org_a, 'inspection', insp, 'photo', 'image/jpeg', 0, sha, 'k', usr);
    RAISE EXCEPTION 'empty file accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO media (org_id, owner_type, owner_id, kind, mime_type, size_bytes, sha256, storage_key, uploaded_by) VALUES (org_a, 'inspection', insp, 'photo', 'image/jpeg', 10, 'xyz', 'k', usr);
    RAISE EXCEPTION 'bad hash accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO media (org_id, owner_type, owner_id, kind, mime_type, size_bytes, sha256, storage_key, lat, uploaded_by) VALUES (org_a, 'inspection', insp, 'photo', 'image/jpeg', 10, sha, 'k', 123, usr);
    RAISE EXCEPTION 'latitude 123 accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO media (org_id, owner_type, owner_id, question_id, kind, mime_type, size_bytes, sha256, storage_key, uploaded_by) VALUES (org_a, 'inspection', insp, 'bad id!', 'photo', 'image/jpeg', 10, sha, 'k', usr);
    RAISE EXCEPTION 'bad question id accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

  -- signatures: one per media file, append-only
  INSERT INTO media (org_id, owner_type, owner_id, kind, mime_type, size_bytes, sha256, storage_key, uploaded_by)
    VALUES (org_a, 'inspection', insp, 'signature', 'image/png', 500, sha, 'k2', usr) RETURNING id INTO m;
  INSERT INTO inspection_signatures (org_id, inspection_id, media_id, signer_name, signed_by) VALUES (org_a, insp, m, 'Mohamed Taher', usr);
  BEGIN INSERT INTO inspection_signatures (org_id, inspection_id, media_id, signer_name, signed_by) VALUES (org_a, insp, m, 'Again', usr);
    RAISE EXCEPTION 'media signed twice'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN UPDATE inspection_signatures SET signer_name = 'Forged';
    RAISE EXCEPTION 'signature updated'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM inspection_signatures;
    RAISE EXCEPTION 'signature deleted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN DELETE FROM media;
    RAISE EXCEPTION 'media hard-deleted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE media SET deleted_at = now() WHERE id = m;  -- soft delete is allowed

  -- another organization cannot be written to
  BEGIN INSERT INTO media (org_id, owner_type, owner_id, kind, mime_type, size_bytes, sha256, storage_key, uploaded_by)
    VALUES ('00000000-0000-0000-0000-0000000000b2', 'inspection', insp, 'photo', 'image/jpeg', 10, sha, 'k', usr);
    RAISE EXCEPTION 'cross-org media accepted'; EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;
  SELECT count(*) INTO n FROM media; ASSERT n = 2, format('expected 2 media rows, got %s', n);
END $$;

ROLLBACK;
SELECT 'media constraints: all checks passed' AS result;
