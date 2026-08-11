import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubConfluenceConnector } from "../src/connectors/stubs.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { createScope } from "../src/scopes/service.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

let db: Database;

beforeEach(async () => {
  db = await testDatabase();
});

afterEach(async () => {
  await db.close();
});

describe("lexical projection", () => {
  it("maintains a generated tsvector and uses its partial GIN index", async () => {
    const scope = await createScope(db, {
      tenantId: "acme",
      source: "confluence",
      selectorKind: "page",
      selector: { ids: ["page-1"] },
      refreshMode: "manual",
      addedBy: "operator",
    });
    await ingestScope(
      db,
      "acme",
      scope.id,
      new StubConfluenceConnector([
        {
          sequence: 1,
          item: {
            sourceObjectId: "page-1",
            sourceVersion: "1",
            canonicalUri: "https://example/wiki/page-1",
            title: "Retry policy",
            body: "Payment retries use exponential backoff.",
            metadata: { pageId: "page-1" },
            acl: [],
            sourceUpdatedAt: "2026-08-11T00:00:00Z",
            deleted: false,
          },
        },
      ]),
    );

    const match = await db.query<{ text: string }>(
      `SELECT text FROM resource_chunks
       WHERE deleted_at IS NULL
         AND search_vector @@ websearch_to_tsquery('simple', $1)`,
      ["payment retries"],
    );
    expect(match.rows.map(({ text }) => text)).toContain(
      "Payment retries use exponential backoff.",
    );

    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'resource_chunks' AND indexname = 'resource_chunks_search_vector_idx'`,
    );
    expect(indexes.rows).toHaveLength(1);
  });
});
