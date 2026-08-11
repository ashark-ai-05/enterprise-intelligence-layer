/**
 * Graph expansion.
 *
 * The evaluation gate measured lexical retrieval at recall@10 0.333 with MRR
 * 0.967: the text-matching document is found, at rank one, essentially always —
 * and the documents it *links to* are not found at all. Each relevance judgment
 * marks an issue, the page documenting it, and the code implementing it. One of
 * three is exactly 0.333.
 *
 * This arm closes that gap. It seeds from another arm's results, walks the link
 * graph, and returns the neighbours. It is the arm that makes the whole
 * cross-source premise pay off: the value was never parallel search, it was the
 * join.
 *
 * → docs/06-retrieval.md, src/eval/corpus-gate.ts
 */

import type {
  RetrievalArm,
  RetrievalHit,
  RetrievalQuery,
  Viewer,
} from "./types.js";

export type LinkType = "documents" | "implemented-by" | "tested-by";

export interface Link {
  readonly from: string;
  readonly to: string;
  readonly type: LinkType;
}

/**
 * Neighbours of a set of documents.
 *
 * An interface so the arm is independent of where edges live. `DatabaseLinkSource`
 * walks the persisted `resource_links` store; `InMemoryLinkSource` is for tests
 * and was how the value of that store was measured before it was built.
 *
 * Implementations may return rows in any order. The arm must not depend on it —
 * see the ordering note in `search`.
 */
export interface LinkSource {
  neighbours(sourceObjectIds: readonly string[]): Promise<Link[]>;
}

/**
 * Resolve document ids to hits the viewer is permitted to see.
 *
 * Expansion must never become an authorization bypass. A neighbour reached
 * through a link the viewer *can* see may itself be a document the viewer
 * *cannot* — container, resource and chunk ACEs all still apply, and the link
 * carries no permission of its own.
 */
export interface HitResolver {
  resolve(
    sourceObjectIds: readonly string[],
    viewer: Viewer,
    query: RetrievalQuery,
  ): Promise<RetrievalHit[]>;
}

/** Edges held in memory. Suitable for a corpus that fits in memory, and for tests. */
export class InMemoryLinkSource implements LinkSource {
  readonly #byId = new Map<string, Link[]>();

  constructor(links: readonly Link[]) {
    for (const link of links) {
      // Links are walked in both directions. An issue documented by a page is
      // as relevant to that page as the page is to the issue; direction
      // encodes semantics, not reachability.
      this.#push(link.from, link);
      this.#push(link.to, { from: link.to, to: link.from, type: link.type });
    }
  }

  #push(key: string, link: Link): void {
    const existing = this.#byId.get(key);
    if (existing === undefined) this.#byId.set(key, [link]);
    else existing.push(link);
  }

  async neighbours(sourceObjectIds: readonly string[]): Promise<Link[]> {
    const out: Link[] = [];
    for (const id of sourceObjectIds) out.push(...(this.#byId.get(id) ?? []));
    return out;
  }
}

export interface GraphArmOptions {
  /** How many of the seed arm's results to expand from. */
  readonly seedLimit?: number;
  /** Hops to walk. One is almost always right; two explodes and dilutes. */
  readonly depth?: number;
  /** Restrict to these link types. Absent means all. */
  readonly types?: readonly LinkType[];
  readonly name?: string;
}

const DEFAULTS = { seedLimit: 5, depth: 1 } as const;

/**
 * Order neighbours of the same seed by link type.
 *
 * There is no inherently correct order here, but there must be a *deterministic*
 * one that the arm chooses rather than inherits — otherwise ranking depends on
 * how a store happened to sort its rows. Documentation first is the deliberate
 * choice: for a knowledge platform, the page explaining a thing is usually the
 * better second result than the file implementing it.
 */
const TYPE_PRIORITY: Readonly<Record<LinkType, number>> = {
  documents: 0,
  "implemented-by": 1,
  "tested-by": 2,
};

export class GraphExpansionArm implements RetrievalArm {
  readonly name: string;

  constructor(
    private readonly seedArm: RetrievalArm,
    private readonly links: LinkSource,
    private readonly resolver: HitResolver,
    private readonly options: GraphArmOptions = {},
  ) {
    this.name = options.name ?? "graph-expand";
  }

  isAvailable(): boolean {
    return this.seedArm.isAvailable();
  }

  async search(query: RetrievalQuery, viewer: Viewer): Promise<RetrievalHit[]> {
    const seedLimit = this.options.seedLimit ?? DEFAULTS.seedLimit;
    const depth = this.options.depth ?? DEFAULTS.depth;

    const seeds = (await this.seedArm.search(query, viewer)).slice(
      0,
      seedLimit,
    );
    if (seeds.length === 0) return [];

    // Frontier order is rank order: seeds arrive ranked, and a neighbour of the
    // best seed should outrank a neighbour of the fifth.
    let frontier = seeds.map((hit) => hit.id);
    const seen = new Set(frontier);
    const discovered: string[] = [];

    for (let hop = 0; hop < depth; hop += 1) {
      const links = await this.links.neighbours(frontier);

      // Group by origin so ordering derives from *seed rank*, never from the
      // order a LinkSource happened to return rows in.
      //
      // This matters more than it looks. The arm's output position is its rank,
      // and RRF consumes rank — so inheriting a store's row order silently
      // makes ranking depend on how the store sorts. Measured: an in-memory
      // source interleaving each seed's neighbours scored recall@10 0.983,
      // while a database source ordering by id scored 0.700 over the same
      // edges, because sorting by id put every wiki page ahead of every code
      // file and pushed the relevant file past k.
      const byOrigin = new Map<string, Link[]>();
      for (const link of links) {
        if (
          this.options.types !== undefined &&
          !this.options.types.includes(link.type)
        )
          continue;
        const existing = byOrigin.get(link.from);
        if (existing === undefined) byOrigin.set(link.from, [link]);
        else existing.push(link);
      }

      const next: string[] = [];
      for (const origin of frontier) {
        // Within one seed, order by link type then id — again the arm's choice,
        // not the store's.
        const ordered = (byOrigin.get(origin) ?? [])
          .slice()
          .sort(
            (a, b) =>
              TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type] ||
              (a.to < b.to ? -1 : a.to > b.to ? 1 : 0),
          );
        for (const { to: neighbour } of ordered) {
          // Never return the seeds themselves. Their own arm already ranked
          // them, and re-returning them would let one document collect a second
          // RRF contribution simply for being well-linked.
          if (seen.has(neighbour)) continue;
          seen.add(neighbour);
          discovered.push(neighbour);
          next.push(neighbour);
        }
      }

      if (next.length === 0) break;
      frontier = next;
    }

    if (discovered.length === 0) return [];

    // The ACL check happens here, on resolution — a link is reachability, never
    // permission.
    return this.resolver.resolve(discovered, viewer, query);
  }
}
