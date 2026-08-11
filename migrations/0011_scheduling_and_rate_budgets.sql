ALTER TABLE ingestion_scopes
  ADD COLUMN next_run_at timestamptz;

CREATE INDEX ingestion_scopes_schedule_due_idx
  ON ingestion_scopes (tenant_id, next_run_at, id)
  WHERE enabled AND refresh_mode IN ('scheduled', 'continuous');

CREATE TABLE source_rate_budgets (
  tenant_id text NOT NULL,
  source text NOT NULL,
  capacity integer NOT NULL CHECK (capacity > 0),
  refill_per_second double precision NOT NULL CHECK (refill_per_second > 0),
  tokens double precision NOT NULL CHECK (tokens >= 0),
  refilled_at timestamptz NOT NULL,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source)
);
