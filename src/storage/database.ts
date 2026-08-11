import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export interface QueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  rows: Row[];
  rowCount: number;
}

export interface Database {
  readonly profile: "embedded" | "server";
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  executeScript(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseCapabilities {
  profile: "embedded" | "server";
  concurrentWorkers: boolean;
  skipLocked: boolean;
  pgTrgm: boolean;
  pgVector: boolean;
}

export interface OpenDatabaseOptions {
  url?: string;
  dataDirectory?: string;
}

class EmbeddedDatabase implements Database {
  readonly profile = "embedded" as const;

  constructor(private readonly client: PGlite) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await this.client.query<Row>(text, [...params]);
    return {
      rows: result.rows,
      rowCount:
        result.rows.length > 0
          ? result.rows.length
          : (result.affectedRows ?? 0),
    };
  }

  async executeScript(sql: string): Promise<void> {
    await this.client.exec(sql);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class ServerDatabase implements Database {
  readonly profile = "server" as const;

  constructor(private readonly client: pg.Client) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await this.client.query<Row>(text, [...params]);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  async executeScript(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

function embeddedPath(
  url: string | undefined,
  dataDirectory: string | undefined,
): string {
  if (url?.startsWith("pglite://")) {
    const path = url.slice("pglite://".length);
    if (!path) throw new Error("pglite URL must include a data directory");
    return resolve(path);
  }
  return resolve(dataDirectory ?? process.env.EIL_DATA_DIR ?? ".eil/data");
}

export async function openDatabase(
  options: OpenDatabaseOptions = {},
): Promise<Database> {
  const url = options.url ?? process.env.DATABASE_URL;
  if (!url || url.startsWith("pglite://")) {
    const path = embeddedPath(url, options.dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    return new EmbeddedDatabase(await PGlite.create(path));
  }

  if (!url.startsWith("postgres://") && !url.startsWith("postgresql://")) {
    throw new Error(
      "DATABASE_URL must use pglite://, postgres://, or postgresql://",
    );
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return new ServerDatabase(client);
}

export async function detectCapabilities(
  db: Database,
): Promise<DatabaseCapabilities> {
  if (db.profile === "embedded") {
    return {
      profile: "embedded",
      concurrentWorkers: false,
      skipLocked: false,
      pgTrgm: false,
      pgVector: false,
    };
  }

  const installed = await db.query<{ extname: string }>(
    "SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])",
    [["pg_trgm", "vector"]],
  );
  const names = new Set(installed.rows.map(({ extname }) => extname));
  return {
    profile: "server",
    concurrentWorkers: true,
    skipLocked: true,
    pgTrgm: names.has("pg_trgm"),
    pgVector: names.has("vector"),
  };
}

export async function withTransaction<T>(
  db: Database,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  await db.query("BEGIN");
  try {
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch {
      // Preserve the original error if cleanup also fails.
    }
    throw error;
  }
}
