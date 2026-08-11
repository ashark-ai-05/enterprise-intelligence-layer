/**
 * Judgments that are not link-derived.
 *
 * The generated corpus builds each relevance judgment and each link edge in the
 * same loop from the same ids: the relevant set for query *n* is exactly
 * `{issue n} ∪ neighbours(issue n)`. Graph expansion therefore recovers it
 * almost by construction, and the resulting recall@10 of 0.983 measures
 * *"expansion walks the generator's links correctly"* — a real capability test,
 * but close to circular as a measure of retrieval quality.
 *
 * These judgments break that circle. Each one targets a **single** document,
 * using wording from that document's own body, with no link involved and
 * nothing for graph expansion to contribute. What they measure is whether the
 * platform can find a thing on its own merits.
 *
 * Queries are derived from the *ingested* text rather than from the generator's
 * internals, so this stays honest if the generator changes.
 *
 * A judgment is only kept when its query contains a term that is **rare in the
 * corpus**. Without that filter the derivation produces unanswerable queries:
 * every generated wiki page shares the sentence "uses bounded retries and
 * observable failure modes", so a query built from it matches sixty documents
 * equally while the judgment names one. Scoring against that measures nothing
 * but which arbitrary document happened to sort first — a degenerate query set
 * that looks like a retrieval result.
 *
 * → docs/09-evaluation.md, src/eval/corpus-gate.ts
 */

import type { Database } from "../storage/database.js";
import type { GoldenPair } from "./metrics.js";

/** Words too common in this corpus to identify anything. */
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "uses",
  "service",
  "export",
  "function",
  "return",
  "attempt",
  "this",
  "that",
  "from",
  "into",
]);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

export interface IndependentJudgmentOptions {
  /** How many documents of each kind to build a judgment for. */
  readonly perSource?: number;
  /** A term must appear in at most this many documents to count as discriminating. */
  readonly maxDocumentFrequency?: number;
}

/** Document frequency per term, over the chunk text of one source. */
async function documentFrequency(
  db: Database,
  tenantId: string,
  source: string,
): Promise<Map<string, number>> {
  const rows = await db.query<{ source_object_id: string; text: string }>(
    `SELECT r.source_object_id, ch.text
       FROM resource_chunks ch
       JOIN resources r ON r.id = ch.resource_id
      WHERE r.tenant_id = $1 AND r.source = $2
        AND r.deleted_at IS NULL AND ch.deleted_at IS NULL`,
    [tenantId, source],
  );

  const perDocument = new Map<string, Set<string>>();
  for (const row of rows.rows) {
    const words = perDocument.get(row.source_object_id) ?? new Set<string>();
    for (const word of contentWords(row.text)) words.add(word);
    perDocument.set(row.source_object_id, words);
  }

  const frequency = new Map<string, number>();
  for (const words of perDocument.values()) {
    for (const word of words)
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  return frequency;
}

/**
 * Build single-target judgments from ingested body text.
 *
 * Deliberately excludes the title: matching a document by its own title is a
 * lookup, not retrieval, and the existing judgments already cover that case.
 */
export async function deriveIndependentJudgments(
  db: Database,
  tenantId: string,
  options: IndependentJudgmentOptions = {},
): Promise<GoldenPair[]> {
  const perSource = options.perSource ?? 10;
  const maxDocumentFrequency = options.maxDocumentFrequency ?? 3;
  const pairs: GoldenPair[] = [];

  for (const source of ["confluence", "git"] as const) {
    const frequency = await documentFrequency(db, tenantId, source);
    const rows = await db.query<{
      source_object_id: string;
      title: string;
      text: string;
    }>(
      `SELECT r.source_object_id, r.title, ch.text
         FROM resource_chunks ch
         JOIN resources r ON r.id = ch.resource_id
        WHERE r.tenant_id = $1
          AND r.source = $2
          AND r.deleted_at IS NULL
          AND ch.deleted_at IS NULL
          AND length(ch.text) > 40
        ORDER BY r.source_object_id, ch.ordinal`,
      [tenantId, source],
    );

    const seen = new Set<string>();
    for (const row of rows.rows) {
      if (seen.size >= perSource) break;
      if (seen.has(row.source_object_id)) continue;

      const titleWords = new Set(contentWords(row.title));
      // Words from the body that do not appear in the title: this must be a
      // content match, not a title lookup.
      const bodyOnly = [
        ...new Set(
          contentWords(row.text).filter((word) => !titleWords.has(word)),
        ),
      ];

      // Keep the judgment only if something in it actually discriminates.
      const discriminating = bodyOnly.filter(
        (word) => (frequency.get(word) ?? 0) <= maxDocumentFrequency,
      );
      if (discriminating.length === 0) continue;

      // Lead with the rare terms, then pad with context.
      const query = [
        ...discriminating,
        ...bodyOnly.filter((word) => !discriminating.includes(word)),
      ]
        .slice(0, 6)
        .join(" ");

      seen.add(row.source_object_id);
      pairs.push({
        query,
        relevant: [row.source_object_id],
        origin: "hand-written",
      });
    }
  }

  return pairs;
}
