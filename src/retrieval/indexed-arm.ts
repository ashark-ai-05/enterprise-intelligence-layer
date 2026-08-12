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
 * BM25 constants. The values from the original literature, recorded here
 * *before* any evaluation run and deliberately not tuned against it — a
 * constant fitted to the eval set is a fixture-tuned constant, which is the
 * failure this whole line of work exists to avoid.
 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

interface CorpusStatistics {
  /** Number of scored chunks in the authorized candidate set. */
  readonly n: number;
  /** Chunks containing each term, within that set. */
  readonly documentFrequency: ReadonlyMap<string, number>;
  /** Mean chunk length in tokens. */
  readonly averageLength: number;
}

/**
 * Score a chunk with BM25 over statistics from the authorized candidate set.
 *
 * Replaces `coverage * 100 + min(frequency, 10)`, which had no notion of term
 * rarity or document length and therefore tied constantly: measured on the
 * corrected corpus, 28 of 30 stress queries had their top two results on
 * *identical* scores, leaving the order to an alphabetical id tie-break. Every
 * downstream ranking policy was then deciding ties the scorer never resolved.
 *
 * Two deliberate deviations from textbook BM25, both consequences of where the
 * statistics come from:
 *
 * 1. **Statistics are local to the authorized candidate set**, not the corpus.
 *    That is required, not merely convenient: computing them over all documents
 *    would make a viewer's ranking depend on documents they cannot see, which
 *    leaks corpus facts across an ACL boundary.
 * 2. **The candidate set is already term-filtered.** `listAuthorizedChunks`
 *    pre-filters with an OR `to_tsquery`, so every candidate contains at least
 *    one query term and no candidate has df 0. IDF here therefore measures
 *    rarity *among documents that matched*, which is the discrimination we
 *    actually want, but it is not corpus IDF and must not be described as such.
 */
function bm25Score(
  tokens: readonly string[],
  wanted: readonly string[],
  stats: CorpusStatistics,
): number {
  if (wanted.length === 0 || tokens.length === 0) return 0;

  const frequency = new Map<string, number>();
  for (const token of tokens)
    frequency.set(token, (frequency.get(token) ?? 0) + 1);

  const length = tokens.length;
  const normalisation =
    stats.averageLength === 0 ? 1 : length / stats.averageLength;

  let score = 0;
  // Unique terms: a query repeating a word must not be paid for it twice.
  for (const term of new Set(wanted)) {
    const termFrequency = frequency.get(term);
    if (termFrequency === undefined) continue;

    const df = stats.documentFrequency.get(term) ?? 0;
    const idf = Math.log(
      1 + (stats.n - df + 0.5) / (df + 0.5),
    );
    const saturation =
      termFrequency +
      BM25_K1 * (1 - BM25_B + BM25_B * normalisation);
    score += idf * ((termFrequency * (BM25_K1 + 1)) / saturation);
  }
  return score;
}

/** Tokenise as the arm scores: code tokens for git, prose tokens otherwise. */
function tokensFor(chunk: AuthorizedChunk): string[] {
  return chunk.source === "git" ? tokenizeCode(chunk.text) : tokenize(chunk.text);
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

    // Tokenise once. BM25 needs document frequency and average length across the
    // candidate set, so the set has to be walked before anything can be scored —
    // and re-tokenising per chunk in both passes would double the cost of the
    // most expensive step.
    const scorable: { chunk: AuthorizedChunk; tokens: string[] }[] = [];
    for (const chunk of chunks) {
      if (
        query.sources !== undefined &&
        query.sources.length > 0 &&
        !query.sources.includes(chunk.source)
      ) {
        continue;
      }
      scorable.push({ chunk, tokens: tokensFor(chunk) });
    }

    const documentFrequency = new Map<string, number>();
    let totalLength = 0;
    for (const { tokens } of scorable) {
      totalLength += tokens.length;
      // Presence, not count: document frequency counts documents, not mentions.
      for (const token of new Set(tokens)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
    const stats: CorpusStatistics = {
      n: scorable.length,
      documentFrequency,
      averageLength:
        scorable.length === 0 ? 0 : totalLength / scorable.length,
    };

    // Best chunk per resource. A page with five matching sections is one result,
    // not five — the alternative buries every other document under one verbose
    // page, which is the same failure the source-diversity cap prevents across
    // sources.
    const best = new Map<string, ScoredResource>();

    for (const { chunk, tokens } of scorable) {
      const score = bm25Score(
        tokens,
        chunk.source === "git" ? codeTerms : terms,
        stats,
      );
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
