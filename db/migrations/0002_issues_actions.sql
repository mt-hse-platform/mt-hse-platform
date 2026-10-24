-- MT-HSE-Platform — migration 0002: issues, actions, action comments, unified timeline.
-- STATUS: written; executed only by CI (GitHub Actions) once the repository is pushed.
-- Status/priority/type lists must match packages/engines/src/workflow.ts (a unit test compares them).
-- Links to inspections/templates/questions/assets are plain uuid columns for now; their foreign keys are added by the
-- migrations that create those tables.

BEGIN;

-- lets child tables prove "same organization" through composite foreign keys
ALTER TABLE sites ADD CONSTRAINT sites_id_org_uniq UNIQUE (id, org_id);

CREATE TABLE issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  description text CHECK (char_length(description) <= 5000),
  type text NOT NULL CHECK (type IN ('hazard','observation','unsafe_condition','unsafe_act','maintenance','near_miss','quality_issue','environmental_issue','other')),
  priority text NOT NULL CHECK (priority IN ('critical','high','medium','low','informational')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','assigned','in_progress','resolved','closed','rejected')),
  reporter_id uuid NOT NULL REFERENCES users(id),
  assignee_id uuid REFERENCES users(id),
  site_id uuid,
  asset_id uuid,
  due_date date,
  inspection_id uuid,
  template_id uuid,
  template_version_id uuid,
  question_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (id, org_id),
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id),
  CHECK (status <> 'assigned' OR assignee_id IS NOT NULL)
);
CREATE INDEX issues_status_idx ON issues (org_id, status, priority);
CREATE INDEX issues_assignee_idx ON issues (org_id, assignee_id, status);
CREATE INDEX issues_site_idx ON issues (org_id, site_id, status);

CREATE TABLE actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  description text CHECK (char_length(description) <= 5000),
  type text NOT NULL CHECK (type IN ('corrective','preventive','other')),
  priority text NOT NULL CHECK (priority IN ('critical','high','medium','low','informational')),
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','pending_verification','completed','cancelled')),
  owner_id uuid NOT NULL REFERENCES users(id),
  assignee_id uuid REFERENCES users(id),
  site_id uuid,
  asset_id uuid,
  due_date date,
  completed_at timestamptz,
  issue_id uuid,
  incident_id uuid,
  inspection_id uuid,
  template_id uuid,
  template_version_id uuid,
  question_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (id, org_id),
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id),
  FOREIGN KEY (issue_id, org_id) REFERENCES issues (id, org_id),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX actions_status_due_idx ON actions (org_id, status, due_date);
CREATE INDEX actions_assignee_idx ON actions (org_id, assignee_id, status);
CREATE INDEX actions_site_idx ON actions (org_id, site_id, status);

CREATE TABLE action_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  action_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  parent_id uuid REFERENCES action_comments(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (action_id, org_id) REFERENCES actions (id, org_id)
);
CREATE INDEX action_comments_action_idx ON action_comments (org_id, action_id, created_at);

-- Unified Activity Timeline for every entity (append-only).
CREATE TABLE timeline_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  event text NOT NULL,
  field text,
  actor_user_id uuid REFERENCES users(id),
  old_value jsonb,
  new_value jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timeline_entity_idx ON timeline_events (org_id, entity_type, entity_id, at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['issues', 'actions', 'action_comments', 'timeline_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;

-- Least privilege: no DELETE (soft delete via deleted_at); comments and timeline are append-only.
GRANT SELECT, INSERT, UPDATE ON issues, actions TO app_user;
GRANT SELECT, INSERT ON action_comments, timeline_events TO app_user;
GRANT USAGE ON SEQUENCE timeline_events_id_seq TO app_user;

COMMIT;
