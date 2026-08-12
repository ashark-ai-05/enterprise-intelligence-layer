/**
 * Give a hit the details a human or an agent can act on.
 *
 * The arms build hits from chunk rows, and a chunk knows its stable key — a
 * value like `lines:1` or `body` — but not the document's title or where it
 * came from. Returned unadorned that produces results such as:
 *
 *     git   payments:docs/payments.md
 *       lines:1
 *       eil://git/payments:docs/payments.md
 *
 * which names the file twice and says nothing about what is in it. The title
 * and the canonical URI live on `resources`, one join away, and turn the same
 * result into something worth reading.
 *
 * Applied after ranking, for the results actually being returned — never
 * across every candidate.
 */

import type { Database } from "../storage/database.js";
import type { RetrievalHit } from "./types.js";

export interface ResourceDetail {
  readonly title: string;
  readonly canonicalUri: string;
}

/** Look up titles and canonical URIs for the given source object ids. */
export async function resourceDetails(
  db: Database,
  tenantId: string,
  sourceObjectIds: readonly string[],
): Promise<Map<string, ResourceDetail>> {
  if (sourceObjectIds.length === 0) return new Map();

  const result = await db.query<{
    source_object_id: string;
    title: string | null;
    canonical_uri: string | null;
  }>(
    `SELECT source_object_id, title, canonical_uri
       FROM resources
      WHERE tenant_id = $1 AND deleted_at IS NULL AND source_object_id = ANY($2::text[])`,
    [tenantId, [...new Set(sourceObjectIds)]],
  );

  const details = new Map<string, ResourceDetail>();
  for (const row of result.rows) {
    details.set(row.source_object_id, {
      title: row.title ?? row.source_object_id,
      canonicalUri: row.canonical_uri ?? "",
    });
  }
  return details;
}

/**
 * Replace placeholder titles and internal URIs with the real ones.
 *
 * Falls back to what the hit already carried, so a resource that has since been
 * deleted degrades to a usable result rather than an empty one.
 */
export async function decorateHits(
  db: Database,
  tenantId: string,
  hits: readonly RetrievalHit[],
): Promise<RetrievalHit[]> {
  if (hits.length === 0) return [];

  const details = await resourceDetails(
    db,
    tenantId,
    hits.map((hit) => hit.id),
  );

  return hits.map((hit) => {
    const detail = details.get(hit.id);
    if (detail === undefined) return hit;
    return {
      ...hit,
      title: detail.title,
      // The canonical URI is where the document actually lives — the thing a
      // person clicks or an agent fetches. An internal `eil://` identifier is
      // neither.
      url: detail.canonicalUri === "" ? hit.url : detail.canonicalUri,
    };
  });
}
