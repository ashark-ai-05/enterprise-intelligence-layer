/**
 * The indexed retrieval arm.
 *
 * Reads through `listAuthorizedChunks` — the canonical authorized-chunks API —
 * so the ACL predicate exists in exactly one SQL path. This arm never writes an
 * authorization clause of its own: a second predicate is a second thing to keep
 * correct, and the one that drifts is the one that leaks.
 *
 * → src/security/acl.ts, docs/06-retrieval.md
 */

import { type AuthorizedChunk, listAuthorizedChunks } from "../security/acl.js";
import type { Database } from "../storage/database.js";
import { decorateHits } from "./decorate.js";
import { toPrincipalRefs } from "./principals.js";
import { parsePhrase } from "./query-filters.js";
import { tokenize, tokenizeCode } from "./stub-arms.js";
import type {
  RetrievalArm,
  RetrievalHit,
  RetrievalQuery,
  Viewer,
} from "./types.js";

export interface IndexedArmOptions {
  readonly tenantId: string;
  /** Arm name; defaults to `lexical-strict` so the query classifier weights it. */
  readonly name?: string;
}

interface ScoredResource {
  readonly hit: RetrievalHit;
  readonly score: number;
}

/**
 * Score a chunk against the query terms.
 *
 * Term coverage with a small bonus for repeated matches. This is deliberately
 * *not* BM25: Postgres `ts_rank` is not BM25 either (no IDF, no length
 * normalisation), and implementing real BM25 is gated on the evaluation harness
 * so the change can be measured rather than guessed at. → docs/06 "The BM25 gap"
 */
function scoreChunk(
  chunk: AuthorizedChunk,
  terms: readonly string[],
  codeTerms: readonly string[],
): number {
  const haystack =
    chunk.source === "git" ? tokenizeCode(chunk.text) : tokenize(chunk.text);
  const present = new Set(haystack);
  const wanted = chunk.source === "git" ? codeTerms : terms;
  if (wanted.length === 0) return 0;

  let matched = 0;
  for (const term of wanted) if (present.has(term)) matched += 1;
  if (matched === 0) return 0;

  // Coverage dominates; frequency breaks ties without letting a long chunk win
  // on repetition alone.
  const coverage = matched / wanted.length;
  const frequency = haystack.filter((token) => wanted.includes(token)).length;
  return coverage * 100 + Math.min(frequency, 10);
}

/**
 * Lexical retrieval over indexed, authorized, published chunks.
 *
 * **Scoring runs in process, over the caller's authorized chunk set.** That is
 * correct and it is not scalable: it is linear in the size of what the viewer
 * can see. It is honest at the current corpus scale (hundreds to low thousands
 * of objects) and it must be replaced by a real lexical projection — a
 * `tsvector` column with a GIN index, and the ACL predicate composed into that
 * SQL — before any corpus of consequence. The `lexical` projection name already
 * exists in the publication contract; the index behind it does not yet.
 */
export class IndexedLexicalArm implements RetrievalArm {
  readonly name: string;

  constructor(
    private readonly db: Database,
    private readonly options: IndexedArmOptions,
  ) {
    this.name = options.name ?? "lexical-strict";
  }

  isAvailable(): boolean {
    return true;
  }

  /** Adjacency-enforcing search for a quoted query. */
  async #phraseSearch(
    phrase: string,
    query: RetrievalQuery,
    viewer: Viewer,
  ): Promise<RetrievalHit[]> {
    const authorized = await listAuthorizedChunks(
      this.db,
      this.options.tenantId,
      toPrincipalRefs(viewer.principals),
      query.containers === undefined ? [] : [...query.containers],
    );
    if (authorized.length === 0) return [];

    const matching = await this.db.query<{ chunk_id: string; rank: number }>(
      `SELECT id AS chunk_id, ts_rank_cd(search_vector, phraseto_tsquery('simple', $1)) AS rank
         FROM resource_chunks
        WHERE deleted_at IS NULL
          AND id = ANY($2::uuid[])
          AND search_vector @@ phraseto_tsquery('simple', $1)
        ORDER BY rank DESC`,
      [phrase, authorized.map((chunk) => chunk.chunkId)],
    );

    const byChunk = new Map(authorized.map((chunk) => [chunk.chunkId, chunk]));
    const best = new Map<string, RetrievalHit>();

    for (const row of matching.rows) {
      const chunk = byChunk.get(row.chunk_id);
      if (chunk === undefined || best.has(chunk.resourceId)) continue;
      if (
        query.sources !== undefined &&
        query.sources.length > 0 &&
        !query.sources.includes(chunk.source)
      ) {
        continue;
      }
      best.set(chunk.resourceId, {
        id: chunk.sourceObjectId,
        source: chunk.source,
        container: chunk.containerId,
        title: chunk.stableKey,
        url: `eil://${chunk.source}/${chunk.sourceObjectId}`,
        snippet: chunk.text.slice(0, 300),
        syncedAt: new Date(0).toISOString(),
      });
    }

    return decorateHits(this.db, this.options.tenantId, [...best.values()]);
  }

  async search(query: RetrievalQuery, viewer: Viewer): Promise<RetrievalHit[]> {
    const { phrase, text } = parsePhrase(query.text);

    // A quoted query is a request for adjacency, and until now nothing
    // enforced it: the quotes were stripped by tokenising and the words matched
    // anywhere, in any order. `phraseto_tsquery` is what actually honours them.
    if (phrase !== null) {
      return this.#phraseSearch(phrase, query, viewer);
    }

    const terms = tokenize(text);
    const codeTerms = tokenizeCode(text);
    if (terms.length === 0 && codeTerms.length === 0) return [];

    const principals = toPrincipalRefs(viewer.principals);

    const chunks = await listAuthorizedChunks(
      this.db,
      this.options.tenantId,
      principals,
      query.containers === undefined ? [] : [...query.containers],
      query.text,
    );

    // Best chunk per resource. A page with five matching sections is one result,
    // not five — the alternative buries every other document under one verbose
    // page, which is the same failure the source-diversity cap prevents across
    // sources.
    const best = new Map<string, ScoredResource>();

    for (const chunk of chunks) {
      if (
        query.sources !== undefined &&
        query.sources.length > 0 &&
        !query.sources.includes(chunk.source)
      ) {
        continue;
      }

      const score = scoreChunk(chunk, terms, codeTerms);
      if (score === 0) continue;

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
          // Snippet comes from the chunk that actually matched, and only for
          // results being returned — never generated across all candidates.
          snippet: chunk.text.slice(0, 300),
          syncedAt: new Date(0).toISOString(),
        },
      });
    }

    const ranked = [...best.values()]
      .sort((a, b) =>
        b.score !== a.score
          ? b.score - a.score
          : a.hit.id < b.hit.id
            ? -1
            : a.hit.id > b.hit.id
              ? 1
              : 0,
      )
      .map((scored) => scored.hit);

    return decorateHits(this.db, this.options.tenantId, ranked);
  }
}
