CREATE TABLE resource_chunks (
  id uuid PRIMARY KEY,
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  stable_key text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  kind text NOT NULL,
  text text NOT NULL,
  location jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (resource_id, stable_key)
);

CREATE INDEX resource_chunks_resource_idx
  ON resource_chunks (resource_id, ordinal)
  WHERE deleted_at IS NULL;

CREATE TABLE chunk_aces (
  chunk_id uuid NOT NULL REFERENCES resource_chunks(id) ON DELETE CASCADE,
  principal_domain text NOT NULL,
  principal_id text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  PRIMARY KEY (chunk_id, principal_domain, principal_id, effect)
);

CREATE INDEX chunk_aces_principal_idx
  ON chunk_aces (principal_domain, principal_id, effect, chunk_id);
