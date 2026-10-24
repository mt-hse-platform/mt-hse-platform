-- MT-HSE-Platform — migration 0004: inspections, per-question responses, flags.
-- STATUS: written; executed only by CI (GitHub Actions) and by you when you run the database.
BEGIN;

CREATE TABLE inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  template_id uuid NOT NULL,
  template_version_id uuid NOT NULL,      -- the exact published version used; never changes
  title text CHECK (char_length(title) <= 200),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','cancelled','archived')),
  started_by uuid NOT NULL REFERENCES users(id),
  site_id uuid,
  asset_id uuid,                          -- FK added with the assets module
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  score_earned numeric,
  score_possible numeric,
  score_pct numeric,
  passed boolean,
  flagged_rate numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (id, org_id),
  FOREIGN KEY (template_id, org_id) REFERENCES templates (id, org_id),
  FOREIGN KEY (template_version_id, org_id) REFERENCES template_versions (id, org_id),
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);
CREATE INDEX inspections_status_idx ON inspections (org_id, status, started_at DESC);
CREATE INDEX inspections_site_idx ON inspections (org_id, site_id, status);
CREATE INDEX inspections_owner_idx ON inspections (org_id, started_by, status);
CREATE INDEX inspections_template_idx ON inspections (org_id, template_id);

-- An inspection can only start from a PUBLISHED version of the SAME template.
CREATE FUNCTION inspection_requires_published_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM template_versions v
    WHERE v.id = NEW.template_version_id AND v.template_id = NEW.template_id AND v.status = 'published'
  ) THEN
    RAISE EXCEPTION 'inspections must use a published version of the template' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspections_published_version BEFORE INSERT ON inspections
  FOR EACH ROW EXECUTE FUNCTION inspection_requires_published_version();

-- Finished inspections are frozen: only completed/cancelled -> archived is allowed (results and version cannot change).
CREATE FUNCTION inspection_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'cancelled', 'archived') THEN
    IF NOT (OLD.status IN ('completed', 'cancelled') AND NEW.status = 'archived'
            AND NEW.template_version_id = OLD.template_version_id
            AND NEW.score_pct IS NOT DISTINCT FROM OLD.score_pct
            AND NEW.score_earned IS NOT DISTINCT FROM OLD.score_earned
            AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at) THEN
      RAISE EXCEPTION 'finished inspections cannot be modified' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspections_freeze BEFORE UPDATE ON inspections
  FOR EACH ROW EXECUTE FUNCTION inspection_freeze();

-- One row per answered question (small rows => fewer sync conflicts; per-question version for conflict detection).
CREATE TABLE inspection_responses (
  org_id uuid NOT NULL,
  inspection_id uuid NOT NULL,
  question_id text NOT NULL CHECK (question_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  value jsonb,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (inspection_id, question_id),
  FOREIGN KEY (inspection_id, org_id) REFERENCES inspections (id, org_id)
);

CREATE FUNCTION response_requires_open_inspection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inspections i WHERE i.id = NEW.inspection_id AND i.status = 'in_progress') THEN
    RAISE EXCEPTION 'responses can only change while the inspection is in progress' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inspection_responses_open BEFORE INSERT OR UPDATE ON inspection_responses
  FOR EACH ROW EXECUTE FUNCTION response_requires_open_inspection();

-- Flagged items, created when the inspection is completed.
CREATE TABLE inspection_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  inspection_id uuid NOT NULL,
  question_id text NOT NULL,
  page_id text NOT NULL,
  section_id text,
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  descriptions jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  issue_id uuid,
  action_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (inspection_id, question_id),
  FOREIGN KEY (inspection_id, org_id) REFERENCES inspections (id, org_id),
  FOREIGN KEY (issue_id, org_id) REFERENCES issues (id, org_id),
  FOREIGN KEY (action_id, org_id) REFERENCES actions (id, org_id)
);
CREATE INDEX inspection_flags_status_idx ON inspection_flags (org_id, status, severity);

-- Issues and actions raised from an inspection now point at a real inspection.
ALTER TABLE issues ADD CONSTRAINT issues_inspection_fk FOREIGN KEY (inspection_id, org_id) REFERENCES inspections (id, org_id);
ALTER TABLE actions ADD CONSTRAINT actions_inspection_fk FOREIGN KEY (inspection_id, org_id) REFERENCES inspections (id, org_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inspections', 'inspection_responses', 'inspection_flags'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON inspections, inspection_responses, inspection_flags TO app_user;  -- no DELETE

COMMIT;
