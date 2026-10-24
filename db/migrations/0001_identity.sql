-- MT-HSE-Platform — migration 0001: identity, organization structure, RBAC, audit, RLS.
-- STATUS: written but NOT yet executed (no PostgreSQL available in the authoring sandbox).
-- Run it with `docker compose -f docker-compose.dev.yml up` and then db/tests/rls_isolation.sql.
--
-- Security model:
--   * The app connects as `app_user` (NOT the table owner, no BYPASSRLS), so RLS always applies to it.
--   * Every request runs in a transaction that first sets:
--       SET LOCAL app.org_id  = '<uuid>';
--       SET LOCAL app.user_id = '<uuid>';
--   * Rows are visible/writable only when org_id = app.org_id.

BEGIN;

-- ---------- helper functions ----------
CREATE FUNCTION app_org_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ---------- application role (login/password is set per environment, never in migrations) ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

-- ---------- tables ----------
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  locale      text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar', 'en')),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);

-- Global identity (one person can, in future, belong to several organizations).
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid  text NOT NULL UNIQUE,
  email         text NOT NULL UNIQUE,
  username      text UNIQUE,            -- maps username login to the email Firebase knows
  full_name     text NOT NULL,
  locale        text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar', 'en')),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (org_id, name)
);

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (org_id, name)
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (org_id, name)
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  key text,                              -- system role key (e.g. 'hse_manager'); NULL for custom roles
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, name),
  UNIQUE (id, org_id)                    -- lets child tables prove same-org membership
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL,
  org_id uuid NOT NULL,
  permission text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('org', 'site', 'own', 'assigned')),
  PRIMARY KEY (role_id, permission, scope),
  FOREIGN KEY (role_id, org_id) REFERENCES roles (id, org_id) ON DELETE CASCADE
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL,
  department_id uuid REFERENCES departments(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, user_id),
  UNIQUE (id, org_id),
  FOREIGN KEY (role_id, org_id) REFERENCES roles (id, org_id)   -- role must belong to the same org
);

CREATE TABLE membership_sites (
  org_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  site_id uuid NOT NULL REFERENCES sites(id),
  PRIMARY KEY (membership_id, site_id),
  FOREIGN KEY (membership_id, org_id) REFERENCES memberships (id, org_id) ON DELETE CASCADE
);

CREATE TABLE membership_teams (
  org_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  team_id uuid NOT NULL REFERENCES teams(id),
  PRIMARY KEY (membership_id, team_id),
  FOREIGN KEY (membership_id, org_id) REFERENCES memberships (id, org_id) ON DELETE CASCADE
);

-- Append-only: app_user gets INSERT/SELECT only (see grants below).
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  actor_user_id uuid REFERENCES users(id),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (org_id, entity_type, entity_id, at DESC);

-- ---------- Row-Level Security ----------
-- Not FORCEd on purpose: the table owner (migration role) bypasses RLS; app_user (non-owner) never does.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON organizations
  USING (id = app_org_id()) WITH CHECK (id = app_org_id());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'departments', 'sites', 'teams', 'roles', 'role_permissions',
    'memberships', 'membership_sites', 'membership_teams', 'audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;

-- users: global table. Readable only for people in the current org (or oneself). No write policy => no writes by app_user;
-- user creation/onboarding goes through a dedicated privileged function in a later migration.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users FOR SELECT USING (
  id = app_user_id()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.org_id = app_org_id())
);

-- ---------- login resolution (runs BEFORE org context is known) ----------
CREATE FUNCTION resolve_membership(p_firebase_uid text)
RETURNS TABLE (user_id uuid, org_id uuid, membership_id uuid, role_id uuid, user_active boolean, membership_active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT u.id, m.org_id, m.id, m.role_id, u.active, (m.status = 'active')
  FROM users u JOIN memberships m ON m.user_id = u.id
  WHERE u.firebase_uid = p_firebase_uid
$$;
REVOKE ALL ON FUNCTION resolve_membership(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_membership(text) TO app_user;

-- ---------- grants (least privilege; no DELETE anywhere: soft delete only) ----------
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT ON organizations, users TO app_user;
GRANT SELECT, INSERT, UPDATE ON
  departments, sites, teams, roles, role_permissions, memberships, membership_sites, membership_teams
  TO app_user;
GRANT DELETE ON role_permissions, membership_sites, membership_teams TO app_user;  -- link tables only
GRANT SELECT, INSERT ON audit_logs TO app_user;                                    -- append-only
GRANT USAGE ON SEQUENCE audit_logs_id_seq TO app_user;
GRANT EXECUTE ON FUNCTION app_org_id(), app_user_id() TO app_user;

COMMIT;
