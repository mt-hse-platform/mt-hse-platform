-- Checks for migration 0005 (CI runs it after 0001-0005). Everything is rolled back at the end.
BEGIN;

INSERT INTO organizations (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Org A'),
  ('00000000-0000-0000-0000-0000000000b2', 'Org B');
INSERT INTO users (id, firebase_uid, email, full_name) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'fb-admin', 'admin@example.com', 'Admin'),
  ('00000000-0000-0000-0000-0000000000d9', 'fb-other', 'taken@example.com', 'Someone else');
INSERT INTO roles (id, org_id, key, name, is_system) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'inspector', 'Inspector', true);
INSERT INTO sites (id, org_id, name) VALUES
  ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000000a1', 'Site A'),
  ('00000000-0000-0000-0000-0000000005b2', '00000000-0000-0000-0000-0000000000b2', 'Site of B');
INSERT INTO invitations (id, org_id, email, full_name, role_id, site_ids, invited_by) VALUES
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1', 'new@example.com', 'New Person',
   '00000000-0000-0000-0000-0000000000c1', ARRAY['00000000-0000-0000-0000-0000000005a1','00000000-0000-0000-0000-0000000005b2']::uuid[],
   '00000000-0000-0000-0000-0000000000d1');
INSERT INTO invitations (id, org_id, email, full_name, role_id, invited_by, expires_at) VALUES
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000a1', 'expired@example.com', 'Expired',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', now() - interval '1 day');
INSERT INTO invitations (id, org_id, email, full_name, role_id, invited_by, status) VALUES
  ('00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000a1', 'revoked@example.com', 'Revoked',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', 'revoked');
INSERT INTO invitations (id, org_id, email, full_name, role_id, invited_by) VALUES
  ('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000a1', 'taken@example.com', 'Taken',
   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1');

DO $$
DECLARE n int; v_user uuid;
BEGIN
  -- one pending invitation per e-mail and organization
  BEGIN
    INSERT INTO invitations (org_id, email, full_name, role_id, invited_by)
      VALUES ('00000000-0000-0000-0000-0000000000a1', 'new@example.com', 'Dup', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1');
    RAISE EXCEPTION 'duplicate pending invitation accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  -- e-mail must be lower case
  BEGIN
    INSERT INTO invitations (org_id, email, full_name, role_id, invited_by)
      VALUES ('00000000-0000-0000-0000-0000000000a1', 'Upper@Example.com', 'Up', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1');
    RAISE EXCEPTION 'upper-case e-mail accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- a membership cannot point to a site of another organization
  BEGIN
    INSERT INTO memberships (id, org_id, user_id, role_id) VALUES ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1');
    INSERT INTO membership_sites (org_id, membership_id, site_id) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000005b2');
    RAISE EXCEPTION 'cross-organization site accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  DELETE FROM membership_sites; DELETE FROM memberships WHERE id = '00000000-0000-0000-0000-00000000bb01';
END $$;

SET LOCAL ROLE app_user;
DO $$
DECLARE n int;
BEGIN
  -- claim: a new verified e-mail gets its membership, with only the sites of the same organization
  n := claim_invitations('fb-new', 'New@Example.com');
  ASSERT n = 1, format('expected 1 claim, got %s', n);
  -- claiming twice does nothing
  ASSERT claim_invitations('fb-new', 'new@example.com') = 0, 'second claim should do nothing';
  -- expired, revoked, unknown and empty inputs never claim
  ASSERT claim_invitations('fb-exp', 'expired@example.com') = 0, 'expired invitation claimed';
  ASSERT claim_invitations('fb-rev', 'revoked@example.com') = 0, 'revoked invitation claimed';
  ASSERT claim_invitations('fb-nobody', 'nobody@example.com') = 0, 'unknown e-mail claimed';
  ASSERT claim_invitations('', 'new@example.com') = 0, 'empty uid accepted';
  ASSERT claim_invitations('fb-x', '') = 0, 'empty e-mail accepted';
  -- the e-mail of an existing, different account is never merged
  ASSERT claim_invitations('fb-attacker', 'taken@example.com') = 0, 'e-mail of another account was claimed';
END $$;
RESET ROLE;

DO $$
DECLARE v_user uuid; n int;
BEGIN
  SELECT id INTO v_user FROM users WHERE firebase_uid = 'fb-new';
  ASSERT v_user IS NOT NULL, 'user was not created';
  ASSERT (SELECT full_name FROM users WHERE id = v_user) = 'New Person', 'name not taken from the invitation';
  SELECT count(*) INTO n FROM memberships WHERE user_id = v_user AND org_id = '00000000-0000-0000-0000-0000000000a1';
  ASSERT n = 1, 'membership missing';
  SELECT count(*) INTO n FROM membership_sites ms JOIN memberships m ON m.id = ms.membership_id WHERE m.user_id = v_user;
  ASSERT n = 1, format('expected only the same-organization site, got %s', n);
  ASSERT (SELECT status FROM invitations WHERE id = '00000000-0000-0000-0000-00000000aa01') = 'accepted', 'invitation not marked accepted';
  ASSERT (SELECT accepted_user_id FROM invitations WHERE id = '00000000-0000-0000-0000-00000000aa01') = v_user, 'accepted_user_id missing';
  ASSERT (SELECT count(*) FROM audit_logs WHERE entity_type = 'invitation' AND action = 'accepted') = 1, 'audit entry missing';
  ASSERT (SELECT status FROM invitations WHERE id = '00000000-0000-0000-0000-00000000aa04') = 'pending', 'invitation of a taken e-mail changed';
END $$;

ROLLBACK;
SELECT 'invitation constraints: all checks passed' AS result;
