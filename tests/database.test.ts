import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../src/storage/database.js";
import { detectCapabilities, openDatabase } from "../src/storage/database.js";
import { migrate } from "../src/storage/migrations.js";

let db: Database | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("database profiles", () => {
  it("defaults to an embedded PGlite database and reports conservative capabilities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eil-profile-"));
    db = await openDatabase({ dataDirectory: `${directory}/catalog` });
    expect(db.profile).toBe("embedded");
    expect(await detectCapabilities(db)).toEqual({
      profile: "embedded",
      concurrentWorkers: false,
      skipLocked: false,
      pgTrgm: false,
      pgVector: false,
    });
  });

  it("applies each migration once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eil-migrate-"));
    db = await openDatabase({ url: `pglite://${directory}/catalog` });
    expect(await migrate(db)).toEqual([
      "0001_foundation.sql",
      "0002_ingestion_pipeline.sql",
      "0003_structural_chunks.sql",
      "0004_acl_identity_plane.sql",
      "0005_many_to_many_principal_mappings.sql",
    ]);
    expect(await migrate(db)).toEqual([]);
    const count = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM schema_migrations",
    );
    expect(count.rows[0]?.count).toBe(5);
  });

  it("rejects unsupported database URL schemes", async () => {
    await expect(openDatabase({ url: "sqlite://catalog.db" })).rejects.toThrow(
      "DATABASE_URL must use pglite://, postgres://, or postgresql://",
    );
  });
});
