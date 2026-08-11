import { z } from "zod";
import type { SourceConnector } from "../connectors/types.js";
import { type IngestionCounters, ingestScope } from "../ingestion/pipeline.js";
import {
  type ReconciliationCounters,
  reconcileScope,
} from "../ingestion/reconcile.js";
import { getScope } from "../scopes/service.js";
import type { IngestionScope } from "../scopes/types.js";
import type { Database } from "../storage/database.js";
import {
  claimJob,
  completeJob,
  deferJob,
  enqueueJob,
  failJob,
  saveJobCheckpoint,
} from "./queue.js";
import { acquireSourceRatePermit } from "./scheduler.js";

const payloadSchema = z.object({
  scopeId: z.string().uuid(),
  reconcile: z.boolean().default(true),
});

const checkpointSchema = z.object({
  phase: z.enum(["ingested"]),
  ingestion: z.record(z.number()),
});

export interface ConnectorRegistry {
  resolve(scope: IngestionScope): Promise<SourceConnector> | SourceConnector;
}

export class StaticConnectorRegistry implements ConnectorRegistry {
  constructor(
    private readonly connectors: ReadonlyMap<
      IngestionScope["source"],
      SourceConnector
    >,
  ) {}

  resolve(scope: IngestionScope): SourceConnector {
    const connector = this.connectors.get(scope.source);
    if (!connector)
      throw new Error(`no connector registered for ${scope.source}`);
    if (connector.source !== scope.source) {
      throw new Error(`registered connector does not serve ${scope.source}`);
    }
    return connector;
  }
}

export async function enqueueScopeSync(
  db: Database,
  tenantId: string,
  scopeId: string,
  idempotencyKey: string,
  options: { reconcile?: boolean; lane?: "live" | "backfill" } = {},
) {
  const scope = await getScope(db, tenantId, scopeId);
  if (!scope.enabled) throw new Error(`scope is disabled: ${scopeId}`);
  return enqueueJob(db, {
    tenantId,
    scopeId,
    jobType: "scope.sync",
    lane: options.lane ?? "live",
    payload: { scopeId, reconcile: options.reconcile ?? true },
    idempotencyKey,
  });
}

export interface ScopeWorkerResult {
  jobId: string;
  status: "completed" | "pending" | "dead_letter";
  ingestion?: IngestionCounters;
  reconciliation?: ReconciliationCounters;
  error?: string;
}

export async function runNextScopeJob(
  db: Database,
  tenantId: string,
  workerId: string,
  connectors: ConnectorRegistry,
  leaseSeconds = 300,
): Promise<ScopeWorkerResult | null> {
  let job = await claimJob(db, tenantId, workerId, leaseSeconds, [
    "scope.sync",
  ]);
  if (!job) return null;

  try {
    const payload = payloadSchema.parse(job.payload);
    if (job.scopeId !== payload.scopeId) {
      throw new Error("job payload scope does not match its queue scope");
    }
    const scope = await getScope(db, tenantId, payload.scopeId);
    if (!scope.enabled) throw new Error(`scope is disabled: ${scope.id}`);
    const permit = await acquireSourceRatePermit(db, tenantId, scope.source);
    if (!permit.allowed) {
      const deferred = await deferJob(
        db,
        job,
        permit.retryAt ?? new Date(Date.now() + 1_000),
        `source rate budget exhausted: ${scope.source}`,
      );
      return { jobId: job.id, status: deferred.status as "pending" };
    }
    const connector = await connectors.resolve(scope);
    const checkpoint =
      job.checkpoint === null ? null : checkpointSchema.parse(job.checkpoint);
    let ingestion: IngestionCounters | undefined;

    if (checkpoint === null) {
      ingestion = await ingestScope(db, tenantId, scope.id, connector, job);
      job = await saveJobCheckpoint(db, job, {
        phase: "ingested",
        ingestion,
      });
    }

    const reconciliation = payload.reconcile
      ? await reconcileScope(db, tenantId, scope.id, connector, job)
      : undefined;
    const completed = await completeJob(db, job);
    return {
      jobId: job.id,
      status: completed.status as "completed",
      ...(ingestion === undefined ? {} : { ingestion }),
      ...(reconciliation === undefined ? {} : { reconciliation }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await failJob(
      db,
      job,
      message,
      Math.min(300, 2 ** Math.max(0, job.attempts - 1)),
    );
    return {
      jobId: job.id,
      status: failed.status as "pending" | "dead_letter",
      error: message,
    };
  }
}
