import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/storage/database.js";
import { migrate } from "../../src/storage/migrations.js";

export async function testDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "eil-test-"));
  const db = await openDatabase({ url: `pglite://${directory}/catalog` });
  await migrate(db);
  return db;
}
