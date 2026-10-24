-- MT-HSE-Platform — migration 0005: invitations (add employees without handling their passwords).
-- Flow: an admin invites an email + role + sites. The person signs up with Firebase, verifies the email address, and on
-- first sign-in claim_invitations() turns the pending invitation into a membership. No Firebase service-account key is
-- needed, and nobody except the owner of the (verified) email address can claim an invitation.
BEGIN;

-- a membership's site must belong to the same organization
ALTER TABLE membership_sites ADD CONSTRAINT membership_sites_site_org_fk FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 5 AND 254),
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 200),
  role_id uuid NOT NULL,
  site_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  invited_by uuid NOT NULL REFERENCES users(id),
  accepted_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '14 days',
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (id, org_id),
  FOREIGN KEY (role_id, org_id) REFERENCES roles (id, org_id),
  CHECK ((status = 'accepted') = (accepted_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX invitations_one_pending_per_email ON invitations (org_id, email) WHERE status = 'pending';
CREATE INDEX invitations_email_idx ON invitations (email) WHERE status = 'pending';

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON invitations USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON invitations TO app_user;   -- no DELETE: revoke instead

-- Runs BEFORE the organization is known (the person has no membership yet), so it is SECURITY DEFINER.
-- The caller passes the Firebase uid and the e-mail from a token the API has already verified (email_verified = true).
CREATE FUNCTION claim_invitations(p_firebase_uid text, p_email text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email text := lower(trim(coalesce(p_email, '')));
  v_user uuid;
  v_m uuid;
  v_count integer := 0;
  r record;
BEGIN
  IF v_email = '' OR coalesce(p_firebase_uid, '') = '' THEN RETURN 0; END IF;

  SELECT id INTO v_user FROM users WHERE firebase_uid = p_firebase_uid;
  IF v_user IS NULL AND EXISTS (SELECT 1 FROM users WHERE email = v_email) THEN
    RETURN 0;  -- the same e-mail belongs to another account: refuse instead of merging identities
  END IF;

  FOR r IN
    SELECT * FROM invitations WHERE email = v_email AND status = 'pending' AND expires_at > now() ORDER BY created_at FOR UPDATE
  LOOP
    IF v_user IS NULL THEN
      INSERT INTO users (firebase_uid, email, full_name, locale)
      VALUES (p_firebase_uid, v_email, r.full_name, (SELECT locale FROM organizations WHERE id = r.org_id))
      RETURNING id INTO v_user;
    END IF;

    v_m := NULL;
    INSERT INTO memberships (org_id, user_id, role_id) VALUES (r.org_id, v_user, r.role_id)
      ON CONFLICT (org_id, user_id) DO NOTHING RETURNING id INTO v_m;
    IF v_m IS NULL THEN SELECT id INTO v_m FROM memberships WHERE org_id = r.org_id AND user_id = v_user; END IF;

    INSERT INTO membership_sites (org_id, membership_id, site_id)
      SELECT r.org_id, v_m, s.id FROM sites s WHERE s.org_id = r.org_id AND s.id = ANY (r.site_ids)
      ON CONFLICT DO NOTHING;

    UPDATE invitations SET status = 'accepted', accepted_user_id = v_user, updated_at = now(), version = version + 1 WHERE id = r.id;
    INSERT INTO audit_logs (org_id, actor_user_id, entity_type, entity_id, action, new_value)
      VALUES (r.org_id, v_user, 'invitation', r.id::text, 'accepted', jsonb_build_object('email', v_email));
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION claim_invitations(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_invitations(text, text) TO app_user;

-- user management needs to edit memberships' sites and read roles' links
GRANT SELECT, INSERT, UPDATE ON memberships TO app_user;

COMMIT;
