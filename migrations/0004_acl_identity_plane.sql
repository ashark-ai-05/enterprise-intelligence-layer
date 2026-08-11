CREATE TABLE containers (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  source text NOT NULL,
  source_container_id text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, source_container_id)
);

ALTER TABLE resources
  ADD COLUMN container_id uuid REFERENCES containers(id) ON DELETE SET NULL;

CREATE INDEX resources_container_idx
  ON resources (tenant_id, container_id, id)
  WHERE deleted_at IS NULL;

CREATE TABLE enterprise_identities (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject)
);

CREATE TABLE principal_mappings (
  tenant_id text NOT NULL,
  authorization_domain text NOT NULL,
  source_identifier text NOT NULL,
  enterprise_identity_id uuid REFERENCES enterprise_identities(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('mapped', 'unmapped')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, authorization_domain, source_identifier),
  CHECK (
    (status = 'mapped' AND enterprise_identity_id IS NOT NULL)
    OR (status = 'unmapped' AND enterprise_identity_id IS NULL)
  )
);

CREATE INDEX principal_mappings_identity_idx
  ON principal_mappings (tenant_id, enterprise_identity_id)
  WHERE status = 'mapped';

CREATE TABLE container_aces (
  container_id uuid NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  principal_domain text NOT NULL,
  principal_id text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  PRIMARY KEY (container_id, principal_domain, principal_id, effect)
);

CREATE INDEX container_aces_principal_idx
  ON container_aces (principal_domain, principal_id, effect, container_id);
