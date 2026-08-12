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
  type QueryFamily,
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
  /**
   * Score one query family only.
   *
   * Required once the corpus carries families: exact lookup, subject search,
   * relationship navigation and unanswerable queries measure different
   * capabilities, and averaging them produces a number that improves when a
   * scorer gets better at one and worse at another. Defaults to
   * `subject_search`, which is the closest equivalent to what this gate scored
   * before the split, so the committed baseline keeps its meaning.
   */
  readonly family?: QueryFamily;
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

  // Never pool families. A run that mixes them is not comparable to itself.
  const family = options.family ?? "subject_search";
  const inFamily = seed.corpus.relevance.filter(
    (judgment) => (judgment.family ?? "subject_search") === family,
  );
  const judgments =
    options.limit === undefined ? inFamily : inFamily.slice(0, options.limit);

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

export interface NavigationReport {
  readonly anchors: number;
  /** Mean fraction of an anchor's visible neighbours that were returned. */
  readonly coverage: number;
  /** Anchors where every visible neighbour was returned. */
  readonly complete: number;
  /** Returned objects that are not neighbours of the anchor. */
  readonly spurious: number;
  /** Protected neighbours returned. Must be 0. */
  readonly leaked: number;
}

/**
 * Evaluate relationship navigation as navigation.
 *
 * Scoring this family through ordinary search measured something else
 * entirely: the query was the anchor id, exact lookup does not exist, so the
 * anchor was never retrieved and graph expansion started from unrelated seeds.
 * Graph-on and graph-off were consequently identical, which said nothing about
 * whether the system can navigate.
 *
 * This supplies the known anchor directly to the link source and resolves the
 * result through the ACL resolver — the composition `GraphExpansionArm` uses
 * internally, minus the search step it cannot rely on. Note what that implies:
 * **no product surface exposes anchor-based navigation.** There is no MCP tool
 * and no CLI verb for "given this issue, show its related evidence". This
 * harness reaches past the product to measure a capability the product does not
 * currently offer, and that gap is the finding, not the coverage number.
 */
export async function runNavigationEvaluation(
  db: Database,
  seed: SeedResult,
  options: { limit?: number } = {},
): Promise<NavigationReport> {
  const viewer = evalViewer(seed.containerIds);
  const links = new DatabaseLinkSource(db, EVAL_TENANT);
  const resolver = new AuthorizedHitResolver(db, EVAL_TENANT);

  const judgments = seed.corpus.relevance
    .filter((judgment) => judgment.family === "relationship_navigation")
    .slice(0, options.limit ?? 20);

  let coverageTotal = 0;
  let complete = 0;
  let spurious = 0;
  let leaked = 0;

  for (const judgment of judgments) {
    const anchor = judgment.anchor;
    if (anchor === undefined) continue;

    const neighbours = await links.neighbours([anchor]);
    const reached = neighbours.map((link) =>
      link.from === anchor ? link.to : link.from,
    );
    // The resolver takes the query only to honour its container scope; the
    // anchor is supplied directly, so there is no text to search with.
    const visible = await resolver.resolve(reached, viewer, {
      text: "",
      containers: seed.containerIds,
    });
    const returned = new Set(visible.map((hit) => hit.id));

    const expected = judgment.relevantSourceObjectIds;
    const found = expected.filter((id) => returned.has(id));
    coverageTotal += expected.length === 0 ? 1 : found.length / expected.length;
    if (found.length === expected.length) complete += 1;

    for (const id of returned) {
      if (!expected.includes(id)) spurious += 1;
    }
    for (const id of judgment.forbidden ?? []) {
      if (returned.has(id)) leaked += 1;
    }
  }

  return {
    anchors: judgments.length,
    coverage: judgments.length === 0 ? 0 : coverageTotal / judgments.length,
    complete,
    spurious,
    leaked,
  };
}

/**
 * What a family's numbers actually mean.
 *
 * Ranking metrics are omitted where truth is empty rather than reported as
 * perfect. `recallAt` and `ndcgAt` both return 1 for an empty relevant set —
 * mathematically conventional, operationally a hardcoded pass. Measured on the
 * unanswerable family that produced "recall 1.000, nDCG 1.000" while the
 * system answered every single query it should have refused.
 */
export interface FamilyReport {
  readonly family: QueryFamily;
  readonly queries: number;
  /** Omitted when the family's truth is empty; meaningless there. */
  readonly recallAtK?: number;
  readonly mrr?: number;
  readonly ndcgAtK?: number;
  /**
   * Fraction of *empty-truth* queries for which retrieval returned at least one
   * candidate. Target 0.
   *
   * Named for what it measures. This is retrieval-level abstention only: it
   * shows the retriever does not decline, not that an agent went on to assert a
   * false answer. Answer generation and verification are not evaluated here, so
   * agent-level abstention belongs in the acceptance harness.
   */
  readonly retrievalAnsweredRate?: number;
  /** Queries where a forbidden object was returned. Must be 0. */
  readonly leakedQueries?: number;
  /** Distinct forbidden objects returned across the family. Must be 0. */
  readonly leakedObjects?: number;
}

/**
 * Score one family with metrics appropriate to what it measures.
 *
 * Never pools families and never reports a ranking metric a family cannot
 * support. Leakage is checked for every family that names forbidden objects,
 * not only `denied` — relationship navigation carries protected neighbours too.
 */
export async function runFamilyEvaluation(
  db: Database,
  seed: SeedResult,
  arms?: readonly RetrievalArm[],
  options: GateOptions = {},
): Promise<FamilyReport> {
  const k = options.k ?? 10;
  const viewer = evalViewer(seed.containerIds);
  const activeArms = arms ?? defaultArms(db);
  const family = options.family ?? "subject_search";

  const inFamily = seed.corpus.relevance.filter(
    (judgment) => (judgment.family ?? "subject_search") === family,
  );
  const judgments =
    options.limit === undefined ? inFamily : inFamily.slice(0, options.limit);

  const results = [];
  let leakedQueries = 0;
  const leakedObjects = new Set<string>();

  for (const judgment of judgments) {
    const result = await retrieve(
      activeArms,
      { text: judgment.query, limit: k },
      viewer,
      { limit: k, maxPerSource: k, maxPerContainer: k },
    );
    const retrieved = result.hits.map((hit) => hit.id);

    const leaked = (judgment.forbidden ?? []).filter((id) =>
      retrieved.includes(id),
    );
    if (leaked.length > 0) {
      leakedQueries += 1;
      for (const id of leaked) leakedObjects.add(id);
    }

    results.push({
      query: judgment.query,
      retrieved,
      relevant: judgment.relevantSourceObjectIds,
    });
  }

  // Partition per row, not per family. A family-level `.some()` would score
  // empty-truth rows through recallAt/ndcgAt -- which return 1 for empty truth
  // -- and silently inject a perfect score into a mixed family's aggregate.
  // Every family is uniform today; this is what stops that being load-bearing.
  const withTruth = results.filter((row) => row.relevant.length > 0);
  const withoutTruth = results.filter((row) => row.relevant.length === 0);
  const answeredWithoutTruth = withoutTruth.filter(
    (row) => row.retrieved.length > 0,
  ).length;
  const namesForbidden = judgments.some(
    (judgment) => (judgment.forbidden ?? []).length > 0,
  );

  const ranked = withTruth.length > 0 ? score(withTruth, k) : undefined;

  return {
    family,
    queries: results.length,
    ...(ranked
      ? {
          recallAtK: ranked.recallAtK,
          mrr: ranked.mrr,
          ndcgAtK: ranked.ndcgAtK,
        }
      : {}),
    ...(withoutTruth.length > 0
      ? {
          retrievalAnsweredRate: answeredWithoutTruth / withoutTruth.length,
        }
      : {}),
    ...(namesForbidden ? { leakedQueries, leakedObjects: leakedObjects.size } : {}),
  };
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
