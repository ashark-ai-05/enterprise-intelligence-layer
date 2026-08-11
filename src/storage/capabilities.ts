/**
 * Capability detection.
 *
 * Probed at boot and stored, never configured and never assumed. Retrieval
 * selects arms from this table: a missing capability disables an arm, it never
 * errors and never silently returns wrong results.
 *
 * A useful inversion to remember: `pgvector` may be *more* available under the
 * embedded profile (an npm package) than under a corporate hosted Postgres (a
 * DBA approval). Neither can be relied on, which is why the extension-free
 * float4[] path stays the default. → docs/adr/0002, docs/adr/0012
 */

import type { Capabilities, Database } from './port.js';

async function extensionAvailable(db: Database, name: string): Promise<boolean> {
  try {
    const { rows } = await db.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_available_extensions WHERE name = $1
         UNION ALL
         SELECT 1 FROM pg_extension WHERE extname = $1
       ) AS present`,
      [name],
    );
    return rows[0]?.present === true;
  } catch {
    return false;
  }
}

async function skipLockedUsable(db: Database): Promise<boolean> {
  try {
    // Probe against a real relation so the parser actually validates the clause.
    await db.query('SELECT name FROM capabilities FOR UPDATE SKIP LOCKED');
    return true;
  } catch {
    return false;
  }
}

export async function probeCapabilities(db: Database): Promise<Capabilities> {
  const [vector, trgm, bm25, skipLocked] = await Promise.all([
    extensionAvailable(db, 'vector'),
    extensionAvailable(db, 'pg_trgm'),
    extensionAvailable(db, 'pg_search'),
    skipLockedUsable(db),
  ]);

  return {
    vector,
    trgm,
    bm25,
    skipLocked,
    // PGlite is one process. Concurrency is 1, and the job queue must be
    // correct at that concurrency — SKIP LOCKED already is.
    concurrentWriters: db.profile === 'server',
  };
}

/** Probe, persist, and return. The stored row is what operators and `doctor` read. */
export async function detectAndStoreCapabilities(db: Database): Promise<Capabilities> {
  const capabilities = await probeCapabilities(db);

  await db.transaction(async (tx) => {
    for (const [name, available] of Object.entries(capabilities)) {
      await tx.query(
        `INSERT INTO capabilities (name, available, detected_at) VALUES ($1, $2, now())
         ON CONFLICT (name) DO UPDATE SET available = EXCLUDED.available, detected_at = now()`,
        [name, available],
      );
    }
  });

  return capabilities;
}
