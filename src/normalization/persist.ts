import { randomUUID } from "node:crypto";
import type { AccessControlEntry } from "../connectors/types.js";
import { sha256, stableJson } from "../ingestion/hash.js";
import type { Database } from "../storage/database.js";
import type { NormalizedChunk } from "./types.js";

function canonicalAces(
  aces: AccessControlEntry[] | undefined,
): AccessControlEntry[] {
  if (!aces) return [];
  const unique = new Map<string, AccessControlEntry>();
  for (const ace of aces) {
    unique.set(`${ace.domain}\u0000${ace.principalId}\u0000${ace.effect}`, ace);
  }
  return [...unique.values()].sort((left, right) =>
    stableJson(left).localeCompare(stableJson(right)),
  );
}

export async function replaceResourceChunks(
  db: Database,
  resourceId: string,
  chunks: NormalizedChunk[],
): Promise<void> {
  const uniqueKeys = new Set(chunks.map(({ stableKey }) => stableKey));
  if (uniqueKeys.size !== chunks.length) {
    throw new Error(
      `normalizer produced duplicate stable chunk keys for resource ${resourceId}`,
    );
  }
  const activeKeys: string[] = [];
  for (const [ordinal, chunk] of chunks.entries()) {
    activeKeys.push(chunk.stableKey);
    const stored = await db.query<{ id: string }>(
      `INSERT INTO resource_chunks (
        id, resource_id, stable_key, ordinal, kind, text, location, content_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      ON CONFLICT (resource_id, stable_key) DO UPDATE SET
        ordinal = EXCLUDED.ordinal,
        kind = EXCLUDED.kind,
        text = EXCLUDED.text,
        location = EXCLUDED.location,
        content_hash = EXCLUDED.content_hash,
        deleted_at = NULL,
        updated_at = now()
      RETURNING id`,
      [
        randomUUID(),
        resourceId,
        chunk.stableKey,
        ordinal,
        chunk.kind,
        chunk.text,
        stableJson(chunk.location),
        sha256(chunk.text),
      ],
    );
    const chunkId = stored.rows[0]?.id;
    if (!chunkId) throw new Error("chunk upsert returned no row");
    await db.query("DELETE FROM chunk_aces WHERE chunk_id = $1", [chunkId]);
    for (const ace of canonicalAces(chunk.aclOverride)) {
      await db.query(
        `INSERT INTO chunk_aces (chunk_id, principal_domain, principal_id, effect)
         VALUES ($1, $2, $3, $4)`,
        [chunkId, ace.domain, ace.principalId, ace.effect],
      );
    }
  }

  if (activeKeys.length === 0) {
    await db.query(
      "UPDATE resource_chunks SET deleted_at = now(), updated_at = now() WHERE resource_id = $1 AND deleted_at IS NULL",
      [resourceId],
    );
    return;
  }
  await db.query(
    `UPDATE resource_chunks SET deleted_at = now(), updated_at = now()
     WHERE resource_id = $1 AND deleted_at IS NULL AND NOT (stable_key = ANY($2::text[]))`,
    [resourceId, activeKeys],
  );
}
