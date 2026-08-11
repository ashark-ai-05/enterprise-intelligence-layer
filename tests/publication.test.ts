import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubConfluenceConnector } from "../src/connectors/stubs.js";
import type { SourceItem } from "../src/connectors/types.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { applyDeletion, requestDeletion } from "../src/publication/deletion.js";
import {
  markProjectionReady,
  publishCoreGeneration,
  publishGeneration,
  stageGeneration,
} from "../src/publication/generations.js";
import { createScope } from "../src/scopes/service.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

function page(
  version = "1",
  body = "Retry failed payments safely.",
): SourceItem {
  return {
    sourceObjectId: "page-1",
    sourceVersion: version,
    canonicalUri: "https://mock.atlassian.test/wiki/pages/1",
    title: "Retry policy",
    body,
    metadata: { pageId: "1", spaceKey: "ENG" },
    acl: [],
    sourceUpdatedAt: "2026-08-11T00:00:00Z",
    deleted: false,
  };
}

let db: Database;
let resourceId: string;
let connector: StubConfluenceConnector;
let scopeId: string;

beforeEach(async () => {
  db = await testDatabase();
  const scope = await createScope(db, {
    tenantId: "acme",
    source: "confluence",
    selectorKind: "space",
    selector: { keys: ["ENG"] },
    refreshMode: "manual",
    addedBy: "test",
  });
  scopeId = scope.id;
  connector = new StubConfluenceConnector([{ sequence: 1, item: page() }]);
  await ingestScope(db, "acme", scopeId, connector);
  const resource = await db.query<{ id: string }>("SELECT id FROM resources");
  resourceId = resource.rows[0]?.id ?? "";
});

afterEach(async () => {
  await db.close();
});

describe("atomic index publication", () => {
  it("keeps an incomplete generation invisible", async () => {
    const before = await db.query<{ published_generation_id: string }>(
      "SELECT published_generation_id FROM resources WHERE id = $1",
      [resourceId],
    );
    const generationId = await stageGeneration(db, {
      tenantId: "acme",
      resourceId,
      parserVersion: "parser:v1",
      chunkerVersion: "chunker:v1",
      requiredProjections: ["catalog", "acl", "lexical", "vector"],
    });
    await markProjectionReady(db, generationId, "catalog", "catalog-1", "a");
    await markProjectionReady(db, generationId, "acl", "acl-1", "b");
    await markProjectionReady(db, generationId, "lexical", "lexical-1", "c");
    await expect(publishGeneration(db, "acme", generationId)).rejects.toThrow(
      "missing projections: vector",
    );
    const resource = await db.query<{ published_generation_id: string | null }>(
      "SELECT published_generation_id FROM resources WHERE id = $1",
      [resourceId],
    );
    expect(resource.rows[0]?.published_generation_id).toBe(
      before.rows[0]?.published_generation_id,
    );
  });

  it("publishes complete core projections and supersedes the previous version", async () => {
    const first = await publishCoreGeneration(db, "acme", resourceId);
    expect(await publishCoreGeneration(db, "acme", resourceId)).toBe(first);
    connector.append({
      sequence: 2,
      item: page("2", "Retry failed payments with bounded backoff and jitter."),
    });
    await ingestScope(db, "acme", scopeId, connector);
    const second = await publishCoreGeneration(db, "acme", resourceId);
    expect(second).not.toBe(first);
    const generations = await db.query<{ id: string; state: string }>(
      "SELECT id, state FROM index_generations ORDER BY created_at, id",
    );
    expect(generations.rows).toEqual(
      expect.arrayContaining([
        { id: first, state: "superseded" },
        { id: second, state: "published" },
      ]),
    );
    const resource = await db.query<{ published_generation_id: string }>(
      "SELECT published_generation_id FROM resources WHERE id = $1",
      [resourceId],
    );
    expect(resource.rows[0]?.published_generation_id).toBe(second);
  });

  it("rejects a staged generation after the authoritative resource changes", async () => {
    const generationId = await stageGeneration(db, {
      tenantId: "acme",
      resourceId,
      parserVersion: "parser:v1",
      chunkerVersion: "chunker:v1",
      requiredProjections: ["catalog"],
    });
    await markProjectionReady(db, generationId, "catalog", "catalog-1", "a");
    connector.append({
      sequence: 2,
      item: page("2", "Changed after staging."),
    });
    await ingestScope(db, "acme", scopeId, connector);
    await expect(publishGeneration(db, "acme", generationId)).rejects.toThrow(
      "no longer matches",
    );
  });
});

describe("deletion and retention lifecycle", () => {
  it("tombstones search projections but retains recoverable source state", async () => {
    await publishCoreGeneration(db, "acme", resourceId);
    const requestId = await requestDeletion(
      db,
      "acme",
      resourceId,
      "tombstone",
      "records-admin",
    );
    await applyDeletion(db, "acme", requestId);
    const resource = await db.query<{
      deleted: boolean;
      published_generation_id: string | null;
    }>(
      `SELECT deleted_at IS NOT NULL AS deleted, published_generation_id
       FROM resources WHERE id = $1`,
      [resourceId],
    );
    expect(resource.rows[0]).toEqual({
      deleted: true,
      published_generation_id: null,
    });
    expect((await db.query("SELECT * FROM raw_source_items")).rowCount).toBe(1);
    expect(
      (
        await db.query(
          "SELECT * FROM resource_chunks WHERE resource_id = $1 AND deleted_at IS NULL",
          [resourceId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it("preserves auditable proof after a purge cascades derived state", async () => {
    await publishCoreGeneration(db, "acme", resourceId);
    const requestId = await requestDeletion(
      db,
      "acme",
      resourceId,
      "purge",
      "privacy-admin",
    );
    await applyDeletion(db, "acme", requestId);
    expect((await db.query("SELECT * FROM resources")).rowCount).toBe(0);
    expect((await db.query("SELECT * FROM resource_chunks")).rowCount).toBe(0);
    expect((await db.query("SELECT * FROM index_generations")).rowCount).toBe(
      0,
    );
    expect((await db.query("SELECT * FROM raw_source_items")).rowCount).toBe(0);
    const request = await db.query<{
      resource_id: string | null;
      state: string;
      evidence: Record<string, unknown> | string;
    }>(
      "SELECT resource_id, state, evidence FROM deletion_requests WHERE id = $1",
      [requestId],
    );
    expect(request.rows[0]?.resource_id).toBeNull();
    expect(request.rows[0]?.state).toBe("applied");
    expect(request.rows[0]?.evidence).toBeTruthy();
  });

  it("blocks deletion under legal hold", async () => {
    const requestId = await requestDeletion(
      db,
      "acme",
      resourceId,
      "purge",
      "privacy-admin",
      true,
    );
    await expect(applyDeletion(db, "acme", requestId)).rejects.toThrow(
      "blocked by legal hold",
    );
    expect((await db.query("SELECT * FROM resources")).rowCount).toBe(1);
  });
});
