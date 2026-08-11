/**
 * The scope registry.
 *
 * A scope is a durable statement: "this source material is part of my corpus."
 * Unit of configuration, sync, removal and audit.
 * → docs/adr/0011-scope-driven-ingestion.md
 */

import type { Database } from './port.js';

export type ScopeSource = 'confluence' | 'jira' | 'bitbucket' | 'files';
export type ScopeTrigger = 'manual' | 'scheduled' | 'on-reference';

export type SelectorKind =
  | 'space'
  | 'page'
  | 'label'
  | 'cql'
  | 'project'
  | 'issue'
  | 'jql'
  | 'repo'
  | 'path';

/** Which selectors each source accepts. A selector the source cannot honour is a config error, not a runtime surprise. */
const SELECTORS_BY_SOURCE: Readonly<Record<ScopeSource, readonly SelectorKind[]>> = {
  confluence: ['space', 'page', 'label', 'cql'],
  jira: ['project', 'issue', 'jql'],
  bitbucket: ['repo'],
  files: ['path'],
};

export interface ScopeInput {
  readonly source: ScopeSource;
  readonly selectorKind: SelectorKind;
  readonly selector: string;
  readonly recursive?: boolean;
  readonly trigger?: ScopeTrigger;
  /** Required when trigger is 'scheduled'; forbidden otherwise. */
  readonly schedule?: string;
  readonly addedBy: string;
}

export interface Scope {
  readonly id: string;
  readonly source: ScopeSource;
  readonly selectorKind: SelectorKind;
  readonly selector: string;
  readonly recursive: boolean;
  readonly trigger: ScopeTrigger;
  readonly schedule: string | null;
  readonly enabled: boolean;
  readonly addedBy: string;
  readonly lastSyncAt: Date | null;
  readonly lastStatus: string | null;
}

/**
 * Canonical scope id — `source:selectorKind:selector`.
 *
 * Stable and human-readable, so `scopes` doubles as the artefact a privacy
 * reviewer or a Confluence admin asks for: exactly what has been copied, and
 * by whom.
 */
export function scopeId(source: ScopeSource, selectorKind: SelectorKind, selector: string): string {
  return `${source}:${selectorKind}:${selector}`;
}

export function validateScope(input: ScopeInput): void {
  const allowed = SELECTORS_BY_SOURCE[input.source];
  if (!allowed.includes(input.selectorKind)) {
    throw new Error(
      `${input.source} does not accept a '${input.selectorKind}' selector (accepts: ${allowed.join(', ')})`,
    );
  }
  if (input.selector.trim() === '') {
    throw new Error('scope selector must not be empty');
  }
  const trigger = input.trigger ?? 'manual';
  if (trigger === 'scheduled' && input.schedule === undefined) {
    throw new Error("a 'scheduled' scope requires a schedule");
  }
  if (trigger !== 'scheduled' && input.schedule !== undefined) {
    throw new Error(`a '${trigger}' scope must not carry a schedule`);
  }
}

export async function addScope(db: Database, input: ScopeInput): Promise<Scope> {
  validateScope(input);
  const id = scopeId(input.source, input.selectorKind, input.selector);
  const trigger = input.trigger ?? 'manual';

  await db.query(
    `INSERT INTO scopes (id, source, selector_kind, selector, recursive, trigger, schedule, added_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE
       SET recursive = EXCLUDED.recursive,
           trigger   = EXCLUDED.trigger,
           schedule  = EXCLUDED.schedule,
           enabled   = true`,
    [
      id,
      input.source,
      input.selectorKind,
      input.selector,
      input.recursive ?? true,
      trigger,
      input.schedule ?? null,
      input.addedBy,
    ],
  );

  const scope = await getScope(db, id);
  if (scope === undefined) throw new Error(`scope ${id} vanished immediately after insert`);
  return scope;
}

interface ScopeRow {
  id: string;
  source: string;
  selector_kind: string;
  selector: string;
  recursive: boolean;
  trigger: string;
  schedule: string | null;
  enabled: boolean;
  added_by: string;
  last_sync_at: Date | null;
  last_status: string | null;
}

const toScope = (row: ScopeRow): Scope => ({
  id: row.id,
  source: row.source as ScopeSource,
  selectorKind: row.selector_kind as SelectorKind,
  selector: row.selector,
  recursive: row.recursive,
  trigger: row.trigger as ScopeTrigger,
  schedule: row.schedule,
  enabled: row.enabled,
  addedBy: row.added_by,
  lastSyncAt: row.last_sync_at,
  lastStatus: row.last_status,
});

export async function getScope(db: Database, id: string): Promise<Scope | undefined> {
  const { rows } = await db.query<ScopeRow>('SELECT * FROM scopes WHERE id = $1', [id]);
  const row = rows[0];
  return row === undefined ? undefined : toScope(row);
}

export async function listScopes(db: Database): Promise<Scope[]> {
  const { rows } = await db.query<ScopeRow>('SELECT * FROM scopes ORDER BY id');
  return rows.map(toScope);
}

export type RemovalDisposition = 'retain' | 'purge';

export interface RemovalResult {
  readonly scopeRemoved: boolean;
  /** Documents deleted because this was their last remaining scope. */
  readonly documentsPurged: number;
  /** Documents that survived because another scope still claims them. */
  readonly documentsRetained: number;
}

/**
 * Remove a scope.
 *
 * Two behaviours made explicit rather than discovered:
 *
 *   1. `retain` (the default) unsubscribes without destroying data. Removing a
 *      subscription and deleting a corpus are different intentions, and
 *      conflating them makes the destructive one the default.
 *   2. `purge` deletes only documents whose *last* scope this was. A page
 *      reachable from `space:ARCH` and from `page:81923` must survive removal
 *      of either. `document_scopes` is refcounting, and this is what it is for.
 */
export async function removeScope(
  db: Database,
  id: string,
  disposition: RemovalDisposition = 'retain',
): Promise<RemovalResult> {
  return db.transaction(async (tx) => {
    const { rows: existing } = await tx.query<{ id: string }>('SELECT id FROM scopes WHERE id = $1', [id]);
    if (existing.length === 0) {
      return { scopeRemoved: false, documentsPurged: 0, documentsRetained: 0 };
    }

    // Documents this scope claims, split by whether anything else claims them.
    const { rows: claimed } = await tx.query<{ document_id: string; other_scopes: string }>(
      `SELECT ds.document_id,
              (SELECT count(*) FROM document_scopes o
                WHERE o.document_id = ds.document_id AND o.scope_id <> $1) AS other_scopes
         FROM document_scopes ds
        WHERE ds.scope_id = $1`,
      [id],
    );

    const orphaned = claimed.filter((r) => Number(r.other_scopes) === 0).map((r) => r.document_id);
    const retained = claimed.length - orphaned.length;

    // ON DELETE CASCADE clears document_scopes for this scope.
    await tx.query('DELETE FROM scopes WHERE id = $1', [id]);

    let purged = 0;
    if (disposition === 'purge' && orphaned.length > 0) {
      const result = await tx.query(
        `DELETE FROM documents d
          WHERE d.id = ANY($1::bigint[])
            AND NOT EXISTS (SELECT 1 FROM document_scopes ds WHERE ds.document_id = d.id)`,
        [orphaned],
      );
      purged = result.affectedRows;
    }

    return { scopeRemoved: true, documentsPurged: purged, documentsRetained: retained };
  });
}

/** Record that a document was reached through a scope. Idempotent by design — a document found via two scopes is one row with two claims. */
export async function claimDocument(db: Database, documentId: string | number, scopeIdValue: string): Promise<void> {
  await db.query(
    `INSERT INTO document_scopes (document_id, scope_id) VALUES ($1, $2)
     ON CONFLICT (document_id, scope_id) DO NOTHING`,
    [documentId, scopeIdValue],
  );
}
