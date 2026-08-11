import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Database } from "./database.js";
import { withTransaction } from "./database.js";

export const migrationsDirectory = fileURLToPath(
  new URL("../../migrations", import.meta.url),
);

export async function migrate(
  db: Database,
  directory = migrationsDirectory,
): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const applied = await db.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  const complete = new Set(applied.rows.map(({ name }) => name));
  const executed: string[] = [];

  for (const file of files) {
    if (complete.has(file)) continue;
    const sql = await readFile(new URL(`file://${directory}/${file}`), "utf8");
    await withTransaction(db, async (tx) => {
      await tx.executeScript(sql);
      await tx.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
        file,
      ]);
    });
    executed.push(file);
  }
  return executed;
}
