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
 * An interface rather than a table because no link store exists yet: the corpus
 * generates links, nothing persists them. Implementing this against an
 * in-memory edge list proves whether expansion is worth a schema change, before
 * anyone builds the schema.
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

    const seedIds = new Set(seeds.map((hit) => hit.id));
    let frontier = [...seedIds];
    const discovered = new Set<string>();

    for (let hop = 0; hop < depth; hop += 1) {
      const links = await this.links.neighbours(frontier);
      const next: string[] = [];

      for (const link of links) {
        if (
          this.options.types !== undefined &&
          !this.options.types.includes(link.type)
        )
          continue;
        // Never return the seeds themselves. Their own arm already ranked them,
        // and re-returning them would let one document collect a second RRF
        // contribution simply for being well-linked.
        if (seedIds.has(link.to) || discovered.has(link.to)) continue;
        discovered.add(link.to);
        next.push(link.to);
      }

      if (next.length === 0) break;
      frontier = next;
    }

    if (discovered.size === 0) return [];

    // The ACL check happens here, on resolution — a link is reachability, never
    // permission.
    return this.resolver.resolve([...discovered], viewer, query);
  }
}
