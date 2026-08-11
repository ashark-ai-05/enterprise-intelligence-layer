ALTER TABLE resources
  ADD COLUMN source_version text NOT NULL DEFAULT 'unknown',
  ADD COLUMN body text NOT NULL DEFAULT '',
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN raw_hash text,
  ADD COLUMN content_hash text,
  ADD COLUMN metadata_hash text,
  ADD COLUMN acl_hash text,
  ADD COLUMN source_updated_at timestamptz,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN indexed_at timestamptz;

CREATE TABLE raw_source_items (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope_id uuid REFERENCES ingestion_scopes(id) ON DELETE SET NULL,
  source text NOT NULL,
  source_object_id text NOT NULL,
  source_version text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope_id, source, source_object_id, source_version, payload_hash)
);

CREATE INDEX raw_source_items_scope_idx
  ON raw_source_items (tenant_id, scope_id, acquired_at);

CREATE TABLE resource_aces (
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  principal_domain text NOT NULL,
  principal_id text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  PRIMARY KEY (resource_id, principal_domain, principal_id, effect)
);

CREATE INDEX resource_aces_principal_idx
  ON resource_aces (principal_domain, principal_id, effect, resource_id);

CREATE TABLE ingestion_runs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope_id uuid REFERENCES ingestion_scopes(id) ON DELETE SET NULL,
  connector text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text
);

CREATE INDEX ingestion_runs_scope_idx
  ON ingestion_runs (tenant_id, scope_id, started_at DESC);
