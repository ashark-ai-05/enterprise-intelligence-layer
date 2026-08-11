/**
 * The ranking regression gate.
 *
 * Ingests the synthetic corpus through the real pipeline, publishes it, grants
 * a viewer access, runs every relevance judgment through retrieval, and scores
 * the result. A committed baseline turns every future ranking change into a
 * measured decision instead of a coin flip.
 *
 * The corpus generator emits its own relevance judgments, so the labels come
 * from the same seed as the data — no hand annotation, and reproducible.
 *
 * → docs/09-evaluation.md, src/corpus/synthetic.ts
 */

import {
  StubConfluenceConnector,
  StubGitConnector,
  StubJiraConnector,
} from "../connectors/stubs.js";
import {
  type SyntheticCorpus,
  type SyntheticCorpusOptions,
  generateSyntheticCorpus,
  syntheticCorpusPresets,
} from "../corpus/synthetic.js";
import { ingestScope } from "../ingestion/pipeline.js";
import { DatabaseLinkSource } from "../links/store.js";
import { publishCoreGeneration } from "../publication/generations.js";
import { AuthorizedHitResolver } from "../retrieval/authorized-resolver.js";
import { GraphExpansionArm } from "../retrieval/graph-arm.js";
import { IndexedLexicalArm } from "../retrieval/indexed-arm.js";
import { retrieve } from "../retrieval/pipeline.js";
import type { RetrievalArm, Viewer } from "../retrieval/types.js";
import { createScope } from "../scopes/service.js";
import {
  assignResourceContainer,
  ensureContainer,
  replaceContainerAces,
} from "../security/acl.js";
import type { Database } from "../storage/database.js";
import { type EvaluationReport, score } from "./metrics.js";

export const EVAL_TENANT = "eval";
const EVAL_PRINCIPAL = { domain: "enterprise", principalId: "group:everyone" };

/** A viewer who can see the whole evaluation corpus. Relevance, not authorization, is what this gate measures. */
export const evalViewer = (containers: readonly string[]): Viewer => ({
  principal: "eval:runner",
  principals: [`${EVAL_PRINCIPAL.domain}:${EVAL_PRINCIPAL.principalId}`],
  containers: [...containers],
});

export interface SeedResult {
  readonly corpus: SyntheticCorpus;
  readonly containerIds: string[];
  readonly resourceCount: number;
}

/**
 * Ingest the corpus, assign containers, grant access, publish everything.
 *
 * Publication matters: `listAuthorizedChunks` now fails closed on an
 * unpublished generation, so an unpublished corpus scores zero on every query
 * and looks exactly like a ranking collapse.
 */
export async function seedEvaluationCorpus(
  db: Database,
  options: SyntheticCorpusOptions = syntheticCorpusPresets.ci,
): Promise<SeedResult> {
  const corpus = generateSyntheticCorpus(options);

  const confluence = await createScope(db, {
    tenantId: EVAL_TENANT,
    source: "confluence",
    selectorKind: "space",
    selector: { keys: ["ENG", "SEC"] },
    refreshMode: "manual",
    addedBy: "eval",
  });
  const jira = await createScope(db, {
    tenantId: EVAL_TENANT,
    source: "jira",
    selectorKind: "project",
    selector: { keys: ["PAY"] },
    refreshMode: "manual",
    addedBy: "eval",
  });
  const git = await createScope(db, {
    tenantId: EVAL_TENANT,
    source: "git",
    selectorKind: "repository",
    selector: {
      repositories: Array.from(
        { length: options.repositories },
        (_, index) => `service-${index}`,
      ),
      refs: ["main"],
    },
    refreshMode: "manual",
    addedBy: "eval",
  });

  await ingestScope(
    db,
    EVAL_TENANT,
    confluence.id,
    new StubConfluenceConnector(corpus.events.confluence),
  );
  await ingestScope(
    db,
    EVAL_TENANT,
    jira.id,
    new StubJiraConnector(corpus.events.jira),
  );
  await ingestScope(
    db,
    EVAL_TENANT,
    git.id,
    new StubGitConnector("git", corpus.events.git),
  );

  // One container per source keeps the container pre-filter exercised without
  // making this gate a permissions test — that is what the ACL suite is for.
  const containerIds: string[] = [];
  for (const source of ["confluence", "jira", "git"] as const) {
    const containerId = await ensureContainer(
      db,
      EVAL_TENANT,
      source,
      `${source}-eval`,
      `${source} eval`,
    );
    containerIds.push(containerId);
    await replaceContainerAces(db, EVAL_TENANT, containerId, [
      { ...EVAL_PRINCIPAL, effect: "allow" },
    ]);

    const resources = await db.query<{ id: string }>(
      "SELECT id FROM resources WHERE tenant_id = $1 AND source = $2 AND deleted_at IS NULL",
      [EVAL_TENANT, source],
    );
    for (const { id } of resources.rows) {
      await assignResourceContainer(db, EVAL_TENANT, id, containerId);
      await publishCoreGeneration(db, EVAL_TENANT, id);
    }
  }

  const total = await db.query<{ count: string }>(
    "SELECT count(*) AS count FROM resources WHERE tenant_id = $1 AND deleted_at IS NULL",
    [EVAL_TENANT],
  );

  return {
    corpus,
    containerIds,
    resourceCount: Number(total.rows[0]?.count ?? 0),
  };
}

/**
 * The arms the gate scores by default: lexical retrieval plus graph expansion
 * over the persisted link store. This is the shipped configuration, so the
 * committed baseline describes what the product actually does.
 */
export function defaultArms(db: Database): RetrievalArm[] {
  const lexical = new IndexedLexicalArm(db, { tenantId: EVAL_TENANT });
  return [
    lexical,
    new GraphExpansionArm(
      lexical,
      new DatabaseLinkSource(db, EVAL_TENANT),
      new AuthorizedHitResolver(db, EVAL_TENANT),
    ),
  ];
}

export interface GateOptions {
  readonly k?: number;
  /** Cap how many judgments are run. The full CI set is 100; a smaller slice keeps iteration fast. */
  readonly limit?: number;
}

/**
 * Run every relevance judgment through retrieval and score the outcome.
 *
 * Retrieval returns `sourceObjectId` as the hit id, which is exactly what the
 * corpus judgments reference — so no id translation is needed, and none can go
 * subtly wrong.
 */
export async function runEvaluationGate(
  db: Database,
  seed: SeedResult,
  arms?: readonly RetrievalArm[],
  options: GateOptions = {},
): Promise<EvaluationReport> {
  const k = options.k ?? 10;
  const viewer = evalViewer(seed.containerIds);
  const activeArms = arms ?? defaultArms(db);

  const judgments =
    options.limit === undefined
      ? seed.corpus.relevance
      : seed.corpus.relevance.slice(0, options.limit);

  const results = [];
  for (const judgment of judgments) {
    const result = await retrieve(
      activeArms,
      { text: judgment.query, limit: k },
      viewer,
      // Diversity caps are a product decision about what a *page* looks like.
      // Measuring them here would conflate presentation with ranking quality,
      // so they are disabled and measured separately.
      { limit: k, maxPerSource: k, maxPerContainer: k },
    );
    results.push({
      query: judgment.query,
      retrieved: result.hits.map((hit) => hit.id),
      relevant: judgment.relevantSourceObjectIds,
    });
  }

  return score(results, k);
}

export interface Baseline {
  readonly recallAtK: number;
  readonly mrr: number;
  readonly ndcgAtK: number;
  readonly zeroResults: number;
}

/** Round to a fixed precision so a committed baseline is stable across machines. */
export function toBaseline(report: EvaluationReport): Baseline {
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    recallAtK: round(report.recallAtK),
    mrr: round(report.mrr),
    ndcgAtK: round(report.ndcgAtK),
    zeroResults: report.zeroResults,
  };
}
