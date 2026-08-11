import { randomUUID } from "node:crypto";
import type { AccessControlEntry } from "../connectors/types.js";
import type { Database } from "../storage/database.js";
import { withTransaction } from "../storage/database.js";

export interface PrincipalRef {
  domain: string;
  principalId: string;
}

export interface AuthorizedChunk {
  chunkId: string;
  resourceId: string;
  source: string;
  sourceObjectId: string;
  containerId: string;
  stableKey: string;
  kind: string;
  text: string;
  location: Record<string, unknown>;
}

export async function ensureContainer(
  db: Database,
  tenantId: string,
  source: string,
  sourceContainerId: string,
  name: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO containers (id, tenant_id, source, source_container_id, name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, source, source_container_id) DO UPDATE SET
       name = EXCLUDED.name, updated_at = now()
     RETURNING id`,
    [randomUUID(), tenantId, source, sourceContainerId, name],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("container upsert returned no row");
  return id;
}

export async function assignResourceContainer(
  db: Database,
  tenantId: string,
  resourceId: string,
  containerId: string,
): Promise<void> {
  const result = await db.query(
    `UPDATE resources r SET container_id = $3, updated_at = now()
     WHERE r.id = $1 AND r.tenant_id = $2
       AND EXISTS (SELECT 1 FROM containers c WHERE c.id = $3 AND c.tenant_id = $2)`,
    [resourceId, tenantId, containerId],
  );
  if (result.rowCount !== 1)
    throw new Error("resource and container must exist in the same tenant");
}

export async function replaceContainerAces(
  db: Database,
  tenantId: string,
  containerId: string,
  aces: AccessControlEntry[],
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const container = await tx.query<{ id: string }>(
      "SELECT id FROM containers WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
      [containerId, tenantId],
    );
    if (!container.rows[0])
      throw new Error(`unknown container: ${containerId}`);
    await tx.query("DELETE FROM container_aces WHERE container_id = $1", [
      containerId,
    ]);
    const unique = new Map<string, AccessControlEntry>();
    for (const ace of aces) {
      unique.set(
        `${ace.domain}\u0000${ace.principalId}\u0000${ace.effect}`,
        ace,
      );
    }
    for (const ace of unique.values()) {
      await tx.query(
        `INSERT INTO container_aces (container_id, principal_domain, principal_id, effect)
         VALUES ($1, $2, $3, $4)`,
        [containerId, ace.domain, ace.principalId, ace.effect],
      );
    }
  });
}

export async function mapPrincipal(
  db: Database,
  tenantId: string,
  subject: string,
  principal: PrincipalRef,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const identity = await tx.query<{ id: string }>(
      `INSERT INTO enterprise_identities (id, tenant_id, subject)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, subject) DO UPDATE SET subject = EXCLUDED.subject
       RETURNING id`,
      [randomUUID(), tenantId, subject],
    );
    const identityId = identity.rows[0]?.id;
    if (!identityId) throw new Error("identity upsert returned no row");
    await tx.query(
      `INSERT INTO principal_mappings (
        tenant_id, authorization_domain, source_identifier, enterprise_identity_id
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id, authorization_domain, source_identifier, enterprise_identity_id)
      DO UPDATE SET updated_at = now()`,
      [tenantId, principal.domain, principal.principalId, identityId],
    );
    await tx.query(
      `DELETE FROM unmapped_principals
       WHERE tenant_id = $1 AND authorization_domain = $2 AND source_identifier = $3`,
      [tenantId, principal.domain, principal.principalId],
    );
  });
}

export async function markPrincipalUnmapped(
  db: Database,
  tenantId: string,
  principal: PrincipalRef,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx.query(
      `DELETE FROM principal_mappings
       WHERE tenant_id = $1 AND authorization_domain = $2 AND source_identifier = $3`,
      [tenantId, principal.domain, principal.principalId],
    );
    await tx.query(
      `INSERT INTO unmapped_principals (
        tenant_id, authorization_domain, source_identifier
      ) VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, authorization_domain, source_identifier)
      DO UPDATE SET updated_at = now()`,
      [tenantId, principal.domain, principal.principalId],
    );
  });
}

export async function resolveViewerPrincipals(
  db: Database,
  tenantId: string,
  subject: string,
): Promise<PrincipalRef[]> {
  const result = await db.query<{ domain: string; principal_id: string }>(
    `SELECT pm.authorization_domain AS domain, pm.source_identifier AS principal_id
     FROM principal_mappings pm
     JOIN enterprise_identities ei ON ei.id = pm.enterprise_identity_id
     WHERE pm.tenant_id = $1 AND ei.tenant_id = $1 AND ei.subject = $2
     ORDER BY pm.authorization_domain, pm.source_identifier`,
    [tenantId, subject],
  );
  return result.rows.map(({ domain, principal_id }) => ({
    domain,
    principalId: principal_id,
  }));
}

export async function listAuthorizedChunks(
  db: Database,
  tenantId: string,
  principals: PrincipalRef[],
  containerIds: string[] = [],
  lexicalQuery?: string,
): Promise<AuthorizedChunk[]> {
  if (principals.length === 0) return [];
  const domains = principals.map(({ domain }) => domain);
  const ids = principals.map(({ principalId }) => principalId);
  const normalizedQuery = lexicalQuery?.trim() || null;
  const result = await db.query<{
    chunk_id: string;
    resource_id: string;
    source: string;
    source_object_id: string;
    container_id: string;
    stable_key: string;
    kind: string;
    text: string;
    location: Record<string, unknown> | string;
  }>(
    `SELECT
       ch.id AS chunk_id, r.id AS resource_id, r.source, r.source_object_id,
       r.container_id, ch.stable_key, ch.kind, ch.text, ch.location
     FROM resource_chunks ch
     JOIN resources r ON r.id = ch.resource_id
     WHERE r.tenant_id = $1
       AND r.deleted_at IS NULL AND ch.deleted_at IS NULL
       AND r.published_generation_id IS NOT NULL
       AND r.container_id IS NOT NULL
       AND (cardinality($4::uuid[]) = 0 OR r.container_id = ANY($4::uuid[]))
       AND (
         $5::text IS NULL
         OR ch.search_vector @@ to_tsquery(
           'simple',
           array_to_string(tsvector_to_array(to_tsvector('simple', $5)), ' | ')
         )
       )
       AND EXISTS (
         SELECT 1 FROM container_aces ca
         WHERE ca.container_id = r.container_id AND ca.effect = 'allow'
           AND (ca.principal_domain, ca.principal_id) IN (
             SELECT * FROM unnest($2::text[], $3::text[])
           )
       )
       AND NOT EXISTS (
         SELECT 1 FROM container_aces ca
         WHERE ca.container_id = r.container_id AND ca.effect = 'deny'
           AND (ca.principal_domain, ca.principal_id) IN (
             SELECT * FROM unnest($2::text[], $3::text[])
           )
       )
       AND NOT EXISTS (
         SELECT 1 FROM resource_aces ra
         WHERE ra.resource_id = r.id AND ra.effect = 'deny'
           AND (ra.principal_domain, ra.principal_id) IN (
             SELECT * FROM unnest($2::text[], $3::text[])
           )
       )
       AND (
         NOT EXISTS (SELECT 1 FROM resource_aces ra WHERE ra.resource_id = r.id AND ra.effect = 'allow')
         OR EXISTS (
           SELECT 1 FROM resource_aces ra
           WHERE ra.resource_id = r.id AND ra.effect = 'allow'
             AND (ra.principal_domain, ra.principal_id) IN (
               SELECT * FROM unnest($2::text[], $3::text[])
             )
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM chunk_aces cha
         WHERE cha.chunk_id = ch.id AND cha.effect = 'deny'
           AND (cha.principal_domain, cha.principal_id) IN (
             SELECT * FROM unnest($2::text[], $3::text[])
           )
       )
       AND (
         NOT EXISTS (SELECT 1 FROM chunk_aces cha WHERE cha.chunk_id = ch.id AND cha.effect = 'allow')
         OR EXISTS (
           SELECT 1 FROM chunk_aces cha
           WHERE cha.chunk_id = ch.id AND cha.effect = 'allow'
             AND (cha.principal_domain, cha.principal_id) IN (
               SELECT * FROM unnest($2::text[], $3::text[])
             )
         )
       )
     ORDER BY r.source, r.source_object_id, ch.ordinal`,
    [tenantId, domains, ids, containerIds, normalizedQuery],
  );
  return result.rows.map((row) => ({
    chunkId: row.chunk_id,
    resourceId: row.resource_id,
    source: row.source,
    sourceObjectId: row.source_object_id,
    containerId: row.container_id,
    stableKey: row.stable_key,
    kind: row.kind,
    text: row.text,
    location:
      typeof row.location === "string"
        ? (JSON.parse(row.location) as Record<string, unknown>)
        : row.location,
  }));
}

export async function listAuthorizedChunksForSubject(
  db: Database,
  tenantId: string,
  subject: string,
  containerIds: string[] = [],
  lexicalQuery?: string,
): Promise<AuthorizedChunk[]> {
  const principals = await resolveViewerPrincipals(db, tenantId, subject);
  return listAuthorizedChunks(
    db,
    tenantId,
    principals,
    containerIds,
    lexicalQuery,
  );
}
