import { listAuthorizedChunks } from "../security/acl.js";
import type { Database } from "../storage/database.js";
import type { LinkType } from "./graph-arm.js";
import { toPrincipalRefs } from "./principals.js";
import type { RetrievalHit, Viewer } from "./types.js";

export class AmbiguousObjectIdError extends Error {
  constructor(id: string, sources: readonly string[]) {
    super(
      `source object id '${id}' exists in multiple sources: ${sources.join(", ")}; provide source`,
    );
    this.name = "AmbiguousObjectIdError";
  }
}

export interface ExactObjectResult {
  readonly id: string;
  readonly source?: string;
  readonly found: boolean;
  readonly hit?: RetrievalHit;
}

/** Resolve a canonical source object id through the same ACL predicate as search. */
export async function resolveExactObject(
  db: Database,
  tenantId: string,
  viewer: Viewer,
  id: string,
  source?: string,
): Promise<ExactObjectResult> {
  const chunks = await listAuthorizedChunks(
    db,
    tenantId,
    toPrincipalRefs(viewer.principals),
    [...viewer.containers],
    undefined,
    [id],
  );
  const matching =
    source === undefined
      ? chunks
      : chunks.filter((chunk) => chunk.source === source);
  const sources = [...new Set(matching.map((chunk) => chunk.source))].sort();
  if (source === undefined && sources.length > 1)
    throw new AmbiguousObjectIdError(id, sources);
  const first = matching[0];
  if (first === undefined)
    return { id, ...(source === undefined ? {} : { source }), found: false };
  const details = await db.query<{
    title: string | null;
    canonical_uri: string | null;
  }>(
    `SELECT title, canonical_uri FROM resources
      WHERE tenant_id = $1 AND source = $2 AND source_object_id = $3 AND deleted_at IS NULL`,
    [tenantId, first.source, id],
  );
  const detail = details.rows[0];
  return {
    id,
    source: first.source,
    found: true,
    hit: {
      id,
      source: first.source,
      container: first.containerId,
      title: detail?.title ?? id,
      url: detail?.canonical_uri ?? `eil://${first.source}/${id}`,
      snippet: first.text.slice(0, 300),
      syncedAt: new Date(0).toISOString(),
    },
  };
}

export interface RelatedEvidenceItem extends RetrievalHit {
  readonly anchorId: string;
  readonly anchorSource: string;
  readonly relation: LinkType;
}

export interface RelatedEvidenceResult {
  readonly anchorId: string;
  readonly anchorSource?: string;
  readonly found: boolean;
  readonly evidence: readonly RelatedEvidenceItem[];
}

/** Traverse from a known anchor; the anchor and every neighbour are ACL checked. */
export async function relatedEvidence(
  db: Database,
  tenantId: string,
  viewer: Viewer,
  anchorId: string,
  limit = 20,
  source?: string,
): Promise<RelatedEvidenceResult> {
  const anchor = await resolveExactObject(
    db,
    tenantId,
    viewer,
    anchorId,
    source,
  );
  if (!anchor.found || anchor.source === undefined) {
    return {
      anchorId,
      ...(source === undefined ? {} : { anchorSource: source }),
      found: false,
      evidence: [],
    };
  }
  const edgeRows = await db.query<{
    neighbour_source: string;
    neighbour_id: string;
    link_type: LinkType;
  }>(
    `SELECT CASE WHEN from_source = $2 AND from_source_object_id = $3 THEN to_source ELSE from_source END AS neighbour_source,
            CASE WHEN from_source = $2 AND from_source_object_id = $3 THEN to_source_object_id ELSE from_source_object_id END AS neighbour_id,
            link_type
       FROM resource_links
      WHERE tenant_id = $1
        AND ((from_source = $2 AND from_source_object_id = $3)
          OR (to_source = $2 AND to_source_object_id = $3))
      ORDER BY link_type, neighbour_source, neighbour_id`,
    [tenantId, anchor.source, anchorId],
  );
  const resolved = await Promise.all(
    edgeRows.rows.map(async (edge) => ({
      edge,
      object: await resolveExactObject(
        db,
        tenantId,
        viewer,
        edge.neighbour_id,
        edge.neighbour_source,
      ),
    })),
  );
  const visible = resolved.filter(
    (item) => item.object.found && item.object.hit !== undefined,
  );
  return {
    anchorId,
    anchorSource: anchor.source,
    found: true,
    evidence: visible.slice(0, limit).map(({ edge, object }) => ({
      ...(object.hit as RetrievalHit),
      anchorId,
      anchorSource: anchor.source as string,
      relation: edge.link_type,
    })),
  };
}
