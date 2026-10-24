-- MT-HSE-Platform — migration 0006: uploaded media (photos, audio, PDFs, signatures) and inspection signatures.
-- File bytes are NOT in the database: only metadata and the storage key (files live in the media volume).
BEGIN;

CREATE TABLE media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  owner_type text NOT NULL CHECK (owner_type IN ('inspection', 'issue', 'action')),
  owner_id uuid NOT NULL,
  question_id text CHECK (question_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  kind text NOT NULL CHECK (kind IN ('photo', 'audio', 'file', 'signature')),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key text NOT NULL,
  caption text CHECK (char_length(caption) <= 300),
  taken_at timestamptz,
  lat double precision CHECK (lat BETWEEN -90 AND 90),
  lng double precision CHECK (lng BETWEEN -180 AND 180),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, org_id)
);
CREATE INDEX media_owner_idx ON media (org_id, owner_type, owner_id) WHERE deleted_at IS NULL;

CREATE TABLE inspection_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  inspection_id uuid NOT NULL,
  media_id uuid NOT NULL,
  signer_name text NOT NULL CHECK (char_length(signer_name) BETWEEN 2 AND 200),
  signer_role text CHECK (char_length(signer_role) <= 100),
  signed_by uuid NOT NULL REFERENCES users(id),
  signed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_id),
  FOREIGN KEY (inspection_id, org_id) REFERENCES inspections (id, org_id),
  FOREIGN KEY (media_id, org_id) REFERENCES media (id, org_id)
);
CREATE INDEX inspection_signatures_idx ON inspection_signatures (org_id, inspection_id, signed_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['media', 'inspection_signatures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id())', t);
  END LOOP;
END $$;

-- media: metadata can be soft-deleted (deleted_at) but never hard-deleted; signatures are append-only evidence.
GRANT SELECT, INSERT, UPDATE ON media TO app_user;
GRANT SELECT, INSERT ON inspection_signatures TO app_user;

COMMIT;
