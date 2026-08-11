import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../storage/database.js";
import { withTransaction } from "../storage/database.js";

const enqueueJobSchema = z.object({
  tenantId: z.string().min(1),
  scopeId: z.string().uuid().optional(),
  jobType: z.string().min(1),
  lane: z.enum(["live", "backfill"]).default("live"),
  payload: z.record(z.unknown()),
  idempotencyKey: z.string().min(1),
  maxAttempts: z.number().int().positive().default(5),
  runAfter: z.string().datetime({ offset: true }).optional(),
});

export type EnqueueJob = z.input<typeof enqueueJobSchema>;
export type JobStatus = "pending" | "claimed" | "completed" | "dead_letter";

export interface Job {
  id: string;
  tenantId: string;
  scopeId: string | null;
  jobType: string;
  lane: "live" | "backfill";
  payload: Record<string, unknown>;
  checkpoint: Record<string, unknown> | null;
  idempotencyKey: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  fenceToken: number;
  lastError: string | null;
}

interface JobRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  scope_id: string | null;
  job_type: string;
  lane: Job["lane"];
  payload: Record<string, unknown> | string;
  checkpoint: Record<string, unknown> | string | null;
  idempotency_key: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: Date | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  fence_token: number | string;
  last_error: string | null;
}

const columns = `
  id, tenant_id, scope_id, job_type, lane, payload, checkpoint, idempotency_key,
  status, attempts, max_attempts, run_after, lease_owner, lease_expires_at,
  fence_token, last_error
`;

function jsonObject(
  value: Record<string, unknown> | string,
): Record<string, unknown> {
  return typeof value === "string"
    ? (JSON.parse(value) as Record<string, unknown>)
    : value;
}

function jobFromRow(row: JobRow): Job {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scopeId: row.scope_id,
    jobType: row.job_type,
    lane: row.lane,
    payload: jsonObject(row.payload),
    checkpoint: row.checkpoint === null ? null : jsonObject(row.checkpoint),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    runAfter: new Date(row.run_after),
    leaseOwner: row.lease_owner,
    leaseExpiresAt:
      row.lease_expires_at === null ? null : new Date(row.lease_expires_at),
    fenceToken: Number(row.fence_token),
    lastError: row.last_error,
  };
}

export async function enqueueJob(
  db: Database,
  input: EnqueueJob,
): Promise<Job> {
  const job = enqueueJobSchema.parse(input);
  if (job.scopeId !== undefined) {
    const scope = await db.query<{ id: string }>(
      "SELECT id FROM ingestion_scopes WHERE id = $1 AND tenant_id = $2",
      [job.scopeId, job.tenantId],
    );
    if (!scope.rows[0]) {
      throw new Error("job scope must belong to the same tenant");
    }
  }
  const result = await db.query<JobRow>(
    `INSERT INTO jobs (
      id, tenant_id, scope_id, job_type, lane, payload, idempotency_key,
      max_attempts, run_after
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, COALESCE($9::timestamptz, now()))
    ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
      idempotency_key = EXCLUDED.idempotency_key
    RETURNING ${columns}`,
    [
      randomUUID(),
      job.tenantId,
      job.scopeId ?? null,
      job.jobType,
      job.lane,
      JSON.stringify(job.payload),
      job.idempotencyKey,
      job.maxAttempts,
      job.runAfter ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("job enqueue returned no row");
  return jobFromRow(row);
}

export async function claimJob(
  db: Database,
  tenantId: string,
  workerId: string,
  leaseSeconds = 60,
): Promise<Job | null> {
  if (!tenantId || !workerId) throw new Error("tenant and worker are required");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error("leaseSeconds must be a positive integer");
  }
  return withTransaction(db, async (tx) => {
    await tx.query(
      `UPDATE jobs SET status = 'dead_letter', lease_owner = NULL,
        lease_expires_at = NULL, last_error = COALESCE(last_error, 'lease expired'),
        updated_at = now()
       WHERE tenant_id = $1 AND status = 'claimed'
         AND lease_expires_at <= now() AND attempts >= max_attempts`,
      [tenantId],
    );
    const skipLocked = tx.profile === "server" ? " SKIP LOCKED" : "";
    const candidate = await tx.query<{ id: string }>(
      `SELECT id FROM jobs
       WHERE tenant_id = $1 AND attempts < max_attempts
         AND (
           scope_id IS NULL
           OR EXISTS (
             SELECT 1 FROM ingestion_scopes s
             WHERE s.id = jobs.scope_id AND s.tenant_id = jobs.tenant_id AND s.enabled
           )
         )
         AND (
           (status = 'pending' AND run_after <= now())
           OR (status = 'claimed' AND lease_expires_at <= now())
         )
       ORDER BY CASE lane WHEN 'live' THEN 0 ELSE 1 END, run_after, created_at, id
       FOR UPDATE${skipLocked} LIMIT 1`,
      [tenantId],
    );
    const id = candidate.rows[0]?.id;
    if (!id) return null;
    const claimed = await tx.query<JobRow>(
      `UPDATE jobs SET status = 'claimed', attempts = attempts + 1,
        lease_owner = $2,
        lease_expires_at = now() + ($3 * interval '1 second'),
        fence_token = fence_token + 1, updated_at = now()
       WHERE id = $1 AND tenant_id = $4
       RETURNING ${columns}`,
      [id, workerId, leaseSeconds, tenantId],
    );
    const row = claimed.rows[0];
    if (!row) throw new Error("claimed job disappeared");
    return jobFromRow(row);
  });
}

async function fencedUpdate(
  db: Database,
  jobId: string,
  tenantId: string,
  workerId: string,
  fenceToken: number,
  setClause: string,
  params: readonly unknown[] = [],
): Promise<Job> {
  const result = await db.query<JobRow>(
    `UPDATE jobs SET ${setClause}, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'claimed'
       AND lease_owner = $3 AND fence_token = $4 AND lease_expires_at > now()
     RETURNING ${columns}`,
    [jobId, tenantId, workerId, fenceToken, ...params],
  );
  const row = result.rows[0];
  if (!row) throw new Error("stale or expired job lease");
  return jobFromRow(row);
}

export async function saveJobCheckpoint(
  db: Database,
  job: Pick<Job, "id" | "tenantId" | "leaseOwner" | "fenceToken">,
  checkpoint: Record<string, unknown>,
): Promise<Job> {
  if (!job.leaseOwner) throw new Error("job has no lease owner");
  return fencedUpdate(
    db,
    job.id,
    job.tenantId,
    job.leaseOwner,
    job.fenceToken,
    "checkpoint = $5::jsonb",
    [JSON.stringify(checkpoint)],
  );
}

export async function completeJob(
  db: Database,
  job: Pick<Job, "id" | "tenantId" | "leaseOwner" | "fenceToken">,
): Promise<Job> {
  if (!job.leaseOwner) throw new Error("job has no lease owner");
  return fencedUpdate(
    db,
    job.id,
    job.tenantId,
    job.leaseOwner,
    job.fenceToken,
    "status = 'completed', completed_at = now(), lease_owner = NULL, lease_expires_at = NULL",
  );
}

export async function failJob(
  db: Database,
  job: Pick<Job, "id" | "tenantId" | "leaseOwner" | "fenceToken">,
  error: string,
  backoffSeconds = 0,
): Promise<Job> {
  if (!job.leaseOwner) throw new Error("job has no lease owner");
  if (!Number.isInteger(backoffSeconds) || backoffSeconds < 0) {
    throw new Error("backoffSeconds must be a non-negative integer");
  }
  return fencedUpdate(
    db,
    job.id,
    job.tenantId,
    job.leaseOwner,
    job.fenceToken,
    `status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
     run_after = now() + ($6 * interval '1 second'), last_error = $5,
     lease_owner = NULL, lease_expires_at = NULL`,
    [error.slice(0, 2_000), backoffSeconds],
  );
}

export async function extendJobLease(
  db: Database,
  job: Pick<Job, "id" | "tenantId" | "leaseOwner" | "fenceToken">,
  leaseSeconds: number,
): Promise<Job> {
  if (!job.leaseOwner) throw new Error("job has no lease owner");
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1) {
    throw new Error("leaseSeconds must be a positive integer");
  }
  return fencedUpdate(
    db,
    job.id,
    job.tenantId,
    job.leaseOwner,
    job.fenceToken,
    "lease_expires_at = now() + ($5 * interval '1 second')",
    [leaseSeconds],
  );
}
