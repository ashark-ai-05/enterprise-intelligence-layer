import { randomUUID } from "node:crypto";
import type { Database } from "../storage/database.js";
import { withTransaction } from "../storage/database.js";
import type { CreateScope, IngestionScope } from "./types.js";
import { createScopeSchema } from "./types.js";

interface ScopeRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  source: IngestionScope["source"];
  selector_kind: string;
  selector: Record<string, unknown> | string;
  refresh_mode: IngestionScope["refreshMode"];
  include_children: boolean;
  include_attachments: boolean;
  schedule: string | null;
  enabled: boolean;
  added_by: string;
  config_version: number;
  cursor: Record<string, unknown> | string | null;
  last_status: string | null;
  deletion_policy: IngestionScope["deletionPolicy"];
}

function jsonObject(
  value: Record<string, unknown> | string,
): Record<string, unknown> {
  return typeof value === "string"
    ? (JSON.parse(value) as Record<string, unknown>)
    : value;
}

function scopeFromRow(row: ScopeRow): IngestionScope {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    source: row.source,
    selectorKind: row.selector_kind,
    selector: jsonObject(row.selector),
    refreshMode: row.refresh_mode,
    includeChildren: row.include_children,
    includeAttachments: row.include_attachments,
    schedule: row.schedule,
    enabled: row.enabled,
    addedBy: row.added_by,
    configVersion: row.config_version,
    cursor: row.cursor === null ? null : jsonObject(row.cursor),
    lastStatus: row.last_status,
    deletionPolicy: row.deletion_policy,
  };
}

const scopeColumns = `
  id, tenant_id, source, selector_kind, selector, refresh_mode,
  include_children, include_attachments, schedule, enabled, added_by,
  config_version, cursor, last_status, deletion_policy
`;

export async function createScope(
  db: Database,
  input: CreateScope,
): Promise<IngestionScope> {
  const scope = createScopeSchema.parse(input);
  const id = randomUUID();
  const result = await db.query<ScopeRow>(
    `INSERT INTO ingestion_scopes (
      id, tenant_id, source, selector_kind, selector, refresh_mode,
      include_children, include_attachments, schedule, added_by, deletion_policy
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
    RETURNING ${scopeColumns}`,
    [
      id,
      scope.tenantId,
      scope.source,
      scope.selectorKind,
      JSON.stringify(scope.selector),
      scope.refreshMode,
      scope.includeChildren,
      scope.includeAttachments,
      scope.schedule ?? null,
      scope.addedBy,
      scope.deletionPolicy,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("scope insert returned no row");
  return scopeFromRow(row);
}

export async function listScopes(
  db: Database,
  tenantId: string,
): Promise<IngestionScope[]> {
  const result = await db.query<ScopeRow>(
    `SELECT ${scopeColumns} FROM ingestion_scopes WHERE tenant_id = $1 ORDER BY added_at, id`,
    [tenantId],
  );
  return result.rows.map(scopeFromRow);
}

export async function saveScopeCheckpoint(
  db: Database,
  tenantId: string,
  scopeId: string,
  cursor: Record<string, unknown>,
  status = "ok",
): Promise<void> {
  const result = await db.query(
    `UPDATE ingestion_scopes
     SET cursor = $2::jsonb, last_status = $3, last_success_at = now(), updated_at = now()
     WHERE id = $1 AND tenant_id = $4`,
    [scopeId, JSON.stringify(cursor), status, tenantId],
  );
  if (result.rowCount !== 1) throw new Error(`unknown scope: ${scopeId}`);
}

export interface AttachResourceInput {
  tenantId: string;
  source: string;
  sourceObjectId: string;
  canonicalUri: string;
  title: string;
}

export async function attachResourceToScope(
  db: Database,
  scopeId: string,
  input: AttachResourceInput,
): Promise<string> {
  return withTransaction(db, async (tx) => {
    const scope = await tx.query<{ tenant_id: string; source: string }>(
      "SELECT tenant_id, source FROM ingestion_scopes WHERE id = $1 AND enabled",
      [scopeId],
    );
    const owner = scope.rows[0];
    if (!owner) throw new Error(`unknown or disabled scope: ${scopeId}`);
    if (owner.tenant_id !== input.tenantId || owner.source !== input.source) {
      throw new Error("resource tenant/source must match its ingestion scope");
    }

    const id = randomUUID();
    const resource = await tx.query<{ id: string }>(
      `INSERT INTO resources (
        id, tenant_id, source, source_object_id, canonical_uri, title
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, source, source_object_id) DO UPDATE SET
        canonical_uri = EXCLUDED.canonical_uri,
        title = EXCLUDED.title,
        orphaned_at = NULL,
        updated_at = now()
      RETURNING id`,
      [
        id,
        input.tenantId,
        input.source,
        input.sourceObjectId,
        input.canonicalUri,
        input.title,
      ],
    );
    const resourceId = resource.rows[0]?.id;
    if (!resourceId) throw new Error("resource upsert returned no row");
    await tx.query(
      `INSERT INTO resource_scopes (resource_id, scope_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [resourceId, scopeId],
    );
    return resourceId;
  });
}

export async function removeScope(
  db: Database,
  tenantId: string,
  scopeId: string,
  disposition: "retain" | "purge",
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const exists = await tx.query<{ id: string }>(
      "SELECT id FROM ingestion_scopes WHERE id = $1 AND tenant_id = $2",
      [scopeId, tenantId],
    );
    if (!exists.rows[0]) throw new Error(`unknown scope: ${scopeId}`);

    // Capture the resources this scope is about to orphan, before the
    // resource_scopes rows disappear. A purge must be bounded to these: any
    // resource already orphaned by an earlier `retain` removal was retained
    // deliberately, and removing an unrelated scope must not destroy it.
    const orphanedByThisRemoval = await tx.query<{ resource_id: string }>(
      `SELECT rs.resource_id FROM resource_scopes rs
        WHERE rs.scope_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM resource_scopes other
            WHERE other.resource_id = rs.resource_id AND other.scope_id <> $1
          )`,
      [scopeId],
    );

    if (disposition === "retain") {
      await tx.query(
        `UPDATE resources SET orphaned_at = now()
         WHERE id IN (SELECT resource_id FROM resource_scopes WHERE scope_id = $1)
           AND NOT EXISTS (
             SELECT 1 FROM resource_scopes other
             WHERE other.resource_id = resources.id AND other.scope_id <> $1
           )`,
        [scopeId],
      );
    }

    await tx.query("DELETE FROM resource_scopes WHERE scope_id = $1", [
      scopeId,
    ]);
    await tx.query(
      "DELETE FROM ingestion_scopes WHERE id = $1 AND tenant_id = $2",
      [scopeId, tenantId],
    );

    if (disposition === "purge" && orphanedByThisRemoval.rows.length > 0) {
      await tx.query(
        `DELETE FROM resources
          WHERE id = ANY($1::uuid[])
            AND tenant_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM resource_scopes rs WHERE rs.resource_id = resources.id
            )`,
        [orphanedByThisRemoval.rows.map((row) => row.resource_id), tenantId],
      );
    }
  });
}
