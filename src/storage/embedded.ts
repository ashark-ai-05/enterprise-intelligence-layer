/**
 * The `embedded` profile: PGlite, WASM Postgres, in-process.
 *
 * PGlite is single-user / single-connection by design — Emscripten cannot fork,
 * so Postgres is compiled in single-user mode. Everything below follows from
 * that: one handle, serialised transactions, one worker.
 */

import type { PGlite } from '@electric-sql/pglite';
import { StorageError, type Database, type Queryable, type QueryResult } from './port.js';

class EmbeddedDatabase implements Database {
  readonly profile = 'embedded' as const;

  /**
   * Serialises every statement onto one promise chain. PGlite has a single
   * connection, so overlapping transactions would interleave their statements
   * and corrupt each other's atomicity.
   */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly pg: PGlite) {}

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work, work);
    // Keep the chain alive after a rejection so one failure cannot wedge the process.
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.#enqueue(() => this.#rawQuery<Row>(sql, params));
  }

  async #rawQuery<Row>(sql: string, params: readonly unknown[]): Promise<QueryResult<Row>> {
    try {
      const result = await this.pg.query<Row>(sql, params as unknown[]);
      return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
    } catch (cause) {
      throw new StorageError(`query failed: ${firstLine(sql)}`, cause);
    }
  }

  async exec(sql: string): Promise<void> {
    await this.#enqueue(() => this.#rawExec(sql));
  }

  async #rawExec(sql: string): Promise<void> {
    try {
      // PGlite's `exec` uses the simple query protocol, which is the only one
      // that accepts multiple statements in a single message.
      await this.pg.exec(sql);
    } catch (cause) {
      throw new StorageError(`script failed: ${firstLine(sql)}`, cause);
    }
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      // The handle passed to `work` bypasses the queue: we are already inside
      // it, and re-entering would deadlock. This is the concrete shape of the
      // "one handle per unit of work" rule.
      const tx: Queryable = {
        query: <Row>(sql: string, params: readonly unknown[] = []) => this.#rawQuery<Row>(sql, params),
        exec: (sql: string) => this.#rawExec(sql),
      };
      await this.#rawQuery('BEGIN', []);
      try {
        const value = await work(tx);
        await this.#rawQuery('COMMIT', []);
        return value;
      } catch (error) {
        try {
          await this.#rawQuery('ROLLBACK', []);
        } catch {
          // A failed rollback must not mask the original error.
        }
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.#enqueue(() => this.pg.close());
  }
}

function firstLine(sql: string): string {
  const line = sql.trim().split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * Open an embedded database.
 *
 * @param dataDir Filesystem directory, or `undefined` for an in-memory database
 *                (used by tests).
 */
export async function openEmbedded(dataDir?: string): Promise<Database> {
  const { PGlite: PGliteCtor } = await import('@electric-sql/pglite');
  const pg = dataDir === undefined ? new PGliteCtor() : new PGliteCtor(dataDir);
  await pg.waitReady;
  return new EmbeddedDatabase(pg);
}
