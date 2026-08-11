import { randomUUID } from "node:crypto";
import type { Database } from "../storage/database.js";
import { withTransaction } from "../storage/database.js";

export const CORE_PROJECTIONS = ["catalog", "acl", "lexical"] as const;

export interface StageGenerationInput {
  tenantId: string;
  resourceId: string;
  parserVersion: string;
  chunkerVersion: string;
  requiredProjections: string[];
}

export async function stageGeneration(
  db: Database,
  input: StageGenerationInput,
): Promise<string> {
  const resource = await db.query<{
    source_version: string;
    content_hash: string;
    metadata_hash: string;
    acl_hash: string;
  }>(
    `SELECT source_version, content_hash, metadata_hash, acl_hash
     FROM resources WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [input.resourceId, input.tenantId],
  );
  const row = resource.rows[0];
  if (!row?.content_hash || !row.metadata_hash || !row.acl_hash) {
    throw new Error("cannot stage an absent, deleted, or incomplete resource");
  }
  const required = [...new Set(input.requiredProjections)].sort();
  if (required.length === 0)
    throw new Error("at least one projection is required");
  const result = await db.query<{ id: string }>(
    `INSERT INTO index_generations (
      id, tenant_id, resource_id, source_version, content_hash, metadata_hash, acl_hash,
      parser_version, chunker_version, required_projections, state
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], 'staging')
    ON CONFLICT (
      resource_id, source_version, content_hash, metadata_hash, acl_hash,
      parser_version, chunker_version, required_projections
    )
    DO UPDATE SET id = index_generations.id
    RETURNING id`,
    [
      randomUUID(),
      input.tenantId,
      input.resourceId,
      row.source_version,
      row.content_hash,
      row.metadata_hash,
      row.acl_hash,
      input.parserVersion,
      input.chunkerVersion,
      required,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("generation staging returned no row");
  return id;
}

export async function markProjectionReady(
  db: Database,
  generationId: string,
  projection: string,
  generationKey: string,
  checksum: string,
): Promise<void> {
  const result = await db.query(
    `INSERT INTO generation_projections (
      generation_id, projection, generation_key, checksum
    ) SELECT id, $2, $3, $4 FROM index_generations
      WHERE id = $1 AND state = 'staging'
    ON CONFLICT (generation_id, projection) DO UPDATE SET
      generation_key = EXCLUDED.generation_key,
      checksum = EXCLUDED.checksum,
      ready_at = now()`,
    [generationId, projection, generationKey, checksum],
  );
  if (result.rowCount !== 1)
    throw new Error("generation is absent or no longer staging");
}

async function publishGenerationWithin(
  db: Database,
  tenantId: string,
  generationId: string,
): Promise<void> {
  const generation = await db.query<{
    resource_id: string;
    source_version: string;
    content_hash: string;
    metadata_hash: string;
    acl_hash: string;
    required_projections: string[];
  }>(
    `SELECT resource_id, source_version, content_hash, metadata_hash, acl_hash,
      required_projections
     FROM index_generations
     WHERE id = $1 AND tenant_id = $2 AND state = 'staging'
     FOR UPDATE`,
    [generationId, tenantId],
  );
  const manifest = generation.rows[0];
  if (!manifest) throw new Error("generation is absent or no longer staging");
  const resource = await db.query<{ matches: boolean }>(
    `SELECT (
      source_version = $3 AND content_hash = $4 AND metadata_hash = $5 AND acl_hash = $6
      AND deleted_at IS NULL
    ) AS matches
    FROM resources WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [
      manifest.resource_id,
      tenantId,
      manifest.source_version,
      manifest.content_hash,
      manifest.metadata_hash,
      manifest.acl_hash,
    ],
  );
  if (!resource.rows[0]?.matches) {
    throw new Error(
      "generation no longer matches the authoritative resource version",
    );
  }
  const ready = await db.query<{ projection: string }>(
    "SELECT projection FROM generation_projections WHERE generation_id = $1",
    [generationId],
  );
  const readySet = new Set(ready.rows.map(({ projection }) => projection));
  const missing = manifest.required_projections.filter(
    (projection) => !readySet.has(projection),
  );
  if (missing.length > 0) {
    throw new Error(`generation is missing projections: ${missing.join(", ")}`);
  }
  await db.query(
    `UPDATE index_generations SET state = 'superseded', superseded_at = now()
     WHERE resource_id = $1 AND state = 'published' AND id <> $2`,
    [manifest.resource_id, generationId],
  );
  await db.query(
    "UPDATE index_generations SET state = 'published', published_at = now() WHERE id = $1",
    [generationId],
  );
  await db.query(
    "UPDATE resources SET published_generation_id = $2 WHERE id = $1",
    [manifest.resource_id, generationId],
  );
}

export async function publishGeneration(
  db: Database,
  tenantId: string,
  generationId: string,
): Promise<void> {
  await withTransaction(db, (tx) =>
    publishGenerationWithin(tx, tenantId, generationId),
  );
}

export async function publishCoreGenerationInTransaction(
  db: Database,
  tenantId: string,
  resourceId: string,
): Promise<string> {
  const generationId = await stageGeneration(db, {
    tenantId,
    resourceId,
    parserVersion: "normalizers:v1",
    chunkerVersion: "structural:v1",
    requiredProjections: [...CORE_PROJECTIONS],
  });
  const existing = await db.query<{ state: string }>(
    "SELECT state FROM index_generations WHERE id = $1",
    [generationId],
  );
  if (existing.rows[0]?.state === "published") return generationId;
  const resource = await db.query<{
    content_hash: string;
    metadata_hash: string;
    acl_hash: string;
  }>(
    "SELECT content_hash, metadata_hash, acl_hash FROM resources WHERE id = $1",
    [resourceId],
  );
  const row = resource.rows[0];
  if (!row) throw new Error("resource disappeared while publishing");
  await markProjectionReady(
    db,
    generationId,
    "catalog",
    resourceId,
    row.metadata_hash,
  );
  await markProjectionReady(db, generationId, "acl", resourceId, row.acl_hash);
  await markProjectionReady(
    db,
    generationId,
    "lexical",
    resourceId,
    row.content_hash,
  );
  await publishGenerationWithin(db, tenantId, generationId);
  return generationId;
}

export async function publishCoreGeneration(
  db: Database,
  tenantId: string,
  resourceId: string,
): Promise<string> {
  return withTransaction(db, (tx) =>
    publishCoreGenerationInTransaction(tx, tenantId, resourceId),
  );
}

export async function supersedePublishedGeneration(
  db: Database,
  tenantId: string,
  resourceId: string,
): Promise<void> {
  await db.query(
    `UPDATE index_generations SET state = 'superseded', superseded_at = now()
     WHERE resource_id = $1 AND tenant_id = $2 AND state = 'published'`,
    [resourceId, tenantId],
  );
  await db.query(
    "UPDATE resources SET published_generation_id = NULL WHERE id = $1 AND tenant_id = $2",
    [resourceId, tenantId],
  );
}
