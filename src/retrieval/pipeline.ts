/**
 * The retrieval pipeline.
 *
 *   classify → fan out to every available arm → RRF → diversity cap
 *            → ACL gate → truncate
 *
 * Stateless and deterministic throughout. Arms run concurrently; a failing arm
 * degrades the result rather than failing the query, because "the vector arm is
 * unavailable" must narrow results, not produce an error page.
 *
 * → docs/06-retrieval.md
 */

import { type Arm, applyDiversityCap, rrf } from "../fusion/rrf.js";
import { classify, weightFor } from "./classify.js";
import { type SearchFilters, matchesFilters } from "./query-filters.js";
import type {
  RetrievalArm,
  RetrievalHit,
  RetrievalQuery,
  RetrievalResult,
  ScoredHit,
  Viewer,
} from "./types.js";

export interface PipelineOptions {
  /** Narrow results by source or id substring. Applied after the ACL gate. */
  readonly filters?: SearchFilters;
  /** Results per arm before fusion. */
  readonly perArmLimit?: number;
  /** Final result count. */
  readonly limit?: number;
  readonly maxPerSource?: number;
  readonly maxPerContainer?: number;
}

const DEFAULTS = {
  perArmLimit: 50,
  limit: 10,
  maxPerSource: 5,
  maxPerContainer: 4,
} as const;

/**
 * Narrow the requested containers to those the viewer can actually see.
 *
 * Intersection, never union: a caller naming a container they cannot see gets
 * nothing from it rather than an error, because an error would confirm the
 * container exists. Requesting nothing means "everything I can see".
 */
export function resolveContainers(
  query: RetrievalQuery,
  viewer: Viewer,
): string[] {
  const visible = new Set(viewer.containers);
  if (query.containers === undefined || query.containers.length === 0) {
    return [...visible];
  }
  return query.containers.filter((container) => visible.has(container));
}

/** Defence in depth. Every arm already filters; this catches the arm that forgot. */
function isVisible(hit: RetrievalHit, allowed: ReadonlySet<string>): boolean {
  return allowed.has(hit.container);
}

export async function retrieve(
  arms: readonly RetrievalArm[],
  query: RetrievalQuery,
  viewer: Viewer,
  options: PipelineOptions = {},
): Promise<RetrievalResult> {
  const perArmLimit = options.perArmLimit ?? DEFAULTS.perArmLimit;
  const limit = query.limit ?? options.limit ?? DEFAULTS.limit;
  const maxPerSource = options.maxPerSource ?? DEFAULTS.maxPerSource;
  const maxPerContainer = options.maxPerContainer ?? DEFAULTS.maxPerContainer;

  const allowedContainers = resolveContainers(query, viewer);

  // A viewer who can see nothing gets nothing, without touching an arm. Fail
  // closed, and cheaply.
  if (allowedContainers.length === 0) {
    return {
      hits: [],
      armsRun: [],
      armsSkipped: [],
      aclRejected: 0,
      aclDrift: 0,
    };
  }

  const scopedQuery: RetrievalQuery = {
    ...query,
    containers: allowedContainers,
  };
  const classification = classify(query.text);
  const armsSkipped: { arm: string; reason: string }[] = [];

  const outcomes = await Promise.all(
    arms.map(
      async (
        arm,
      ): Promise<Arm<RetrievalHit> | { skipped: string; reason: string }> => {
        if (!arm.isAvailable()) {
          return { skipped: arm.name, reason: "unavailable" };
        }
        try {
          const hits = await arm.search(scopedQuery, viewer);
          return {
            name: arm.name,
            hits: hits.slice(0, perArmLimit),
            weight: weightFor(classification, arm.name),
            // Graph expansion reaches documents by relationship, not by
            // matching the query, so it corroborates rather than nominates.
            supporting: arm.name === "graph-expand",
          };
        } catch (error) {
          // One arm failing must narrow the result, never fail the query.
          return {
            skipped: arm.name,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      },
    ),
  );

  const ranked: Arm<RetrievalHit>[] = [];
  for (const outcome of outcomes) {
    if ("skipped" in outcome) {
      armsSkipped.push({ arm: outcome.skipped, reason: outcome.reason });
    } else {
      ranked.push(outcome);
    }
  }

  const fused = rrf(ranked, { perArmLimit });

  const allowed = new Set(allowedContainers);
  const permitted = fused.filter((item) => isVisible(item.hit, allowed));
  const rejected = fused.filter((item) => !isVisible(item.hit, allowed));

  // Split the rejections by where they came from, because they mean different
  // things.
  //
  // A rejected *indexed* hit is a bug in that arm: it returned something outside
  // the container pre-filter it was given.
  //
  // A rejected *live* hit is permission-mirroring drift. The source's own search
  // surfaced a container our expansion says the viewer cannot see. Either our
  // container view is stale, or the federated adapter is querying with a service
  // account rather than the caller's credentials — the second being why we still
  // fail closed and drop it. Both are worth an alert; neither is worth serving.
  //
  // This is the ACL oracle the federated arm was added for. → docs/14 §3.3
  const aclDrift = rejected.filter((item) => item.hit.syncedAt === null).length;
  const aclRejected = rejected.length - aclDrift;

  const filtered =
    options.filters === undefined
      ? permitted
      : permitted.filter((item) =>
          matchesFilters(item.hit, options.filters as SearchFilters),
        );

  const capped = applyDiversityCap(filtered, {
    maxPerSource,
    maxPerContainer,
    limit,
  });

  const hits: ScoredHit[] = capped.map((item) => ({
    ...item.hit,
    score: item.score,
    arms: item.contributions.map((contribution) => ({
      arm: contribution.arm,
      rank: contribution.rank,
    })),
  }));

  return {
    hits,
    armsRun: ranked.map((arm) => arm.name),
    armsSkipped,
    aclRejected,
    aclDrift,
  };
}
