import type { Database } from "../storage/database.js";
import type { Embedder } from "./types.js";

export interface BackfillResult {
  embedded: number;
  modelId: string;
}

export async function embedPendingChunks(
  db: Database,
  embedder: Embedder,
  batchSize = 32,
): Promise<BackfillResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("batchSize must be a positive integer");
  }
  let embedded = 0;
  while (true) {
    const pending = await db.query<{
      id: string;
      text: string;
      content_hash: string;
    }>(
      `SELECT ch.id, ch.text, ch.content_hash
       FROM resource_chunks ch
       LEFT JOIN chunk_vectors v ON v.chunk_id = ch.id AND v.model_id = $1
       WHERE ch.deleted_at IS NULL
         AND (v.chunk_id IS NULL OR v.content_hash <> ch.content_hash)
       ORDER BY ch.id
       LIMIT $2`,
      [embedder.id, batchSize],
    );
    if (pending.rows.length === 0) break;
    const vectors = await embedder.embed(pending.rows.map(({ text }) => text));
    if (vectors.length !== pending.rows.length) {
      throw new Error(
        "embedder returned a different vector count than requested",
      );
    }
    for (const [index, row] of pending.rows.entries()) {
      const vector = vectors[index];
      if (!vector || vector.length !== embedder.dimension) {
        throw new Error(
          `embedder returned an invalid ${embedder.dimension}-dimension vector`,
        );
      }
      await db.query(
        `INSERT INTO chunk_vectors (
          chunk_id, model_id, dimension, embedding, content_hash
        ) VALUES ($1, $2, $3, $4::float4[], $5)
        ON CONFLICT (chunk_id, model_id) DO UPDATE SET
          dimension = EXCLUDED.dimension,
          embedding = EXCLUDED.embedding,
          content_hash = EXCLUDED.content_hash,
          embedded_at = now()`,
        [
          row.id,
          embedder.id,
          embedder.dimension,
          [...vector],
          row.content_hash,
        ],
      );
      embedded += 1;
    }
  }
  return { embedded, modelId: embedder.id };
}
