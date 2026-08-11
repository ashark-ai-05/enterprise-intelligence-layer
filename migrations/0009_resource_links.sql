CREATE TABLE resource_links (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  from_resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  from_source text NOT NULL,
  from_source_object_id text NOT NULL,
  to_source text NOT NULL,
  to_source_object_id text NOT NULL,
  link_type text NOT NULL CHECK (link_type IN ('documents', 'implemented-by', 'tested-by')),
  origin text NOT NULL CHECK (origin IN ('source-explicit', 'deterministic-extracted', 'inferred')),
  source_version text NOT NULL,
  extractor_version text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    tenant_id, from_resource_id, to_source, to_source_object_id,
    link_type, origin, extractor_version
  )
);

CREATE INDEX resource_links_from_idx
  ON resource_links (tenant_id, from_source_object_id);

CREATE INDEX resource_links_to_idx
  ON resource_links (tenant_id, to_source_object_id);
