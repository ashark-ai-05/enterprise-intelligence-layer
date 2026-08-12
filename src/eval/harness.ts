/**
 * The evaluation harness.
 *
 * Runs a golden set through the retrieval pipeline and scores it. Deliberately
 * thin: the value is in the labels and in the gate, not in this file.
 *
 * → docs/09-evaluation.md
 */

import { type PipelineOptions, retrieve } from "../retrieval/pipeline.js";
import type { RetrievalArm, Viewer } from "../retrieval/types.js";
import { type EvaluationReport, type GoldenPair, score } from "./metrics.js";

export async function evaluate(
  arms: readonly RetrievalArm[],
  golden: readonly GoldenPair[],
  viewer: Viewer,
  options: PipelineOptions & { k?: number } = {},
): Promise<EvaluationReport> {
  const k = options.k ?? 10;

  const results = [];
  for (const pair of golden) {
    const result = await retrieve(
      arms,
      { text: pair.query, limit: k },
      viewer,
      options,
    );
    results.push({
      query: pair.query,
      retrieved: result.hits.map((hit) => hit.id),
      relevant: pair.relevant,
    });
  }

  return score(results, k);
}

/**
 * Harvest labelled pairs from the link graph.
 *
 * Before launch there are no query logs, so the golden set has a cold-start
 * problem with a free answer: the corpus already contains thousands of implicit
 * relevance judgements. A Jira issue linking a Confluence page *is* a labelled
 * pair — a human decided that page was relevant to that text.
 *
 * Weak labels, but enough to catch a regression, and available on day one at
 * zero annotation cost. → docs/14 §2 Gap 11
 */
export interface LinkEdge {
  /** Text a human wrote — an issue summary, a commit message, an alert name. */
  readonly sourceText: string;
  /** The document they chose to link to. */
  readonly targetId: string;
}

export function harvestFromLinks(edges: readonly LinkEdge[]): GoldenPair[] {
  const byText = new Map<string, Set<string>>();

  for (const edge of edges) {
    const text = edge.sourceText.trim();
    if (text === "") continue;
    const targets = byText.get(text) ?? new Set<string>();
    targets.add(edge.targetId);
    byText.set(text, targets);
  }

  return [...byText.entries()]
    .map(([query, targets]) => ({
      query,
      relevant: [...targets].sort(),
      origin: "link-graph" as const,
    }))
    .sort((a, b) => (a.query < b.query ? -1 : a.query > b.query ? 1 : 0));
}

/** Format a report for a terminal or a CI log. */
export function formatReport(report: EvaluationReport): string {
  const lines = [
    `queries        ${report.queries}`,
    `recall@${report.k}      ${report.recallAtK.toFixed(3)}`,
    // Printed with its ceiling because precision@k is bounded by the size of
    // the judgment set, not just by the ranking. Without the ceiling, 0.295
    // reads as poor precision when it is 98% of everything achievable.
    `precision@${report.k}   ${report.precisionAtK.toFixed(3)} (ceiling ${report.maxPrecisionAtK.toFixed(3)})`,
    `MRR            ${report.mrr.toFixed(3)}`,
    `nDCG@${report.k}        ${report.ndcgAtK.toFixed(3)}`,
    `zero-result    ${report.zeroResults}`,
  ];

  const zeroResultQueries = report.outcomes.filter(
    (outcome) => outcome.zeroResult,
  );
  if (zeroResultQueries.length > 0) {
    // What people search for and do not find is the ingestion backlog, already
    // in priority order. Worth printing, not just counting.
    lines.push("", "found nothing:");
    for (const outcome of zeroResultQueries) lines.push(`  ${outcome.query}`);
  }

  return lines.join("\n");
}
