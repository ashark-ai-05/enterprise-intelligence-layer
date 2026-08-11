/**
 * Resolve document ids to hits, through the canonical authorized read.
 *
 * Graph expansion produces *ids*; the pipeline needs *hits*, and a neighbour
 * must never be returned unless the viewer is permitted to see it in its own
 * right. This resolver goes through `listAuthorizedChunks`, so the ACL
 * predicate stays in one SQL path — container, resource and chunk ACEs, plus
 * publication, all still apply.
 *
 * **Known cost:** `listAuthorizedChunks` has no id filter, so this reads the
 * viewer's authorized chunks for the requested containers and narrows in
 * process. That is bounded by what the viewer can see, not by the corpus, and
 * it is the same shape of limitation the indexed arm had before the lexical
 * seam landed. The fix is symmetrical: an optional `sourceObjectIds` filter on
 * the canonical read would push this into SQL. Documented rather than worked
 * around with a second ACL predicate.
 */

import { listAuthorizedChunks } from "../security/acl.js";
import type { Database } from "../storage/database.js";
import type { HitResolver } from "./graph-arm.js";
import { toPrincipalRefs } from "./principals.js";
import type { RetrievalHit, RetrievalQuery, Viewer } from "./types.js";

export class AuthorizedHitResolver implements HitResolver {
  constructor(
    private readonly db: Database,
    private readonly tenantId: string,
  ) {}

  async resolve(
    sourceObjectIds: readonly string[],
    viewer: Viewer,
    query: RetrievalQuery,
  ): Promise<RetrievalHit[]> {
    if (sourceObjectIds.length === 0) return [];

    const chunks = await listAuthorizedChunks(
      this.db,
      this.tenantId,
      toPrincipalRefs(viewer.principals),
      query.containers === undefined ? [] : [...query.containers],
      undefined,
      sourceObjectIds,
    );

    // First chunk per resource is enough: expansion answers "this exists and is
    // related", and the consumer fetches the document if it wants more.
    const seen = new Set<string>();
    const hits: RetrievalHit[] = [];

    for (const chunk of chunks) {
      if (seen.has(chunk.sourceObjectId)) continue;
      if (
        query.sources !== undefined &&
        query.sources.length > 0 &&
        !query.sources.includes(chunk.source)
      ) {
        continue;
      }
      seen.add(chunk.sourceObjectId);
      hits.push({
        id: chunk.sourceObjectId,
        source: chunk.source,
        container: chunk.containerId,
        title: chunk.stableKey,
        url: `eil://${chunk.source}/${chunk.sourceObjectId}`,
        snippet: chunk.text.slice(0, 300),
        syncedAt: new Date(0).toISOString(),
      });
    }

    // Stable order: the arm's rank is its array position, and a set iteration
    // order is not a ranking. Ordering by the caller's id list keeps expansion
    // deterministic.
    const order = new Map(sourceObjectIds.map((id, index) => [id, index]));
    return hits.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }
}
