/**
 * In-memory arms over a fixed corpus.
 *
 * These exist so the pipeline, the evaluation harness, the tool surface and the
 * demo can all run with no database, no network and no credentials. They are
 * deliberately simple, and each one models the *retrieval behaviour* of the arm
 * it stands in for rather than pretending to be it:
 *
 *   - strict lexical  — all terms must appear
 *   - loose lexical   — any term, more matches ranks higher
 *   - semantic        — token-overlap cosine, which behaves like an embedding
 *                       arm for ranking purposes: fuzzy, recall-oriented,
 *                       indifferent to exact wording
 *
 * Ranking differences between real and stub arms change positions, not the
 * pipeline's contract, so tests written against these stay meaningful when the
 * real arms land.
 */

import type {
  RetrievalArm,
  RetrievalHit,
  RetrievalQuery,
  Viewer,
} from "./types.js";

export interface CorpusDocument extends RetrievalHit {
  readonly body: string;
}

/** Lower-case alphanumeric tokens. Shared by every stub arm so they agree on what a term is. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Split identifiers into their parts, keeping the original.
 *
 * `getUserById` → `getuserbyid`, `get`, `user`, `by`, `id`. Without this a
 * search for `user` never finds `getUserById`, which is the single most common
 * complaint about code search.
 */
export function tokenizeCode(text: string): string[] {
  const tokens = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9_$.\/-]+/).filter(Boolean)) {
    tokens.add(raw.toLowerCase());
    for (const part of raw.split(/[_\-./]|(?<=[a-z0-9])(?=[A-Z])/)) {
      if (part.length > 0) tokens.add(part.toLowerCase());
    }
  }
  return [...tokens];
}

function inScope(document: CorpusDocument, query: RetrievalQuery): boolean {
  if (
    query.sources !== undefined &&
    query.sources.length > 0 &&
    !query.sources.includes(document.source)
  ) {
    return false;
  }
  if (
    query.containers !== undefined &&
    !query.containers.includes(document.container)
  ) {
    return false;
  }
  return true;
}

/**
 * Rank by a scoring function, dropping zero scores.
 *
 * Ties break by id so the order is total and reproducible — the pipeline's
 * determinism guarantee depends on its arms being deterministic too.
 */
function rank(
  corpus: readonly CorpusDocument[],
  query: RetrievalQuery,
  score: (document: CorpusDocument) => number,
): RetrievalHit[] {
  return corpus
    .filter((document) => inScope(document, query))
    .map((document) => ({ document, score: score(document) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.document.id < b.document.id
          ? -1
          : 1,
    )
    .map(({ document }) => {
      const { body: _body, ...hit } = document;
      return hit;
    });
}

export class StrictLexicalArm implements RetrievalArm {
  readonly name = "lexical-strict";
  constructor(private readonly corpus: readonly CorpusDocument[]) {}
  isAvailable(): boolean {
    return true;
  }
  async search(query: RetrievalQuery): Promise<RetrievalHit[]> {
    const terms = tokenize(query.text);
    if (terms.length === 0) return [];
    return rank(this.corpus, query, (document) => {
      const haystack = tokenize(`${document.title} ${document.body}`);
      const present = terms.every((term) => haystack.includes(term));
      if (!present) return 0;
      // Title matches outrank body matches; a page called "Retry policy" beats
      // one that mentions retries in passing.
      const titleTokens = tokenize(document.title);
      return 1 + terms.filter((term) => titleTokens.includes(term)).length;
    });
  }
}

export class LooseLexicalArm implements RetrievalArm {
  readonly name = "lexical-loose";
  constructor(private readonly corpus: readonly CorpusDocument[]) {}
  isAvailable(): boolean {
    return true;
  }
  async search(query: RetrievalQuery): Promise<RetrievalHit[]> {
    const terms = tokenize(query.text);
    if (terms.length === 0) return [];
    return rank(this.corpus, query, (document) => {
      const haystack = new Set(tokenize(`${document.title} ${document.body}`));
      return terms.filter((term) => haystack.has(term)).length;
    });
  }
}

export class CodeLexicalArm implements RetrievalArm {
  readonly name = "code-lexical";
  constructor(private readonly corpus: readonly CorpusDocument[]) {}
  isAvailable(): boolean {
    return true;
  }
  async search(query: RetrievalQuery): Promise<RetrievalHit[]> {
    const terms = tokenizeCode(query.text);
    if (terms.length === 0) return [];
    return rank(this.corpus, query, (document) => {
      if (document.source !== "bitbucket") return 0;
      const haystack = new Set(
        tokenizeCode(`${document.title} ${document.body}`),
      );
      return terms.filter((term) => haystack.has(term)).length;
    });
  }
}

/**
 * Stands in for the embedding arm.
 *
 * Token-overlap cosine: fuzzy, recall-oriented, indifferent to exact wording —
 * the ranking characteristics that matter for testing fusion. It is emphatically
 * not semantic; swapping in real embeddings changes which documents rank where,
 * not how the pipeline treats the arm.
 */
export class StubSemanticArm implements RetrievalArm {
  readonly name = "semantic";
  constructor(
    private readonly corpus: readonly CorpusDocument[],
    private readonly available = true,
  ) {}
  isAvailable(): boolean {
    return this.available;
  }
  async search(query: RetrievalQuery): Promise<RetrievalHit[]> {
    const terms = new Set(tokenize(query.text));
    if (terms.size === 0) return [];
    return rank(this.corpus, query, (document) => {
      const haystack = new Set(tokenize(`${document.title} ${document.body}`));
      let shared = 0;
      for (const term of terms) if (haystack.has(term)) shared += 1;
      if (shared === 0) return 0;
      return shared / Math.sqrt(terms.size * haystack.size);
    });
  }
}

/** An arm that always throws, so the pipeline's degradation path is exercised rather than assumed. */
export class FailingArm implements RetrievalArm {
  constructor(
    readonly name: string,
    private readonly message = "arm exploded",
  ) {}
  isAvailable(): boolean {
    return true;
  }
  async search(
    _query: RetrievalQuery,
    _viewer: Viewer,
  ): Promise<RetrievalHit[]> {
    throw new Error(this.message);
  }
}
