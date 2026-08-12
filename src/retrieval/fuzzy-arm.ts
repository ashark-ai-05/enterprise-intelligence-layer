/**
 * Partial words and misspellings.
 *
 * Two different problems that look like one:
 *
 *   - **Partial** — `retr` should find `retryPayment`. This is a prefix match,
 *     and Postgres does it natively with `to_tsquery('simple', 'retr:*')`,
 *     served by the existing GIN index.
 *   - **Misspelt** — `retrry` should also find it. No amount of prefix matching
 *     helps; the term has to be corrected first.
 *
 * Correction works against the corpus's own vocabulary rather than a dictionary
 * of English. In a codebase the vocabulary *is* identifiers — `handlePayment`,
 * `PGlite`, `nprobe` — and a general speller would reject the very words worth
 * searching for. `ts_stat` gives us that vocabulary directly.
 *
 * Neither `pg_trgm` nor `fuzzystrmatch` is available on the embedded profile
 * (verified), so similarity is computed here rather than in SQL.
 */

import { listAuthorizedChunks } from "../security/acl.js";
import type { Database } from "../storage/database.js";
import { decorateHits } from "./decorate.js";
import { toPrincipalRefs } from "./principals.js";
import { tokenize } from "./stub-arms.js";
import type {
  RetrievalArm,
  RetrievalHit,
  RetrievalQuery,
  Viewer,
} from "./types.js";

/** Character trigrams, padded so short words still produce them. */
export function trigrams(word: string): Set<string> {
  const padded = `  ${word.toLowerCase()} `;
  const out = new Set<string>();
  for (let index = 0; index < padded.length - 2; index += 1) {
    out.add(padded.slice(index, index + 3));
  }
  return out;
}

/** Jaccard similarity over trigrams: 1 is identical, 0 shares nothing. */
export function trigramSimilarity(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export interface FuzzyArmOptions {
  readonly tenantId: string;
  readonly name?: string;
  /** Minimum trigram similarity for a correction to be offered. */
  readonly minSimilarity?: number;
  /** Corrections considered per query term. */
  readonly maxCorrections?: number;
  readonly limit?: number;
}

/**
 * Threshold chosen from measurement, not taste.
 *
 *   real typos        0.273 – 0.667   (chrage~charge, postgers~postgres, atempt~attempt)
 *   unrelated words   0.000 – 0.071   (charge~storage, retry~onboarding)
 *
 * 0.25 sits in a wide empty gap. An earlier 0.4 excluded transpositions, which
 * are among the most common typos people actually make. False corrections are
 * cheap here: they only add alternatives to an OR query, and this arm is
 * weighted below every exact arm.
 */
const DEFAULTS = { minSimilarity: 0.25, maxCorrections: 3, limit: 20 } as const;

/** Distinct lexemes in the corpus — the vocabulary users are actually searching. */
export async function corpusVocabulary(
  db: Database,
  limit = 20_000,
): Promise<string[]> {
  try {
    const result = await db.query<{ word: string }>(
      `SELECT word FROM ts_stat('SELECT search_vector FROM resource_chunks WHERE deleted_at IS NULL')
        ORDER BY ndoc DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.word);
  } catch {
    // ts_stat is unavailable or the projection is missing: degrade to no
    // corrections rather than failing the query.
    return [];
  }
}

export interface Correction {
  readonly term: string;
  readonly corrected: string;
  readonly similarity: number;
}

/**
 * Suggest corpus terms for a query term.
 *
 * A term already present in the vocabulary is left alone — correcting a word
 * that exists would turn a precise query into a fuzzy one.
 */
export function correctTerm(
  term: string,
  vocabulary: readonly string[],
  minSimilarity: number,
  maxCorrections: number,
): Correction[] {
  if (vocabulary.includes(term)) return [];

  const scored: Correction[] = [];
  for (const candidate of vocabulary) {
    // Length gate first: it is far cheaper than trigram similarity and removes
    // most of the vocabulary before the expensive comparison.
    if (Math.abs(candidate.length - term.length) > 3) continue;
    const similarity = trigramSimilarity(term, candidate);
    if (similarity >= minSimilarity)
      scored.push({ term, corrected: candidate, similarity });
  }

  return scored
    .sort((a, b) =>
      b.similarity !== a.similarity
        ? b.similarity - a.similarity
        : a.corrected < b.corrected
          ? -1
          : 1,
    )
    .slice(0, maxCorrections);
}

/**
 * Lexical retrieval that tolerates partial and misspelt words.
 *
 * Ranked below the exact arms by the query classifier: a fuzzy match is weaker
 * evidence than an exact one, and it should fill gaps rather than displace
 * precise results.
 */
export class FuzzyLexicalArm implements RetrievalArm {
  readonly name: string;

  constructor(
    private readonly db: Database,
    private readonly options: FuzzyArmOptions,
  ) {
    this.name = options.name ?? "lexical-fuzzy";
  }

  isAvailable(): boolean {
    return true;
  }

  /** Terms to search: the originals, prefix-expanded, plus corpus corrections. */
  async expand(
    text: string,
  ): Promise<{ terms: string[]; corrections: Correction[] }> {
    const minSimilarity = this.options.minSimilarity ?? DEFAULTS.minSimilarity;
    const maxCorrections =
      this.options.maxCorrections ?? DEFAULTS.maxCorrections;

    const original = tokenize(text);
    if (original.length === 0) return { terms: [], corrections: [] };

    const vocabulary = await corpusVocabulary(this.db);
    const corrections: Correction[] = [];
    for (const term of original) {
      corrections.push(
        ...correctTerm(term, vocabulary, minSimilarity, maxCorrections),
      );
    }

    return {
      terms: [
        ...new Set([
          ...original,
          ...corrections.map((correction) => correction.corrected),
        ]),
      ],
      corrections,
    };
  }

  async search(query: RetrievalQuery, viewer: Viewer): Promise<RetrievalHit[]> {
    const limit = query.limit ?? this.options.limit ?? DEFAULTS.limit;
    const { terms } = await this.expand(query.text);
    if (terms.length === 0) return [];

    // `term:*` matches the term and anything it prefixes, which is what makes a
    // partial word work at all.
    const tsquery = terms
      .map((term) => `${term.replace(/[^a-z0-9]/gi, "")}:*`)
      .filter((term) => term.length > 2)
      .join(" | ");
    if (tsquery === "") return [];

    const authorized = await listAuthorizedChunks(
      this.db,
      this.options.tenantId,
      toPrincipalRefs(viewer.principals),
      query.containers === undefined ? [] : [...query.containers],
    );
    if (authorized.length === 0) return [];

    const matching = await this.db.query<{ chunk_id: string; rank: number }>(
      `SELECT id AS chunk_id, ts_rank_cd(search_vector, to_tsquery('simple', $1)) AS rank
         FROM resource_chunks
        WHERE deleted_at IS NULL
          AND id = ANY($2::uuid[])
          AND search_vector @@ to_tsquery('simple', $1)
        ORDER BY rank DESC`,
      [tsquery, authorized.map((chunk) => chunk.chunkId)],
    );

    const byChunk = new Map(authorized.map((chunk) => [chunk.chunkId, chunk]));
    const best = new Map<string, { rank: number; hit: RetrievalHit }>();

    for (const row of matching.rows) {
      const chunk = byChunk.get(row.chunk_id);
      if (chunk === undefined) continue;
      if (
        query.sources !== undefined &&
        query.sources.length > 0 &&
        !query.sources.includes(chunk.source)
      ) {
        continue;
      }
      const existing = best.get(chunk.resourceId);
      if (existing !== undefined && existing.rank >= row.rank) continue;

      best.set(chunk.resourceId, {
        rank: row.rank,
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

    const ranked = [...best.values()]
      .sort((a, b) =>
        b.rank !== a.rank
          ? b.rank - a.rank
          : a.hit.id < b.hit.id
            ? -1
            : a.hit.id > b.hit.id
              ? 1
              : 0,
      )
      .slice(0, limit)
      .map((entry) => entry.hit);

    return decorateHits(this.db, this.options.tenantId, ranked);
  }
}
