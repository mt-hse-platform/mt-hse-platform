-- MT-HSE-Platform — migration 0003: templates and immutable published versions.
-- STATUS: written; executed only by CI (GitHub Actions) once the repository is pushed.
BEGIN;

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name jsonb NOT NULL,                      -- {"ar": "...", "en": "..."}
  description jsonb,
  category text CHECK (char_length(category) <= 100),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published_version_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  UNIQUE (id, org_id),
  CHECK ((status = 'published') = (published_version_id IS NOT NULL) OR status = 'archived')
);
CREATE INDEX templates_status_idx ON templates (org_id, status, created_at DESC);

CREATE TABLE template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  template_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  content jsonb NOT NULL,
  fingerprint text,
  published_at timestamptz,
  published_by uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (id, org_id),
  UNIQUE (template_id, version_no),
  FOREIGN KEY (template_id, org_id) REFERENCES templates (id, org_id),
  CHECK ((status = 'published') = (fingerprint IS NOT NULL AND published_at IS NOT NULL AND published_by IS NOT NULL))
);
-- at most one draft per template
CREATE UNIQUE INDEX template_versions_one_draft ON template_versions (template_id) WHERE status = 'draft';

ALTER TABLE templates ADD CONSTRAINT templates_published_version_fk
  FOREIGN KEY (published_version_id, org_id) REFERENCES template_versions (id, org_id);

-- A published version never changes and is never deleted (also binds the table owner).
CREATE FUNCTION forbid_published_version_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'published template versions are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_versions_immutable BEFORE UPDATE OR DELETE ON template_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_published_version_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['templates', 'template_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON templates, template_versions TO app_user;  -- no DELETE (soft delete / archive)

COMMIT;
