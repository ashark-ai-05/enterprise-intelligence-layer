import { randomUUID } from "node:crypto";
import type {
  AccessControlEntry,
  SourceConnector,
  ValidatedSourceItem,
} from "../connectors/types.js";
import {
  connectorCursorSchema,
  sourceItemSchema,
} from "../connectors/types.js";
import { normalizerFor } from "../normalization/normalizers.js";
import { replaceResourceChunks } from "../normalization/persist.js";
import { getScope, saveScopeCheckpoint } from "../scopes/service.js";
import type { Source } from "../scopes/types.js";
import type { Database } from "../storage/database.js";
import { withTransaction } from "../storage/database.js";
import { sha256, stableJson } from "./hash.js";

export interface IngestionCounters {
  discovered: number;
  created: number;
  contentUpdated: number;
  metadataUpdated: number;
  aclUpdated: number;
  deleted: number;
  unchanged: number;
}

interface ResourceState extends Record<string, unknown> {
  id: string;
  source_version: string;
  raw_hash: string | null;
  content_hash: string | null;
  metadata_hash: string | null;
  acl_hash: string | null;
  deleted_at: Date | null;
}

function emptyCounters(): IngestionCounters {
  return {
    discovered: 0,
    created: 0,
    contentUpdated: 0,
    metadataUpdated: 0,
    aclUpdated: 0,
    deleted: 0,
    unchanged: 0,
  };
}

async function replaceAces(
  db: Database,
  resourceId: string,
  aces: AccessControlEntry[],
): Promise<void> {
  await db.query("DELETE FROM resource_aces WHERE resource_id = $1", [
    resourceId,
  ]);
  for (const ace of aces) {
    await db.query(
      `INSERT INTO resource_aces (resource_id, principal_domain, principal_id, effect)
       VALUES ($1, $2, $3, $4)`,
      [resourceId, ace.domain, ace.principalId, ace.effect],
    );
  }
}

function canonicalAces(aces: AccessControlEntry[]): AccessControlEntry[] {
  const unique = new Map<string, AccessControlEntry>();
  for (const ace of aces) {
    unique.set(`${ace.domain}\u0000${ace.principalId}\u0000${ace.effect}`, ace);
  }
  return [...unique.values()].sort((left, right) =>
    stableJson(left).localeCompare(stableJson(right)),
  );
}

async function ingestItem(
  db: Database,
  tenantId: string,
  scopeId: string,
  source: Source,
  item: ValidatedSourceItem,
  counters: IngestionCounters,
): Promise<void> {
  const rawPayload = stableJson(item);
  const rawHash = sha256(rawPayload);
  const contentHash = sha256(item.body);
  const aces = canonicalAces(item.acl);
  const metadataHash = sha256(
    stableJson({
      canonicalUri: item.canonicalUri,
      metadata: item.metadata,
      title: item.title,
    }),
  );
  const aclHash = sha256(stableJson(aces));

  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO raw_source_items (
        id, tenant_id, scope_id, source, source_object_id, source_version, payload, payload_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        tenantId,
        scopeId,
        source,
        item.sourceObjectId,
        item.sourceVersion,
        rawPayload,
        rawHash,
      ],
    );

    const existing = await tx.query<ResourceState>(
      `SELECT id, source_version, raw_hash, content_hash, metadata_hash, acl_hash, deleted_at
       FROM resources
       WHERE tenant_id = $1 AND source = $2 AND source_object_id = $3
       FOR UPDATE`,
      [tenantId, source, item.sourceObjectId],
    );
    const current = existing.rows[0];
    const resourceId = current?.id ?? randomUUID();

    if (
      current &&
      current.source_version === item.sourceVersion &&
      current.raw_hash === rawHash
    ) {
      await tx.query(
        `INSERT INTO resource_scopes (resource_id, scope_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [resourceId, scopeId],
      );
      counters.unchanged += 1;
      return;
    }

    if (item.deleted) {
      if (!current) {
        counters.unchanged += 1;
        return;
      }
      await tx.query(
        `UPDATE resources SET
          source_version = $2, raw_hash = $3, deleted_at = now(), indexed_at = now(), updated_at = now()
         WHERE id = $1`,
        [resourceId, item.sourceVersion, rawHash],
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
      counters.deleted += 1;
      return;
    }

    if (!current) {
      await tx.query(
        `INSERT INTO resources (
          id, tenant_id, source, source_object_id, canonical_uri, title, source_version,
          body, metadata, raw_hash, content_hash, metadata_hash, acl_hash,
          source_updated_at, indexed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, now()
        )`,
        [
          resourceId,
          tenantId,
          source,
          item.sourceObjectId,
          item.canonicalUri,
          item.title,
          item.sourceVersion,
          item.body,
          stableJson(item.metadata),
          rawHash,
          contentHash,
          metadataHash,
          aclHash,
          item.sourceUpdatedAt,
        ],
      );
      await replaceAces(tx, resourceId, aces);
      await replaceResourceChunks(
        tx,
        resourceId,
        normalizerFor(source).normalize(item),
      );
      counters.created += 1;
      counters.contentUpdated += 1;
      counters.metadataUpdated += 1;
      counters.aclUpdated += 1;
    } else {
      const contentChanged =
        current.content_hash !== contentHash || current.deleted_at !== null;
      const metadataChanged =
        current.metadata_hash !== metadataHash || current.deleted_at !== null;
      const aclChanged =
        current.acl_hash !== aclHash || current.deleted_at !== null;
      await tx.query(
        `UPDATE resources SET
          canonical_uri = $2, title = $3, source_version = $4,
          body = CASE WHEN $5 THEN $6 ELSE body END,
          metadata = CASE WHEN $7 THEN $8::jsonb ELSE metadata END,
          raw_hash = $9, content_hash = $10, metadata_hash = $11, acl_hash = $12,
          source_updated_at = $13, deleted_at = NULL, indexed_at = now(), updated_at = now()
         WHERE id = $1`,
        [
          resourceId,
          item.canonicalUri,
          item.title,
          item.sourceVersion,
          contentChanged,
          item.body,
          metadataChanged,
          stableJson(item.metadata),
          rawHash,
          contentHash,
          metadataHash,
          aclHash,
          item.sourceUpdatedAt,
        ],
      );
      if (aclChanged) await replaceAces(tx, resourceId, aces);
      if (contentChanged || metadataChanged) {
        await replaceResourceChunks(
          tx,
          resourceId,
          normalizerFor(source).normalize(item),
        );
      }
      if (contentChanged) counters.contentUpdated += 1;
      if (metadataChanged) counters.metadataUpdated += 1;
      if (aclChanged) counters.aclUpdated += 1;
      if (!contentChanged && !metadataChanged && !aclChanged)
        counters.unchanged += 1;
    }

    await tx.query(
      `INSERT INTO resource_scopes (resource_id, scope_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [resourceId, scopeId],
    );
  });
}

export async function ingestScope(
  db: Database,
  tenantId: string,
  scopeId: string,
  connector: SourceConnector,
): Promise<IngestionCounters> {
  const scope = await getScope(db, tenantId, scopeId);
  if (!scope.enabled) throw new Error(`scope is disabled: ${scopeId}`);
  if (scope.source !== connector.source) {
    throw new Error(
      `connector ${connector.name} cannot ingest ${scope.source} scope`,
    );
  }

  const runId = randomUUID();
  await db.query(
    `INSERT INTO ingestion_runs (id, tenant_id, scope_id, connector, status)
     VALUES ($1, $2, $3, $4, 'running')`,
    [runId, tenantId, scopeId, connector.name],
  );
  const counters = emptyCounters();

  try {
    const cursor =
      scope.cursor === null ? null : connectorCursorSchema.parse(scope.cursor);
    const batch = await connector.read(scope, cursor);
    counters.discovered = batch.items.length;
    for (const candidate of batch.items) {
      const item = sourceItemSchema.parse(candidate);
      await ingestItem(db, tenantId, scopeId, connector.source, item, counters);
    }
    await saveScopeCheckpoint(db, tenantId, scopeId, batch.nextCursor);
    await db.query(
      `UPDATE ingestion_runs
       SET status = 'succeeded', counters = $2::jsonb, finished_at = now()
       WHERE id = $1`,
      [runId, stableJson(counters)],
    );
    return counters;
  } catch (error) {
    await db.query(
      `UPDATE ingestion_runs
       SET status = 'failed', error_code = $2, finished_at = now()
       WHERE id = $1`,
      [runId, error instanceof Error ? error.name : "UnknownError"],
    );
    throw error;
  }
}
