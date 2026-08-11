/**
 * Federated source adapters, as retrieval arms.
 *
 * A federated arm queries a source's own search API live. Two properties
 * distinguish it from every indexed arm, and both matter:
 *
 *   - its ACL is **enforced by the source**, not mirrored by us;
 *   - its freshness is **live**, not poll-interval.
 *
 * That makes it simultaneously a product feature (useful before any ingestion
 * exists) and a test fixture: diffing it against the indexed arms detects
 * permission-mirroring drift automatically. → docs/14 §3.3
 *
 * This adapter exists so there is **one** fan-out-and-fuse pipeline rather than
 * a separate federated one. A second pipeline is a second place for the ACL
 * gate, the diversity cap and the determinism guarantee to drift.
 */

import type {
  RetrievalArm,
  RetrievalHit,
  RetrievalQuery,
  Viewer,
} from "../retrieval/types.js";

/**
 * A live source search.
 *
 * Deliberately the same shape as the adapter interface on
 * `reference/sonnet-p0-federated-search`, so the Confluence and Jira clients
 * written there plug in without modification.
 */
export interface SourceAdapter {
  readonly name: string;
  search(
    query: string,
    options?: { limit?: number | undefined },
  ): Promise<SourceResult[]>;
}

export interface SourceResult {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly snippet: string;
  readonly url: string;
  readonly updatedAt: string;
  readonly container: string;
}

export interface FederatedArmOptions {
  readonly limit?: number;
  /** Arm name. Defaults to `federated`, which is what the query classifier weights. */
  readonly name?: string;
}

export class FederatedArm implements RetrievalArm {
  readonly name: string;

  constructor(
    private readonly adapters: readonly SourceAdapter[],
    private readonly options: FederatedArmOptions = {},
  ) {
    this.name = options.name ?? "federated";
  }

  isAvailable(): boolean {
    return this.adapters.length > 0;
  }

  async search(
    query: RetrievalQuery,
    _viewer: Viewer,
  ): Promise<RetrievalHit[]> {
    const limit = query.limit ?? this.options.limit ?? 20;

    // One slow or failing source must not take the arm down; the pipeline
    // already degrades on a failed arm, but a *partial* federated result is
    // strictly better than none.
    const outcomes = await Promise.allSettled(
      this.adapters.map((adapter) => adapter.search(query.text, { limit })),
    );

    const hits: RetrievalHit[] = [];
    for (const outcome of outcomes) {
      if (outcome.status !== "fulfilled") continue;
      for (const result of outcome.value) {
        hits.push({
          id: result.id,
          source: result.source,
          container: result.container,
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          // Live, therefore not "synced" at any point. Consumers use this to
          // decide whether they can trust the result's currency.
          syncedAt: null,
        });
      }
    }
    return hits;
  }
}

/** Is this hit live from a source, rather than read from the index? */
export function isLive(hit: RetrievalHit): boolean {
  return hit.syncedAt === null;
}
