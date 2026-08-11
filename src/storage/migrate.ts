/**
 * Migration runner.
 *
 * Plain SQL files and about a hundred lines. No ORM: the schema is the product,
 * and an ORM is the mechanism by which the ACL predicate eventually gets
 * omitted from one query. → docs/adr/0002
 */

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './port.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
}

const CREATE_LEDGER = `
CREATE TABLE IF NOT EXISTS _migrations (
  name        text PRIMARY KEY,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
)`;

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<{ name: string; sql: string }[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })),
  );
}

/**
 * Apply every pending migration, in filename order, each in its own transaction.
 *
 * An already-applied migration whose file has since changed is an error, not a
 * re-run. Silently diverging schemas between two machines is the failure this
 * prevents.
 */
export async function migrate(db: Database, dir: string = MIGRATIONS_DIR): Promise<AppliedMigration[]> {
  await db.exec(CREATE_LEDGER);

  const { rows } = await db.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM _migrations',
  );
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));
  const migrations = await loadMigrations(dir);
  const newlyApplied: AppliedMigration[] = [];

  for (const { name, sql } of migrations) {
    const checksum = checksumOf(sql);
    const previous = applied.get(name);

    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${name} has changed since it was applied ` +
            `(recorded ${previous}, file ${checksum}). Add a new migration instead of editing this one.`,
        );
      }
      continue;
    }

    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO _migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
    });
    newlyApplied.push({ name, checksum });
  }

  return newlyApplied;
}
