import { z } from "zod";
import type { Source } from "../scopes/types.js";
import type { Database } from "../storage/database.js";
import { withTransaction } from "../storage/database.js";
import { enqueueScopeSync } from "./scope-worker.js";

const durationPattern = /^(\d+)\s*(second|minute|hour|day)s?$/i;

export function scheduleSeconds(value: string): number {
  const match = durationPattern.exec(value.trim());
  if (!match) throw new Error(`unsupported schedule: ${value}`);
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("schedule duration must be positive");
  }
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === "second"
      ? 1
      : unit === "minute"
        ? 60
        : unit === "hour"
          ? 3_600
          : 86_400;
  return count * multiplier;
}

export interface ScheduleResult {
  scopeId: string;
  jobId: string;
  nextRunAt: Date;
}

interface DueScopeRow extends Record<string, unknown> {
  id: string;
  schedule: string | null;
  refresh_mode: "scheduled" | "continuous";
}

export async function scheduleDueScopes(
  db: Database,
  tenantId: string,
  now = new Date(),
  continuousIntervalSeconds = 60,
): Promise<ScheduleResult[]> {
  if (
    !Number.isInteger(continuousIntervalSeconds) ||
    continuousIntervalSeconds < 1
  ) {
    throw new Error("continuousIntervalSeconds must be a positive integer");
  }
  const due = await db.query<DueScopeRow>(
    `SELECT id, schedule, refresh_mode FROM ingestion_scopes
     WHERE tenant_id = $1 AND enabled
       AND refresh_mode IN ('scheduled', 'continuous')
       AND (next_run_at IS NULL OR next_run_at <= $2)
     ORDER BY next_run_at NULLS FIRST, id`,
    [tenantId, now.toISOString()],
  );
  const scheduled: ScheduleResult[] = [];
  for (const scope of due.rows) {
    const interval =
      scope.refresh_mode === "continuous"
        ? continuousIntervalSeconds
        : scheduleSeconds(scope.schedule ?? "");
    const nextRunAt = new Date(now.getTime() + interval * 1_000);
    const job = await enqueueScopeSync(
      db,
      tenantId,
      scope.id,
      `scope:${scope.id}:due:${now.toISOString()}`,
    );
    await db.query(
      `UPDATE ingestion_scopes SET next_run_at = $3, updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND enabled`,
      [scope.id, tenantId, nextRunAt.toISOString()],
    );
    scheduled.push({ scopeId: scope.id, jobId: job.id, nextRunAt });
  }
  return scheduled;
}

const rateBudgetSchema = z.object({
  tenantId: z.string().min(1),
  source: z.string().min(1),
  capacity: z.number().int().positive(),
  refillPerSecond: z.number().positive(),
});

export async function configureSourceRateBudget(
  db: Database,
  input: {
    tenantId: string;
    source: Source;
    capacity: number;
    refillPerSecond: number;
  },
  now = new Date(),
): Promise<void> {
  const value = rateBudgetSchema.parse(input);
  await db.query(
    `INSERT INTO source_rate_budgets
       (tenant_id, source, capacity, refill_per_second, tokens, refilled_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, source) DO UPDATE SET
       capacity = EXCLUDED.capacity,
       refill_per_second = EXCLUDED.refill_per_second,
       tokens = LEAST(source_rate_budgets.tokens, EXCLUDED.capacity),
       refilled_at = EXCLUDED.refilled_at,
       updated_at = now()`,
    [
      value.tenantId,
      value.source,
      value.capacity,
      value.refillPerSecond,
      value.capacity,
      now.toISOString(),
    ],
  );
}

export interface RatePermit {
  allowed: boolean;
  retryAt: Date | null;
}

export async function acquireSourceRatePermit(
  db: Database,
  tenantId: string,
  source: Source,
  now = new Date(),
): Promise<RatePermit> {
  return withTransaction(db, async (tx) => {
    const result = await tx.query<{
      capacity: number;
      refill_per_second: number;
      tokens: number;
      refilled_at: Date | string;
      blocked_until: Date | string | null;
    }>(
      `SELECT capacity, refill_per_second, tokens, refilled_at, blocked_until
       FROM source_rate_budgets WHERE tenant_id = $1 AND source = $2 FOR UPDATE`,
      [tenantId, source],
    );
    const row = result.rows[0];
    if (!row) return { allowed: true, retryAt: null };
    const blockedUntil =
      row.blocked_until === null ? null : new Date(row.blocked_until);
    if (blockedUntil && blockedUntil > now)
      return { allowed: false, retryAt: blockedUntil };
    const elapsed = Math.max(
      0,
      (now.getTime() - new Date(row.refilled_at).getTime()) / 1_000,
    );
    const tokens = Math.min(
      Number(row.capacity),
      Number(row.tokens) + elapsed * Number(row.refill_per_second),
    );
    if (tokens < 1) {
      const retryAt = new Date(
        now.getTime() +
          Math.ceil(((1 - tokens) / Number(row.refill_per_second)) * 1_000),
      );
      await tx.query(
        `UPDATE source_rate_budgets SET tokens = $3, refilled_at = $4, updated_at = now()
         WHERE tenant_id = $1 AND source = $2`,
        [tenantId, source, tokens, now.toISOString()],
      );
      return { allowed: false, retryAt };
    }
    await tx.query(
      `UPDATE source_rate_budgets SET tokens = $3, refilled_at = $4,
         blocked_until = NULL, updated_at = now()
       WHERE tenant_id = $1 AND source = $2`,
      [tenantId, source, tokens - 1, now.toISOString()],
    );
    return { allowed: true, retryAt: null };
  });
}
