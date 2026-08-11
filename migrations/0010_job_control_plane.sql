CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  scope_id uuid REFERENCES ingestion_scopes(id) ON DELETE SET NULL,
  job_type text NOT NULL,
  lane text NOT NULL DEFAULT 'live' CHECK (lane IN ('live', 'backfill')),
  payload jsonb NOT NULL,
  checkpoint jsonb,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'completed', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  fence_token bigint NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  CHECK (
    (status = 'claimed' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'claimed'
  )
);

CREATE INDEX jobs_claimable_idx
  ON jobs (lane, run_after, created_at, id)
  WHERE status = 'pending';

CREATE INDEX jobs_scope_idx ON jobs (tenant_id, scope_id, status);

CREATE INDEX jobs_expired_lease_idx
  ON jobs (lease_expires_at)
  WHERE status = 'claimed';

CREATE TABLE operator_events (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operator_events_tenant_idx
  ON operator_events (tenant_id, created_at DESC);
