/**
 * Reciprocal Rank Fusion.
 *
 * Consumes *ranks*, never scores. This is the property that makes cross-source
 * fusion arithmetic instead of calibration: a BM25 score computed over Jira and
 * one computed over Confluence are not comparable (different corpus
 * statistics), but "third result" means the same thing in both.
 *
 * Determinism is a hard requirement, not a nicety — a non-deterministic
 * retrieval layer cannot be evaluated, cached or debugged. Same arms, same
 * order, always.
 *
 * → docs/adr/0006-hybrid-retrieval-rrf.md
 */

/** One result from one retrieval arm. Rank is implied by array position. */
export interface ArmHit {
  /** Canonical document id. Identity across arms is this field and only this field. */
  readonly id: string;
  /** Source system, used by the diversity cap. */
  readonly source?: string;
  /** Container (space / project / repo), used by the diversity cap. */
  readonly container?: string;
}

export interface Arm<T extends ArmHit = ArmHit> {
  /** Arm name — appears in the explain output. */
  readonly name: string;
  /** Results in rank order, best first. */
  readonly hits: readonly T[];
  /**
   * Relative influence. The query classifier moves these; it never removes an
   * arm. Defaults to 1.
   */
  readonly weight?: number;
  /**
   * A *corroborating* arm: it strengthens candidates that some other arm also
   * found, but cannot introduce a candidate ahead of directly-matched ones.
   *
   * Graph expansion is the case this exists for. It reaches documents by
   * relationship rather than by matching the query, so a neighbour of a
   * high-ranked *wrong* seed arrives at rank 1 with nothing to say about the
   * query. Weighting cannot separate those two situations: any weight large
   * enough to surface a useful neighbour is large enough to surface a useless
   * one, because RRF sees only rank. Measured on the corrected corpus, no
   * scalar weight satisfied both "raises recall" and "does not displace" —
   * the arm either contributed and displaced, or contributed nothing.
   *
   * Defaults to false.
   */
  readonly supporting?: boolean;
}

export interface FusedHit<T extends ArmHit = ArmHit> {
  readonly id: string;
  readonly score: number;
  /** The hit as the first (best-ranked) contributing arm saw it. */
  readonly hit: T;
  /** Per-arm contribution, for explain output. Ordered by arm declaration. */
  readonly contributions: readonly {
    arm: string;
    rank: number;
    weight: number;
    score: number;
  }[];
}

export interface RrfOptions {
  /**
   * The rank-damping constant. 60 is the value from the original RRF paper and
   * the one every comparable system uses; changing it is a ranking change and
   * therefore gated on the eval harness.
   */
  readonly k?: number;
  /** Truncate each arm before fusing. Applied per arm, not to the fused list. */
  readonly perArmLimit?: number;
}

export const DEFAULT_K = 60;

/**
 * Fuse ranked arms into one ranked list.
 *
 * Ties are broken by first-contributing-arm order, then by id. Both tie-breaks
 * are total and content-independent, so the output is a pure function of the
 * input ordering.
 */
export function rrf<T extends ArmHit>(
  arms: readonly Arm<T>[],
  options: RrfOptions = {},
): FusedHit<T>[] {
  const k = options.k ?? DEFAULT_K;
  if (k <= 0) throw new RangeError(`rrf: k must be positive, received ${k}`);

  interface Accumulator {
    score: number;
    hit: T;
    /** True once any non-supporting arm has contributed. */
    directlyMatched: boolean;
    firstArmIndex: number;
    contributions: {
      arm: string;
      rank: number;
      weight: number;
      score: number;
    }[];
  }
  const byId = new Map<string, Accumulator>();

  arms.forEach((arm, armIndex) => {
    const weight = arm.weight ?? 1;
    const supporting = arm.supporting ?? false;
    const hits =
      options.perArmLimit === undefined
        ? arm.hits
        : arm.hits.slice(0, options.perArmLimit);

    // Only the first occurrence of an id within a single arm counts. An arm that
    // returns a duplicate must not be able to pay twice for it.
    const seenInArm = new Set<string>();

    hits.forEach((hit, position) => {
      if (seenInArm.has(hit.id)) return;
      seenInArm.add(hit.id);

      const rank = position + 1;
      const contribution = weight / (k + rank);
      const existing = byId.get(hit.id);

      if (existing === undefined) {
        byId.set(hit.id, {
          score: contribution,
          hit,
          directlyMatched: !supporting,
          firstArmIndex: armIndex,
          contributions: [{ arm: arm.name, rank, weight, score: contribution }],
        });
      } else {
        // A supporting arm still adds its score — a candidate found both
        // directly and by relationship is corroborated and may legitimately
        // rise past other directly-matched results. What it may not do is
        // arrive on relationship alone and outrank them.
        if (!supporting) existing.directlyMatched = true;
        existing.score += contribution;
        existing.contributions.push({
          arm: arm.name,
          rank,
          weight,
          score: contribution,
        });
      }
    });
  });

  return [...byId.entries()]
    .map(([id, acc]) => ({ id, acc }))
    .sort((a, b) => {
      // Directly-matched candidates rank ahead of relationship-only ones,
      // whatever the fused scores say. Within each partition the ordering is
      // exactly as before, so corroboration still moves results.
      if (a.acc.directlyMatched !== b.acc.directlyMatched)
        return a.acc.directlyMatched ? -1 : 1;
      if (b.acc.score !== a.acc.score) return b.acc.score - a.acc.score;
      if (a.acc.firstArmIndex !== b.acc.firstArmIndex)
        return a.acc.firstArmIndex - b.acc.firstArmIndex;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map(({ id, acc }) => ({
      id,
      score: acc.score,
      hit: acc.hit,
      contributions: acc.contributions,
    }));
}

export interface DiversityOptions {
  /** Maximum results from any one source. */
  readonly maxPerSource?: number;
  /** Maximum results from any one container (space / project / repo). */
  readonly maxPerContainer?: number;
  /** Final result count. */
  readonly limit?: number;
}

/**
 * Cap how much any one source or container can contribute, preserving fused
 * order otherwise.
 *
 * Without this a chatty source wins on volume: Jira comments are numerous,
 * short and topically repetitive, so a subsystem query returns ten comments
 * from one epic and zero of the design page that answers it. This is the
 * difference between "ten results" and "ten *different* results".
 *
 * Over-cap hits are not discarded — they are demoted to the tail, so a result
 * set that is genuinely dominated by one source still fills up rather than
 * returning short.
 */
export function applyDiversityCap<T extends ArmHit>(
  fused: readonly FusedHit<T>[],
  options: DiversityOptions = {},
): FusedHit<T>[] {
  const { maxPerSource, maxPerContainer, limit } = options;

  const kept: FusedHit<T>[] = [];
  const demoted: FusedHit<T>[] = [];
  const sourceCount = new Map<string, number>();
  const containerCount = new Map<string, number>();

  for (const item of fused) {
    const source = item.hit.source;
    const container = item.hit.container;

    const sourceUsed =
      source === undefined ? 0 : (sourceCount.get(source) ?? 0);
    const containerUsed =
      container === undefined ? 0 : (containerCount.get(container) ?? 0);

    const overSource =
      maxPerSource !== undefined &&
      source !== undefined &&
      sourceUsed >= maxPerSource;
    const overContainer =
      maxPerContainer !== undefined &&
      container !== undefined &&
      containerUsed >= maxPerContainer;

    if (overSource || overContainer) {
      demoted.push(item);
      continue;
    }

    if (source !== undefined) sourceCount.set(source, sourceUsed + 1);
    if (container !== undefined)
      containerCount.set(container, containerUsed + 1);
    kept.push(item);
  }

  const combined = [...kept, ...demoted];
  return limit === undefined ? combined : combined.slice(0, limit);
}
