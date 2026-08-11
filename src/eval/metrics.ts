/**
 * Retrieval metrics.
 *
 * Search quality you cannot measure is search quality you cannot defend.
 * Without a labelled set, every ranking change is a coin flip and every
 * complaint is unfalsifiable — which is why the harness precedes every ranking
 * change, including switching on BM25.
 *
 * → docs/09-evaluation.md
 */

/** One labelled query: the text, and the ids a human would call relevant. */
export interface GoldenPair {
  readonly query: string;
  readonly relevant: readonly string[];
  /**
   * Where the label came from. Harvested labels are weaker than hand-written
   * ones and should be reported separately rather than averaged together.
   */
  readonly origin?: "hand-written" | "link-graph" | "click-log";
}

/** Fraction of the relevant set that appears in the top k. */
export function recallAt(
  retrieved: readonly string[],
  relevant: readonly string[],
  k: number,
): number {
  if (relevant.length === 0) return 1;
  const top = new Set(retrieved.slice(0, k));
  const found = relevant.filter((id) => top.has(id)).length;
  return found / relevant.length;
}

/** Fraction of the top k that is relevant. */
export function precisionAt(
  retrieved: readonly string[],
  relevant: readonly string[],
  k: number,
): number {
  if (k === 0) return 0;
  const relevantSet = new Set(relevant);
  const top = retrieved.slice(0, k);
  if (top.length === 0) return 0;
  return top.filter((id) => relevantSet.has(id)).length / top.length;
}

/**
 * Reciprocal rank of the first relevant result.
 *
 * The metric that tracks "did the user have to scroll", which is usually what
 * people mean when they say search is bad.
 */
export function reciprocalRank(
  retrieved: readonly string[],
  relevant: readonly string[],
): number {
  const relevantSet = new Set(relevant);
  const index = retrieved.findIndex((id) => relevantSet.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/** Normalised discounted cumulative gain, binary relevance. */
export function ndcgAt(
  retrieved: readonly string[],
  relevant: readonly string[],
  k: number,
): number {
  if (relevant.length === 0) return 1;
  const relevantSet = new Set(relevant);

  let dcg = 0;
  retrieved.slice(0, k).forEach((id, index) => {
    if (relevantSet.has(id)) dcg += 1 / Math.log2(index + 2);
  });

  let idcg = 0;
  for (let index = 0; index < Math.min(relevant.length, k); index += 1) {
    idcg += 1 / Math.log2(index + 2);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

export interface QueryOutcome {
  readonly query: string;
  readonly retrieved: readonly string[];
  readonly relevant: readonly string[];
  readonly recall: number;
  readonly precision: number;
  readonly reciprocalRank: number;
  readonly ndcg: number;
  /** True when nothing came back at all — the ingestion backlog, in priority order. */
  readonly zeroResult: boolean;
}

export interface EvaluationReport {
  readonly k: number;
  readonly queries: number;
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly mrr: number;
  readonly ndcgAtK: number;
  readonly zeroResults: number;
  readonly outcomes: readonly QueryOutcome[];
}

const mean = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;

/** Score a set of query outcomes. Pure — the runner does the retrieving. */
export function score(
  results: readonly {
    query: string;
    retrieved: readonly string[];
    relevant: readonly string[];
  }[],
  k = 10,
): EvaluationReport {
  const outcomes: QueryOutcome[] = results.map(
    ({ query, retrieved, relevant }) => ({
      query,
      retrieved,
      relevant,
      recall: recallAt(retrieved, relevant, k),
      precision: precisionAt(retrieved, relevant, k),
      reciprocalRank: reciprocalRank(retrieved, relevant),
      ndcg: ndcgAt(retrieved, relevant, k),
      zeroResult: retrieved.length === 0,
    }),
  );

  return {
    k,
    queries: outcomes.length,
    recallAtK: mean(outcomes.map((outcome) => outcome.recall)),
    precisionAtK: mean(outcomes.map((outcome) => outcome.precision)),
    mrr: mean(outcomes.map((outcome) => outcome.reciprocalRank)),
    ndcgAtK: mean(outcomes.map((outcome) => outcome.ndcg)),
    zeroResults: outcomes.filter((outcome) => outcome.zeroResult).length,
    outcomes,
  };
}

export interface RegressionVerdict {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

/**
 * Gate a candidate report against a baseline.
 *
 * `tolerance` exists because tiny movements are noise, not regressions; a gate
 * that fires on noise gets disabled, and a disabled gate protects nothing.
 */
export function checkRegression(
  baseline: EvaluationReport,
  candidate: EvaluationReport,
  tolerance = 0.01,
): RegressionVerdict {
  const failures: string[] = [];

  const compare = (name: string, before: number, after: number): void => {
    if (after < before - tolerance) {
      failures.push(
        `${name} fell from ${before.toFixed(3)} to ${after.toFixed(3)}`,
      );
    }
  };

  compare("recall@k", baseline.recallAtK, candidate.recallAtK);
  compare("MRR", baseline.mrr, candidate.mrr);
  compare("nDCG@k", baseline.ndcgAtK, candidate.ndcgAtK);

  if (candidate.zeroResults > baseline.zeroResults) {
    failures.push(
      `zero-result queries rose from ${baseline.zeroResults} to ${candidate.zeroResults}`,
    );
  }

  return { passed: failures.length === 0, failures };
}
