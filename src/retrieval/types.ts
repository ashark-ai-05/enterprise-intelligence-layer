/**
 * Retrieval contracts.
 *
 * The retrieval plane is stateless and deterministic: same query, same corpus,
 * same order. A non-deterministic retrieval layer cannot be evaluated, cached
 * or debugged, so no clock, no randomness and no model runs in this path.
 *
 * → docs/06-retrieval.md
 */

/**
 * Who is asking.
 *
 * Derived from verified token claims at the serving boundary, never supplied by
 * a caller. No API accepts a principal, group list or container list as a
 * parameter. → docs/02-architecture.md §6
 */
export interface Viewer {
  /** Canonical identity of the caller. */
  readonly principal: string;
  /**
   * The caller plus the transitive closure of their groups, each as
   * `authorizationDomain:identifier`. Resolved at query time from the
   * directory, not stamped at ingest — membership churns hourly.
   */
  readonly principals: readonly string[];
  /**
   * Containers (spaces, projects, repositories) the caller can see.
   *
   * Expanded before any arm runs. Pre-filtering by container removes 95–99% of
   * the corpus before content-level work, and it is the only ACL strategy that
   * neither destroys recall (post-filtering an ANN result) nor destroys the
   * index (pre-filtering an unpartitioned one).
   * → docs/adr/0007-container-first-acl-prefilter.md
   */
  readonly containers: readonly string[];
}

export interface RetrievalQuery {
  readonly text: string;
  /** Restrict to these sources. Empty or absent means all. */
  readonly sources?: readonly string[];
  /** Restrict to these containers. Intersected with the viewer's, never widening it. */
  readonly containers?: readonly string[];
  readonly limit?: number;
}

/** One result from one arm. `id` is identity across arms; nothing else is. */
export interface RetrievalHit {
  readonly id: string;
  readonly source: string;
  readonly container: string;
  readonly title: string;
  readonly url: string;
  /** Short excerpt. Generated for returned results only, never for every candidate. */
  readonly snippet?: string;
  /** When the indexed copy was last synced. `null` for a live federated hit. */
  readonly syncedAt?: string | null;
}

/**
 * A retrieval arm.
 *
 * Every arm applies the viewer's ACL itself — for indexed arms by composing the
 * predicate into the SQL, for the federated arm because the source enforces it.
 * The final gate in the pipeline is defence in depth, not the primary control:
 * an arm added later must not be able to forget.
 */
export interface RetrievalArm {
  readonly name: string;
  /** `false` when the arm cannot run — no embeddings yet, extension missing, source down. */
  isAvailable(): boolean;
  search(query: RetrievalQuery, viewer: Viewer): Promise<RetrievalHit[]>;
}

export interface ScoredHit extends RetrievalHit {
  readonly score: number;
  /** Which arms contributed, and at what rank. The explain output. */
  readonly arms: readonly { readonly arm: string; readonly rank: number }[];
}

export interface RetrievalResult {
  readonly hits: readonly ScoredHit[];
  /** Arms that ran, and arms that were skipped with the reason. */
  readonly armsRun: readonly string[];
  readonly armsSkipped: readonly {
    readonly arm: string;
    readonly reason: string;
  }[];
  /**
   * Results removed by the final ACL gate.
   *
   * Should be zero: a non-zero value means an arm returned something the viewer
   * cannot see, which is a bug in that arm, not a normal outcome. Surfaced so
   * it can be alarmed on rather than silently absorbed.
   */
  readonly aclRejected: number;
  /**
   * Live results the container gate dropped.
   *
   * The source's own search surfaced a container our expansion says the viewer
   * cannot see. Either the mirrored permissions are stale, or the federated
   * adapter is querying with a service account rather than the caller's
   * credentials. We still fail closed and drop the result; this counter is the
   * signal that the two views disagree, which is the drift the federated arm
   * exists to detect. → docs/14 §3.3
   */
  readonly aclDrift: number;
}
