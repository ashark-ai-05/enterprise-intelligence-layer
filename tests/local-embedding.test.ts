import { afterAll, describe, expect, it } from "vitest";
import { StubConfluenceConnector } from "../src/connectors/stubs.js";
import type { SourceItem } from "../src/connectors/types.js";
import { embedPendingChunks } from "../src/embeddings/backfill.js";
import { LocalWasmEmbedder } from "../src/embeddings/local-wasm.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { createScope } from "../src/scopes/service.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

const embedder = new LocalWasmEmbedder();

function cosine(left: Float32Array, right: Float32Array): number {
  return left.reduce(
    (sum, value, index) => sum + value * (right[index] ?? 0),
    0,
  );
}

describe("offline MiniLM WASM embeddings", () => {
  let db: Database | undefined;

  afterAll(async () => {
    await db?.close();
  });

  it("runs the vendored model without a remote model service", async () => {
    const [query, related, unrelated] = await embedder.embed([
      "payment retry policy",
      "retry failed payments with exponential backoff",
      "annual employee holiday calendar",
    ]);
    expect(query).toHaveLength(384);
    expect(related).toHaveLength(384);
    expect(unrelated).toHaveLength(384);
    expect(Math.hypot(...(query ?? []))).toBeCloseTo(1, 4);
    expect(
      cosine(query ?? new Float32Array(), related ?? new Float32Array()),
    ).toBeGreaterThan(
      cosine(query ?? new Float32Array(), unrelated ?? new Float32Array()),
    );
    expect(embedder.id).toContain(":wasm:");
  });

  it("persists only changed chunks under the exact model version", async () => {
    db = await testDatabase();
    const scope = await createScope(db, {
      tenantId: "acme",
      source: "confluence",
      selectorKind: "space",
      selector: { keys: ["ENG"] },
      refreshMode: "manual",
      addedBy: "test",
    });
    const item: SourceItem = {
      sourceObjectId: "page-1",
      sourceVersion: "1",
      canonicalUri: "https://mock.atlassian.test/wiki/pages/1",
      title: "Retry policy",
      body: "Retry failed payments with exponential backoff.",
      metadata: { pageId: "1", spaceKey: "ENG" },
      acl: [],
      sourceUpdatedAt: "2026-08-11T00:00:00Z",
      deleted: false,
    };
    const connector = new StubConfluenceConnector([{ sequence: 1, item }]);
    await ingestScope(db, "acme", scope.id, connector);
    expect(await embedPendingChunks(db, embedder, 4)).toEqual({
      embedded: 1,
      modelId: embedder.id,
    });
    expect(await embedPendingChunks(db, embedder, 4)).toEqual({
      embedded: 0,
      modelId: embedder.id,
    });

    connector.append({
      sequence: 2,
      item: {
        ...item,
        sourceVersion: "2",
        body: "Retry failed payments with bounded exponential backoff and jitter.",
      },
    });
    await ingestScope(db, "acme", scope.id, connector);
    expect((await embedPendingChunks(db, embedder, 4)).embedded).toBe(1);
    const stored = await db.query<{
      model_id: string;
      dimension: number;
      vector_dimension: number;
    }>(
      `SELECT model_id, dimension, array_length(embedding, 1)::int AS vector_dimension
       FROM chunk_vectors`,
    );
    expect(stored.rows).toEqual([
      {
        model_id: embedder.id,
        dimension: 384,
        vector_dimension: 384,
      },
    ]);
  });
});
