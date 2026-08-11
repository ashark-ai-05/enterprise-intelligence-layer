import { randomUUID } from "node:crypto";
import type { SourceConnector } from "../connectors/types.js";
import { supersedePublishedGeneration } from "../publication/generations.js";
import { getScope } from "../scopes/service.js";
import type { Database } from "../storage/database.js";
import { withTransaction } from "../storage/database.js";
import { stableJson } from "./hash.js";

export interface ReconciliationCounters {
  indexed: number;
  present: number;
  detached: number;
  tombstoned: number;
}

export async function reconcileScope(
  db: Database,
  tenantId: string,
  scopeId: string,
  connector: SourceConnector,
): Promise<ReconciliationCounters> {
  const scope = await getScope(db, tenantId, scopeId);
  if (scope.source !== connector.source) {
    throw new Error(
      `connector ${connector.name} cannot reconcile ${scope.source} scope`,
    );
  }
  const currentIds = new Set(await connector.listCurrentIds(scope));
  const indexed = await db.query<{
    resource_id: string;
    source_object_id: string;
  }>(
    `SELECT rs.resource_id, r.source_object_id
     FROM resource_scopes rs
     JOIN resources r ON r.id = rs.resource_id
     WHERE rs.scope_id = $1 AND r.tenant_id = $2 AND r.deleted_at IS NULL`,
    [scopeId, tenantId],
  );
  const missing = indexed.rows.filter(
    ({ source_object_id }) => !currentIds.has(source_object_id),
  );
  const counters: ReconciliationCounters = {
    indexed: indexed.rows.length,
    present: indexed.rows.length - missing.length,
    detached: 0,
    tombstoned: 0,
  };

  await withTransaction(db, async (tx) => {
    for (const { resource_id: resourceId } of missing) {
      await tx.query(
        "DELETE FROM resource_scopes WHERE resource_id = $1 AND scope_id = $2",
        [resourceId, scopeId],
      );
      counters.detached += 1;
      const other = await tx.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM resource_scopes WHERE resource_id = $1) AS exists",
        [resourceId],
      );
      if (!other.rows[0]?.exists) {
        await tx.query(
          "UPDATE resources SET deleted_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2",
          [resourceId, tenantId],
        );
        await tx.query("DELETE FROM resource_aces WHERE resource_id = $1", [
          resourceId,
        ]);
        await tx.query(
          "DELETE FROM chunk_aces WHERE chunk_id IN (SELECT id FROM resource_chunks WHERE resource_id = $1)",
          [resourceId],
        );
        await tx.query(
          "UPDATE resource_chunks SET deleted_at = now(), updated_at = now() WHERE resource_id = $1",
          [resourceId],
        );
        await supersedePublishedGeneration(tx, tenantId, resourceId);
        counters.tombstoned += 1;
      }
    }

    await tx.query(
      `INSERT INTO ingestion_runs (
        id, tenant_id, scope_id, connector, status, counters, finished_at
      ) VALUES ($1, $2, $3, $4, 'succeeded', $5::jsonb, now())`,
      [
        randomUUID(),
        tenantId,
        scopeId,
        `${connector.name}:reconcile`,
        stableJson(counters),
      ],
    );
  });
  return counters;
}
