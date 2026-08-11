CREATE TABLE index_generations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  source_version text NOT NULL,
  content_hash text NOT NULL,
  metadata_hash text NOT NULL,
  acl_hash text NOT NULL,
  parser_version text NOT NULL,
  chunker_version text NOT NULL,
  required_projections text[] NOT NULL,
  state text NOT NULL CHECK (state IN ('staging', 'published', 'superseded', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  superseded_at timestamptz,
  UNIQUE (
    resource_id,
    source_version,
    content_hash,
    metadata_hash,
    acl_hash,
    parser_version,
    chunker_version,
    required_projections
  )
);

CREATE TABLE generation_projections (
  generation_id uuid NOT NULL REFERENCES index_generations(id) ON DELETE CASCADE,
  projection text NOT NULL,
  generation_key text NOT NULL,
  checksum text NOT NULL,
  ready_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (generation_id, projection)
);

ALTER TABLE resources
  ADD COLUMN published_generation_id uuid REFERENCES index_generations(id) ON DELETE SET NULL;

CREATE INDEX index_generations_resource_idx
  ON index_generations (tenant_id, resource_id, state, created_at DESC);

CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  resource_id uuid REFERENCES resources(id) ON DELETE SET NULL,
  source text NOT NULL,
  source_object_id text NOT NULL,
  source_version text NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('tombstone', 'purge')),
  state text NOT NULL CHECK (state IN ('pending', 'held', 'applied')),
  legal_hold boolean NOT NULL DEFAULT false,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX deletion_requests_resource_idx
  ON deletion_requests (tenant_id, source, source_object_id, requested_at DESC);
