import { randomUUID } from "node:crypto";
import type { Database } from "../storage/database.js";
import { withTransaction } from "../storage/database.js";

export type DeletionDisposition = "tombstone" | "purge";

export async function requestDeletion(
  db: Database,
  tenantId: string,
  resourceId: string,
  disposition: DeletionDisposition,
  requestedBy: string,
  legalHold = false,
): Promise<string> {
  const resource = await db.query<{
    source: string;
    source_object_id: string;
    source_version: string;
  }>(
    "SELECT source, source_object_id, source_version FROM resources WHERE id = $1 AND tenant_id = $2",
    [resourceId, tenantId],
  );
  const row = resource.rows[0];
  if (!row) throw new Error("unknown resource");
  const id = randomUUID();
  await db.query(
    `INSERT INTO deletion_requests (
      id, tenant_id, resource_id, source, source_object_id, source_version,
      disposition, state, legal_hold, requested_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      tenantId,
      resourceId,
      row.source,
      row.source_object_id,
      row.source_version,
      disposition,
      legalHold ? "held" : "pending",
      legalHold,
      requestedBy,
    ],
  );
  return id;
}

export async function applyDeletion(
  db: Database,
  tenantId: string,
  requestId: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const request = await tx.query<{
      resource_id: string | null;
      disposition: DeletionDisposition;
      state: string;
      legal_hold: boolean;
    }>(
      `SELECT resource_id, disposition, state, legal_hold FROM deletion_requests
       WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [requestId, tenantId],
    );
    const row = request.rows[0];
    if (!row) throw new Error("unknown deletion request");
    if (row.legal_hold || row.state === "held") {
      throw new Error("deletion request is blocked by legal hold");
    }
    if (row.state === "applied") return;
    if (!row.resource_id) throw new Error("deletion target no longer exists");

    if (row.disposition === "tombstone") {
      await tx.query(
        `UPDATE resources SET deleted_at = now(), published_generation_id = NULL,
          updated_at = now() WHERE id = $1 AND tenant_id = $2`,
        [row.resource_id, tenantId],
      );
      await tx.query("DELETE FROM resource_aces WHERE resource_id = $1", [
        row.resource_id,
      ]);
      await tx.query(
        `DELETE FROM chunk_aces WHERE chunk_id IN (
          SELECT id FROM resource_chunks WHERE resource_id = $1
        )`,
        [row.resource_id],
      );
      await tx.query(
        "UPDATE resource_chunks SET deleted_at = now(), updated_at = now() WHERE resource_id = $1",
        [row.resource_id],
      );
      await tx.query(
        `UPDATE index_generations SET state = 'superseded', superseded_at = now()
         WHERE resource_id = $1 AND state = 'published'`,
        [row.resource_id],
      );
    } else {
      const target = await tx.query<{
        source: string;
        source_object_id: string;
      }>("SELECT source, source_object_id FROM resources WHERE id = $1", [
        row.resource_id,
      ]);
      const resource = target.rows[0];
      if (!resource) throw new Error("deletion target no longer exists");
      await tx.query("DELETE FROM resources WHERE id = $1 AND tenant_id = $2", [
        row.resource_id,
        tenantId,
      ]);
      await tx.query(
        `DELETE FROM raw_source_items
         WHERE tenant_id = $1 AND source = $2 AND source_object_id = $3`,
        [tenantId, resource.source, resource.source_object_id],
      );
    }
    await tx.query(
      `UPDATE deletion_requests SET state = 'applied', applied_at = now(),
        evidence = $2::jsonb WHERE id = $1`,
      [
        requestId,
        JSON.stringify({
          disposition: row.disposition,
          resourceId: row.resource_id,
        }),
      ],
    );
  });
}
