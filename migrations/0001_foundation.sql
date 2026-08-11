CREATE TABLE ingestion_scopes (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('confluence', 'jira', 'bitbucket', 'git', 'files')),
  selector_kind text NOT NULL,
  selector jsonb NOT NULL,
  refresh_mode text NOT NULL CHECK (refresh_mode IN ('snapshot', 'manual', 'scheduled', 'continuous')),
  include_children boolean NOT NULL DEFAULT false,
  include_attachments boolean NOT NULL DEFAULT true,
  schedule text,
  enabled boolean NOT NULL DEFAULT true,
  added_by text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0),
  cursor jsonb,
  last_success_at timestamptz,
  last_status text,
  deletion_policy text NOT NULL DEFAULT 'retain' CHECK (deletion_policy IN ('retain', 'purge')),
  UNIQUE (tenant_id, source, selector_kind, selector)
);

CREATE INDEX ingestion_scopes_due_idx
  ON ingestion_scopes (tenant_id, source, refresh_mode, enabled)
  WHERE enabled;

CREATE TABLE resources (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  source text NOT NULL,
  source_object_id text NOT NULL,
  canonical_uri text NOT NULL,
  title text NOT NULL,
  orphaned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, source_object_id)
);

CREATE TABLE resource_scopes (
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  scope_id uuid NOT NULL REFERENCES ingestion_scopes(id) ON DELETE CASCADE,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, scope_id)
);

CREATE INDEX resource_scopes_scope_idx ON resource_scopes (scope_id, resource_id);
