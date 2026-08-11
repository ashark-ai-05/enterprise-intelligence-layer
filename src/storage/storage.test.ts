import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openEmbedded } from './embedded.js';
import { migrate } from './migrate.js';
import { detectAndStoreCapabilities, probeCapabilities } from './capabilities.js';
import { profileFor } from './open.js';
import {
  addScope,
  claimDocument,
  getScope,
  listScopes,
  removeScope,
  scopeId,
  validateScope,
} from './scopes.js';
import type { Database } from './port.js';

let db: Database;

beforeEach(async () => {
  db = await openEmbedded(); // in-memory
  await migrate(db);
});

afterEach(async () => {
  await db.close();
});

async function insertDocument(source: string, externalId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO documents (source, external_id) VALUES ($1, $2) RETURNING id',
    [source, externalId],
  );
  return rows[0]!.id;
}

describe('profileFor', () => {
  it('defaults to embedded when DATABASE_URL is absent or blank', () => {
    expect(profileFor(undefined)).toBe('embedded');
    expect(profileFor('')).toBe('embedded');
    expect(profileFor('   ')).toBe('embedded');
  });

  it('treats a pglite: url as embedded', () => {
    expect(profileFor('pglite:///Users/me/.eil/data')).toBe('embedded');
  });

  it('treats a postgres: url as server', () => {
    expect(profileFor('postgres://host:5432/eil')).toBe('server');
  });
});

describe('migrate', () => {
  it('is idempotent — a second run applies nothing', async () => {
    const second = await migrate(db);
    expect(second).toEqual([]);
  });

  it('records what it applied', async () => {
    const { rows } = await db.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toContain('001_init.sql');
  });

  it('refuses to silently accept an edited migration', async () => {
    await db.query("UPDATE _migrations SET checksum = 'tampered' WHERE name = '001_init.sql'");
    await expect(migrate(db)).rejects.toThrow(/has changed since it was applied/);
  });
});

describe('capabilities', () => {
  it('reports concurrentWriters false under the embedded profile', async () => {
    // PGlite is one process. The job queue must be correct at concurrency 1.
    const capabilities = await probeCapabilities(db);
    expect(capabilities.concurrentWriters).toBe(false);
  });

  it('detects SKIP LOCKED, which the job queue depends on', async () => {
    const capabilities = await probeCapabilities(db);
    expect(capabilities.skipLocked).toBe(true);
  });

  it('never throws on a missing extension — it reports false', async () => {
    const capabilities = await probeCapabilities(db);
    expect(typeof capabilities.vector).toBe('boolean');
    expect(typeof capabilities.trgm).toBe('boolean');
    expect(typeof capabilities.bm25).toBe('boolean');
  });

  it('persists what it detected, so operators and doctor read the same row', async () => {
    await detectAndStoreCapabilities(db);
    const { rows } = await db.query<{ name: string; available: boolean }>(
      'SELECT name, available FROM capabilities ORDER BY name',
    );
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(['bm25', 'concurrentWriters', 'skipLocked', 'trgm', 'vector']),
    );
  });

  it('re-probing updates rather than duplicating', async () => {
    await detectAndStoreCapabilities(db);
    await detectAndStoreCapabilities(db);
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*) AS count FROM capabilities WHERE name = 'vector'",
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});

describe('transaction', () => {
  it('rolls back on failure', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO documents (source, external_id) VALUES ('confluence', 'rollback-me')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const { rows } = await db.query("SELECT id FROM documents WHERE external_id = 'rollback-me'");
    expect(rows).toHaveLength(0);
  });

  it('keeps working after a rolled-back transaction — one failure must not wedge the process', async () => {
    await expect(db.transaction(async () => Promise.reject(new Error('first')))).rejects.toThrow('first');
    await insertDocument('confluence', 'after-failure');
    const { rows } = await db.query("SELECT id FROM documents WHERE external_id = 'after-failure'");
    expect(rows).toHaveLength(1);
  });

  it('serialises concurrent transactions rather than interleaving them', async () => {
    // PGlite has one connection; overlapping BEGIN/COMMIT would corrupt atomicity.
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        db.transaction(async (tx) => {
          await tx.query('INSERT INTO documents (source, external_id) VALUES ($1, $2)', [
            'jira',
            `concurrent-${i}`,
          ]);
        }),
      ),
    );
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*) AS count FROM documents WHERE source = 'jira'",
    );
    expect(Number(rows[0]!.count)).toBe(5);
  });
});

describe('scope validation', () => {
  it('builds a stable, human-readable id', () => {
    expect(scopeId('confluence', 'space', 'ARCH')).toBe('confluence:space:ARCH');
  });

  it('rejects a selector the source cannot honour', () => {
    expect(() =>
      validateScope({ source: 'jira', selectorKind: 'space', selector: 'ARCH', addedBy: 'me' }),
    ).toThrow(/does not accept a 'space' selector/);
  });

  it('requires a schedule for a scheduled scope', () => {
    expect(() =>
      validateScope({
        source: 'confluence',
        selectorKind: 'space',
        selector: 'ARCH',
        trigger: 'scheduled',
        addedBy: 'me',
      }),
    ).toThrow(/requires a schedule/);
  });

  it('rejects a schedule on a manual scope', () => {
    expect(() =>
      validateScope({
        source: 'confluence',
        selectorKind: 'space',
        selector: 'ARCH',
        trigger: 'manual',
        schedule: '1h',
        addedBy: 'me',
      }),
    ).toThrow(/must not carry a schedule/);
  });

  it('rejects an empty selector', () => {
    expect(() =>
      validateScope({ source: 'confluence', selectorKind: 'space', selector: '  ', addedBy: 'me' }),
    ).toThrow(/must not be empty/);
  });
});

describe('scope registry', () => {
  it('adds and reads back a scope', async () => {
    const scope = await addScope(db, {
      source: 'confluence',
      selectorKind: 'space',
      selector: 'ARCH',
      addedBy: 'krunal',
    });
    expect(scope.id).toBe('confluence:space:ARCH');
    expect(scope.trigger).toBe('manual');
    expect(scope.recursive).toBe(true);
    expect(await getScope(db, scope.id)).toEqual(scope);
  });

  it('re-adding a scope updates it instead of erroring', async () => {
    await addScope(db, { source: 'jira', selectorKind: 'project', selector: 'PHX', addedBy: 'krunal' });
    const updated = await addScope(db, {
      source: 'jira',
      selectorKind: 'project',
      selector: 'PHX',
      trigger: 'scheduled',
      schedule: '1h',
      addedBy: 'krunal',
    });
    expect(updated.trigger).toBe('scheduled');
    expect(updated.schedule).toBe('1h');
    expect(await listScopes(db)).toHaveLength(1);
  });

  it('supports a monorepo subtree selector', async () => {
    const scope = await addScope(db, {
      source: 'bitbucket',
      selectorKind: 'repo',
      selector: 'PLAT/monorepo@main:services/payments/**',
      addedBy: 'krunal',
    });
    expect(scope.selector).toContain('services/payments/**');
  });

  it('enforces the schedule/trigger constraint at the database level too', async () => {
    // Defence in depth: validateScope guards the API, the CHECK guards the data.
    await expect(
      db.query(
        `INSERT INTO scopes (id, source, selector_kind, selector, trigger, schedule, added_by)
         VALUES ('x', 'confluence', 'space', 'X', 'manual', '1h', 'me')`,
      ),
    ).rejects.toThrow();
  });
});

describe('scope removal — refcounting', () => {
  it('keeps a document that another scope still claims', async () => {
    const space = await addScope(db, {
      source: 'confluence',
      selectorKind: 'space',
      selector: 'ARCH',
      addedBy: 'krunal',
    });
    const page = await addScope(db, {
      source: 'confluence',
      selectorKind: 'page',
      selector: '81923',
      addedBy: 'krunal',
    });

    const shared = await insertDocument('confluence', '81923');
    await claimDocument(db, shared, space.id);
    await claimDocument(db, shared, page.id);

    const result = await removeScope(db, space.id, 'purge');
    expect(result.documentsPurged).toBe(0);
    expect(result.documentsRetained).toBe(1);

    const { rows } = await db.query("SELECT id FROM documents WHERE external_id = '81923'");
    expect(rows).toHaveLength(1);
  });

  it('purges a document whose last scope this was', async () => {
    const space = await addScope(db, {
      source: 'confluence',
      selectorKind: 'space',
      selector: 'OLD',
      addedBy: 'krunal',
    });
    const only = await insertDocument('confluence', 'only-here');
    await claimDocument(db, only, space.id);

    const result = await removeScope(db, space.id, 'purge');
    expect(result.documentsPurged).toBe(1);

    const { rows } = await db.query("SELECT id FROM documents WHERE external_id = 'only-here'");
    expect(rows).toHaveLength(0);
  });

  it('retains documents by default — unsubscribing is not deleting', async () => {
    const space = await addScope(db, {
      source: 'confluence',
      selectorKind: 'space',
      selector: 'KEEP',
      addedBy: 'krunal',
    });
    const doc = await insertDocument('confluence', 'keep-me');
    await claimDocument(db, doc, space.id);

    const result = await removeScope(db, space.id);
    expect(result.scopeRemoved).toBe(true);
    expect(result.documentsPurged).toBe(0);

    const { rows } = await db.query("SELECT id FROM documents WHERE external_id = 'keep-me'");
    expect(rows).toHaveLength(1);
  });

  it('reports cleanly when the scope does not exist', async () => {
    const result = await removeScope(db, 'confluence:space:NOPE', 'purge');
    expect(result).toEqual({ scopeRemoved: false, documentsPurged: 0, documentsRetained: 0 });
  });

  it('claiming a document twice from the same scope is one claim', async () => {
    const scope = await addScope(db, {
      source: 'jira',
      selectorKind: 'project',
      selector: 'PHX',
      addedBy: 'krunal',
    });
    const doc = await insertDocument('jira', 'PHX-1');
    await claimDocument(db, doc, scope.id);
    await claimDocument(db, doc, scope.id);

    const { rows } = await db.query<{ count: string }>(
      'SELECT count(*) AS count FROM document_scopes WHERE document_id = $1',
      [doc],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });
});
