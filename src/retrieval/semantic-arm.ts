/**
 * Semantic retrieval over stored chunk vectors.
 *
 * The embeddings were already being written and nothing read them — the largest
 * piece of finished work in the repository doing nothing. This is the arm that
 * answers "where do we handle payment retries" when the document never uses the
 * word "retry".
 *
 * **Exact scan, deliberately.** Below roughly a million chunks a sequential
 * cosine over `float4[]` is tens of milliseconds and, being exact, has no
 * recall to lose. Approximate search buys nothing here and costs centroid
 * training, probe calibration and silent recall drift as the corpus grows.
 * → docs/adr/0011, docs/16
 *
 * ACL comes from `listAuthorizedChunks`, so the predicate stays in one SQL
 * path; vectors are then fetched for exactly those chunk ids.
 */

import type { Embedder } from "../embeddings/types.js";
import { listAuthorizedChunks } from "../security/acl.js";
import type { Database } from "../storage/database.js";
import { toPrincipalRefs } from "./principals.js";
import type {
  RetrievalArm,
  RetrievalHit,
  RetrievalQuery,
  Viewer,
} from "./types.js";

export interface SemanticArmOptions {
  readonly tenantId: string;
  readonly name?: string;
  /** Cosine below this is noise rather than a weak match. */
  readonly minSimilarity?: number;
  /** Results returned by this arm before fusion. */
  readonly limit?: number;
}

const DEFAULTS = { minSimilarity: 0.25, limit: 20 } as const;

/** Cosine similarity. Stored vectors are normalised, so this is a dot product. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const left = a[index] as number;
    const right = b[index] as number;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

export class SemanticArm implements RetrievalArm {
  readonly name: string;
  #available: boolean | null = null;

  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
    private readonly options: SemanticArmOptions,
  ) {
    this.name = options.name ?? "semantic";
  }

  /**
   * Available only once something has been embedded.
   *
   * Reporting available with an empty vector table would make every query pay
   * for an embedding and return nothing, which reads as "semantic search is
   * broken" rather than "nothing has been embedded yet".
   */
  isAvailable(): boolean {
    return this.#available !== false;
  }

  async search(query: RetrievalQuery, viewer: Viewer): Promise<RetrievalHit[]> {
    const minSimilarity = this.options.minSimilarity ?? DEFAULTS.minSimilarity;
    const limit = query.limit ?? this.options.limit ?? DEFAULTS.limit;

    const counted = await this.db.query<{ count: string }>(
      "SELECT count(*) AS count FROM chunk_vectors WHERE model_id = $1",
      [this.embedder.id],
    );
    if (Number(counted.rows[0]?.count ?? 0) === 0) {
      this.#available = false;
      return [];
    }
    this.#available = true;

    // Authorized chunks first: this is the ACL boundary, and it also bounds the
    // scan to what the viewer can see rather than the whole corpus.
    const authorized = await listAuthorizedChunks(
      this.db,
      this.options.tenantId,
      toPrincipalRefs(viewer.principals),
      query.containers === undefined ? [] : [...query.containers],
    );
    if (authorized.length === 0) return [];

    const byChunk = new Map(authorized.map((chunk) => [chunk.chunkId, chunk]));
    const vectors = await this.db.query<{
      chunk_id: string;
      embedding: number[] | string;
    }>(
      `SELECT chunk_id, embedding FROM chunk_vectors
        WHERE model_id = $1 AND chunk_id = ANY($2::uuid[])`,
      [this.embedder.id, [...byChunk.keys()]],
    );
    if (vectors.rows.length === 0) return [];

    const [queryVector] = await this.embedder.embed([query.text]);
    if (queryVector === undefined) return [];
    const probe = Array.from(queryVector);

    // Best chunk per resource: a long document should not occupy five slots
    // because five of its sections are individually similar.
    const best = new Map<string, { score: number; hit: RetrievalHit }>();

    for (const row of vectors.rows) {
      const chunk = byChunk.get(row.chunk_id);
      if (chunk === undefined) continue;
      if (
        query.sources !== undefined &&
        query.sources.length > 0 &&
        !query.sources.includes(chunk.source)
      ) {
        continue;
      }

      const stored =
        typeof row.embedding === "string"
          ? parseVector(row.embedding)
          : row.embedding;
      const score = cosine(probe, stored);
      if (score < minSimilarity) continue;

      const existing = best.get(chunk.resourceId);
      if (existing !== undefined && existing.score >= score) continue;

      best.set(chunk.resourceId, {
        score,
        hit: {
          id: chunk.sourceObjectId,
          source: chunk.source,
          container: chunk.containerId,
          title: chunk.stableKey,
          url: `eil://${chunk.source}/${chunk.sourceObjectId}`,
          snippet: chunk.text.slice(0, 300),
          syncedAt: new Date(0).toISOString(),
        },
      });
    }

    return [...best.values()]
      .sort((a, b) =>
        b.score !== a.score
          ? b.score - a.score
          : a.hit.id < b.hit.id
            ? -1
            : a.hit.id > b.hit.id
              ? 1
              : 0,
      )
      .slice(0, limit)
      .map((entry) => entry.hit);
  }
}

/** Postgres renders float4[] as `{1,2,3}` over some drivers. */
function parseVector(value: string): number[] {
  return value
    .replace(/^[{[]|[}\]]$/g, "")
    .split(",")
    .map(Number);
}
