-- 001_init — capabilities, scopes, and the minimum document identity they need.
--
-- Every statement here must run unchanged on PGlite and on PostgreSQL 16.
-- No extensions, no profile-specific SQL. → docs/adr/0012-storage-profiles.md

CREATE TABLE IF NOT EXISTS capabilities (
  name         text PRIMARY KEY,
  available    boolean     NOT NULL,
  detail       text,
  detected_at  timestamptz NOT NULL DEFAULT now()
);

-- A scope is a durable statement: "this source material is part of my corpus."
-- It is the unit of configuration, sync, removal and audit.
-- → docs/adr/0011-scope-driven-ingestion.md
CREATE TABLE IF NOT EXISTS scopes (
  id             text PRIMARY KEY,          -- 'confluence:space:ARCH'
  source         text        NOT NULL,      -- confluence | jira | bitbucket | files
  selector_kind  text        NOT NULL,      -- space|page|label|cql|project|issue|jql|repo|path
  selector       text        NOT NULL,
  recursive      boolean     NOT NULL DEFAULT true,
  trigger        text        NOT NULL DEFAULT 'manual',  -- manual|scheduled|on-reference
  schedule       text,                                    -- NULL unless trigger='scheduled'
  enabled        boolean     NOT NULL DEFAULT true,
  added_by       text        NOT NULL,
  added_at       timestamptz NOT NULL DEFAULT now(),
  cursor         jsonb,                     -- per scope, NOT per source
  last_sync_at   timestamptz,
  last_status    text,
  CONSTRAINT scopes_trigger_valid CHECK (trigger IN ('manual', 'scheduled', 'on-reference')),
  CONSTRAINT scopes_schedule_matches_trigger CHECK (
    (trigger = 'scheduled' AND schedule IS NOT NULL) OR
    (trigger <> 'scheduled' AND schedule IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS scopes_due_idx ON scopes (source, enabled, last_sync_at);

CREATE TABLE IF NOT EXISTS documents (
  id             bigserial PRIMARY KEY,
  source         text        NOT NULL,
  external_id    text        NOT NULL,
  container      text,                      -- indexed column, not jsonb: this is the ACL pre-filter
  title          text,
  canonical_url  text,
  content_hash   text,
  meta_hash      text,
  acl_hash       text,
  -- A stub is a document referenced from indexed material but outside every
  -- scope. It carries identity and title only: no body, no chunks, no vectors.
  -- The stub table is also the on-reference ingestion queue.
  out_of_scope   boolean     NOT NULL DEFAULT false,
  reference_count integer    NOT NULL DEFAULT 0,
  synced_at      timestamptz,
  tombstoned_at  timestamptz,
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS documents_container_idx ON documents (container) WHERE tombstoned_at IS NULL;
CREATE INDEX IF NOT EXISTS documents_stub_backlog_idx
  ON documents (reference_count DESC) WHERE out_of_scope = true;

-- Many-to-many, and this is why removal works. A document reachable from two
-- scopes must survive removal of one of them.
CREATE TABLE IF NOT EXISTS document_scopes (
  document_id  bigint NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  scope_id     text   NOT NULL REFERENCES scopes (id)    ON DELETE CASCADE,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, scope_id)
);

CREATE INDEX IF NOT EXISTS document_scopes_scope_idx ON document_scopes (scope_id);
