import { randomUUID } from "node:crypto";
import type { Link, LinkSource, LinkType } from "../retrieval/graph-arm.js";
import type { Source } from "../scopes/types.js";
import type { Database } from "../storage/database.js";
import type { ExtractedResourceLink } from "./extract.js";

export async function replaceResourceLinks(
  db: Database,
  tenantId: string,
  resourceId: string,
  source: Source,
  sourceObjectId: string,
  sourceVersion: string,
  links: readonly ExtractedResourceLink[],
): Promise<void> {
  const resource = await db.query<{ id: string }>(
    `SELECT id FROM resources
     WHERE id = $1 AND tenant_id = $2 AND source = $3 AND source_object_id = $4`,
    [resourceId, tenantId, source, sourceObjectId],
  );
  if (!resource.rows[0]) {
    throw new Error("resource link origin must match the tenant and source");
  }
  await db.query(
    "DELETE FROM resource_links WHERE from_resource_id = $1 AND tenant_id = $2",
    [resourceId, tenantId],
  );
  for (const link of links) {
    await db.query(
      `INSERT INTO resource_links (
        id, tenant_id, from_resource_id, from_source, from_source_object_id,
        to_source, to_source_object_id, link_type, origin, source_version,
        extractor_version, confidence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        randomUUID(),
        tenantId,
        resourceId,
        source,
        sourceObjectId,
        link.source,
        link.sourceObjectId,
        link.type,
        link.origin,
        sourceVersion,
        link.extractorVersion,
        link.confidence,
      ],
    );
  }
}

export class DatabaseLinkSource implements LinkSource {
  constructor(
    private readonly db: Database,
    private readonly tenantId: string,
  ) {}

  async neighbours(sourceObjectIds: readonly string[]): Promise<Link[]> {
    if (sourceObjectIds.length === 0) return [];
    const result = await this.db.query<{
      from_id: string;
      to_id: string;
      link_type: LinkType;
    }>(
      `SELECT from_source_object_id AS from_id, to_source_object_id AS to_id, link_type
       FROM resource_links
       WHERE tenant_id = $1
         AND (
           from_source_object_id = ANY($2::text[])
           OR to_source_object_id = ANY($2::text[])
         )
       ORDER BY from_source_object_id, to_source_object_id, link_type`,
      [this.tenantId, [...new Set(sourceObjectIds)]],
    );
    const requested = new Set(sourceObjectIds);
    const links: Link[] = [];
    for (const row of result.rows) {
      if (requested.has(row.from_id)) {
        links.push({ from: row.from_id, to: row.to_id, type: row.link_type });
      }
      if (requested.has(row.to_id)) {
        links.push({ from: row.to_id, to: row.from_id, type: row.link_type });
      }
    }
    return links;
  }
}
