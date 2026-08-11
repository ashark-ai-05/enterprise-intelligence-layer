import { randomUUID } from "node:crypto";
import type { Job, JobStatus } from "../jobs/queue.js";
import type { Database } from "../storage/database.js";
import { withTransaction } from "../storage/database.js";

export interface QueueStatus {
  counts: Record<JobStatus, number>;
  duePending: number;
  expiredLeases: number;
  oldestPendingAt: Date | null;
}

export async function getQueueStatus(
  db: Database,
  tenantId: string,
): Promise<QueueStatus> {
  const grouped = await db.query<{ status: JobStatus; count: number }>(
    "SELECT status, count(*)::int AS count FROM jobs WHERE tenant_id = $1 GROUP BY status",
    [tenantId],
  );
  const counts: Record<JobStatus, number> = {
    pending: 0,
    claimed: 0,
    completed: 0,
    dead_letter: 0,
  };
  for (const row of grouped.rows) counts[row.status] = Number(row.count);
  const health = await db.query<{
    due_pending: number;
    expired_leases: number;
    oldest_pending_at: Date | string | null;
  }>(
    `SELECT
      count(*) FILTER (WHERE status = 'pending' AND run_after <= now())::int AS due_pending,
      count(*) FILTER (WHERE status = 'claimed' AND lease_expires_at <= now())::int AS expired_leases,
      min(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at
     FROM jobs WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = health.rows[0];
  return {
    counts,
    duePending: Number(row?.due_pending ?? 0),
    expiredLeases: Number(row?.expired_leases ?? 0),
    oldestPendingAt:
      row?.oldest_pending_at == null ? null : new Date(row.oldest_pending_at),
  };
}

export async function listDeadLetters(
  db: Database,
  tenantId: string,
): Promise<Array<Pick<Job, "id" | "jobType" | "attempts" | "lastError">>> {
  const result = await db.query<{
    id: string;
    job_type: string;
    attempts: number;
    last_error: string | null;
  }>(
    `SELECT id, job_type, attempts, last_error FROM jobs
     WHERE tenant_id = $1 AND status = 'dead_letter'
     ORDER BY updated_at DESC, id`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    jobType: row.job_type,
    attempts: Number(row.attempts),
    lastError: row.last_error,
  }));
}

async function recordOperatorEvent(
  db: Database,
  tenantId: string,
  actor: string,
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO operator_events (
      id, tenant_id, actor, action, target_type, target_id, details
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      randomUUID(),
      tenantId,
      actor,
      action,
      targetType,
      targetId,
      JSON.stringify(details),
    ],
  );
}

export async function replayDeadLetter(
  db: Database,
  tenantId: string,
  jobId: string,
  actor: string,
  resetCheckpoint = false,
): Promise<void> {
  if (!actor) throw new Error("operator actor is required");
  await withTransaction(db, async (tx) => {
    const result = await tx.query(
      `UPDATE jobs SET status = 'pending', attempts = 0, run_after = now(),
        lease_owner = NULL, lease_expires_at = NULL, fence_token = fence_token + 1,
        last_error = NULL, checkpoint = CASE WHEN $3 THEN NULL ELSE checkpoint END,
        completed_at = NULL, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status = 'dead_letter'`,
      [jobId, tenantId, resetCheckpoint],
    );
    if (result.rowCount !== 1) throw new Error("unknown dead-letter job");
    await recordOperatorEvent(tx, tenantId, actor, "job.replay", "job", jobId, {
      resetCheckpoint,
    });
  });
}

export async function setScopeEnabled(
  db: Database,
  tenantId: string,
  scopeId: string,
  enabled: boolean,
  actor: string,
): Promise<void> {
  if (!actor) throw new Error("operator actor is required");
  await withTransaction(db, async (tx) => {
    const result = await tx.query(
      `UPDATE ingestion_scopes SET enabled = $3, config_version = config_version + 1,
        updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [scopeId, tenantId, enabled],
    );
    if (result.rowCount !== 1) throw new Error(`unknown scope: ${scopeId}`);
    await recordOperatorEvent(
      tx,
      tenantId,
      actor,
      enabled ? "scope.resume" : "scope.pause",
      "scope",
      scopeId,
    );
  });
}
