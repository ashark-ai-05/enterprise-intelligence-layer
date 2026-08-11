/**
 * The storage port.
 *
 * Two profiles, one schema, one migration chain, one SQL dialect. Domain code
 * never learns which engine is underneath — only whether a *capability* is
 * present. `if (profile === 'embedded')` is the beginning of two codebases;
 * `if (capabilities.vector)` is a feature test.
 *
 * → docs/adr/0012-storage-profiles.md
 */

export type StorageProfile = 'embedded' | 'server';

export interface QueryResult<Row> {
  readonly rows: Row[];
  readonly affectedRows: number;
}

/**
 * A connection handle.
 *
 * The `embedded` profile has exactly one connection for the whole process
 * (PGlite is single-user by design), so any code path that holds a transaction
 * open and asks for a second connection deadlocks there while passing under
 * `server`. The rule this interface exists to enforce: **one handle per
 * request or job, for its entire lifetime.**
 */
export interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<Row>>;
  /**
   * Execute a multi-statement script with no parameters.
   *
   * Postgres' extended protocol — which every parameterised query uses — permits
   * exactly one statement per message. Migration scripts are therefore a
   * different operation, not a `query` with more semicolons. Keeping them
   * separate at the port means the distinction is explicit rather than
   * something that works on one profile and fails on the other.
   *
   * Never accepts parameters, so it is never a SQL-injection surface: callers
   * with untrusted input must use `query`.
   */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  readonly profile: StorageProfile;
  /**
   * Run `work` inside a transaction. The callback receives the *same* handle;
   * it must not acquire another.
   */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Capabilities are detected at boot and stored. Never configured, never assumed. */
export interface Capabilities {
  /** pgvector present — HNSW/ivfflat available instead of the float4[] path. */
  readonly vector: boolean;
  /** pg_trgm present — trigram index available for the code lexical arm. */
  readonly trgm: boolean;
  /** pg_search / ParadeDB present — real BM25 instead of ts_rank_cd. */
  readonly bm25: boolean;
  /** SELECT ... FOR UPDATE SKIP LOCKED usable — the job queue depends on it. */
  readonly skipLocked: boolean;
  /** More than one worker process may write concurrently. False under embedded. */
  readonly concurrentWriters: boolean;
}

export class StorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'StorageError';
  }
}
