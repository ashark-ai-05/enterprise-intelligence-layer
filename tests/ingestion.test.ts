import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubConfluenceConnector } from "../src/connectors/stubs.js";
import type { SourceItem } from "../src/connectors/types.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { createScope, listScopes, removeScope } from "../src/scopes/service.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

function page(
  version: string,
  overrides: Partial<SourceItem> = {},
): SourceItem {
  return {
    sourceObjectId: "page-1",
    sourceVersion: version,
    canonicalUri: "https://example.atlassian.net/wiki/pages/1",
    title: "Payments architecture",
    body: "Retry payments with exponential backoff.",
    metadata: { pageId: "1", spaceKey: "ARCH", labels: ["design"] },
    acl: [{ domain: "atlassian", principalId: "engineering", effect: "allow" }],
    sourceUpdatedAt: "2026-08-11T00:00:00Z",
    deleted: false,
    ...overrides,
  };
}

let db: Database | undefined;
let scopeId: string;

beforeEach(async () => {
  db = await testDatabase();
  const scope = await createScope(db, {
    tenantId: "acme",
    source: "confluence",
    selectorKind: "space",
    selector: { keys: ["ARCH"] },
    refreshMode: "manual",
    includeChildren: true,
    addedBy: "user-1",
  });
  scopeId = scope.id;
});

afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("scope ingestion pipeline", () => {
  it("acquires, versions, authorizes, and checkpoints a selected source item", async () => {
    if (!db) throw new Error("test database was not initialized");
    const connector = new StubConfluenceConnector([
      { sequence: 1, item: page("1") },
    ]);
    const counters = await ingestScope(db, "acme", scopeId, connector);
    expect(counters).toEqual({
      discovered: 1,
      created: 1,
      contentUpdated: 1,
      metadataUpdated: 1,
      aclUpdated: 1,
      deleted: 0,
      unchanged: 0,
    });
    const resource = await db.query<{
      body: string;
      source_version: string;
      content_hash: string;
      metadata_hash: string;
      acl_hash: string;
    }>(
      "SELECT body, source_version, content_hash, metadata_hash, acl_hash FROM resources",
    );
    expect(resource.rows[0]).toMatchObject({
      body: "Retry payments with exponential backoff.",
      source_version: "1",
    });
    expect(resource.rows[0]?.content_hash).toHaveLength(64);
    expect(resource.rows[0]?.metadata_hash).toHaveLength(64);
    expect(resource.rows[0]?.acl_hash).toHaveLength(64);
    expect((await db.query("SELECT * FROM raw_source_items")).rowCount).toBe(1);
    expect((await db.query("SELECT * FROM resource_aces")).rowCount).toBe(1);
    expect(
      (await db.query("SELECT * FROM resource_chunks WHERE deleted_at IS NULL"))
        .rowCount,
    ).toBe(1);
    expect((await listScopes(db, "acme"))[0]?.cursor).toEqual({ sequence: 1 });
  });

  it("processes content, metadata, and ACL changes independently", async () => {
    if (!db) throw new Error("test database was not initialized");
    const connector = new StubConfluenceConnector([
      { sequence: 1, item: page("1") },
    ]);
    await ingestScope(db, "acme", scopeId, connector);

    connector.append({
      sequence: 2,
      item: page("2", {
        metadata: { pageId: "1", spaceKey: "ARCH", labels: ["current"] },
      }),
    });
    expect(await ingestScope(db, "acme", scopeId, connector)).toMatchObject({
      discovered: 1,
      contentUpdated: 0,
      metadataUpdated: 1,
      aclUpdated: 0,
    });

    connector.append({
      sequence: 3,
      item: page("3", {
        metadata: { pageId: "1", spaceKey: "ARCH", labels: ["current"] },
        acl: [
          { domain: "atlassian", principalId: "security", effect: "allow" },
        ],
      }),
    });
    expect(await ingestScope(db, "acme", scopeId, connector)).toMatchObject({
      discovered: 1,
      contentUpdated: 0,
      metadataUpdated: 0,
      aclUpdated: 1,
    });
    const aces = await db.query<{ principal_id: string }>(
      "SELECT principal_id FROM resource_aces",
    );
    expect(aces.rows).toEqual([{ principal_id: "security" }]);

    connector.append({
      sequence: 4,
      item: page("4", {
        body: "Use bounded exponential backoff with jitter.",
        metadata: { pageId: "1", spaceKey: "ARCH", labels: ["current"] },
        acl: [
          { domain: "atlassian", principalId: "security", effect: "allow" },
        ],
      }),
    });
    expect(await ingestScope(db, "acme", scopeId, connector)).toMatchObject({
      discovered: 1,
      contentUpdated: 1,
      metadataUpdated: 0,
      aclUpdated: 0,
    });
  });

  it("tombstones deletes immediately and removes searchable ACEs", async () => {
    if (!db) throw new Error("test database was not initialized");
    const connector = new StubConfluenceConnector([
      { sequence: 1, item: page("1") },
    ]);
    await ingestScope(db, "acme", scopeId, connector);
    connector.append({ sequence: 2, item: page("2", { deleted: true }) });

    expect(await ingestScope(db, "acme", scopeId, connector)).toMatchObject({
      deleted: 1,
    });
    const resource = await db.query<{ deleted: boolean }>(
      "SELECT deleted_at IS NOT NULL AS deleted FROM resources",
    );
    expect(resource.rows[0]?.deleted).toBe(true);
    expect((await db.query("SELECT * FROM resource_aces")).rowCount).toBe(0);
    expect(
      (await db.query("SELECT * FROM resource_chunks WHERE deleted_at IS NULL"))
        .rowCount,
    ).toBe(0);
  });

  it("does not advance the scope checkpoint when a connector or item fails", async () => {
    if (!db) throw new Error("test database was not initialized");
    const connector = new StubConfluenceConnector([
      {
        sequence: 1,
        item: page("1", { canonicalUri: "not-a-url" }),
      },
    ]);
    await expect(ingestScope(db, "acme", scopeId, connector)).rejects.toThrow();
    expect((await listScopes(db, "acme"))[0]?.cursor).toBeNull();
    const run = await db.query<{ status: string; error_code: string }>(
      "SELECT status, error_code FROM ingestion_runs",
    );
    expect(run.rows).toEqual([{ status: "failed", error_code: "ZodError" }]);
  });

  it("rejects duplicate structural keys instead of silently dropping a chunk", async () => {
    if (!db) throw new Error("test database was not initialized");
    const connector = new StubConfluenceConnector([
      {
        sequence: 1,
        item: page("1", {
          metadata: {
            pageId: "1",
            spaceKey: "ARCH",
            sections: [
              { anchor: "duplicate", text: "First" },
              { anchor: "duplicate", text: "Second" },
            ],
          },
        }),
      },
    ]);
    await expect(ingestScope(db, "acme", scopeId, connector)).rejects.toThrow(
      "normalizer produced duplicate stable chunk keys",
    );
    expect((await listScopes(db, "acme"))[0]?.cursor).toBeNull();
    expect((await db.query("SELECT * FROM resources")).rowCount).toBe(0);
  });

  it("deduplicates repeated ACL entries before persistence and hashing", async () => {
    if (!db) throw new Error("test database was not initialized");
    const duplicate = {
      domain: "atlassian",
      principalId: "engineering",
      effect: "allow" as const,
    };
    const connector = new StubConfluenceConnector([
      { sequence: 1, item: page("1", { acl: [duplicate, duplicate] }) },
    ]);
    await expect(
      ingestScope(db, "acme", scopeId, connector),
    ).resolves.toMatchObject({ aclUpdated: 1 });
    expect((await db.query("SELECT * FROM resource_aces")).rowCount).toBe(1);
  });

  it("retains immutable acquisition and run audit when a scope is removed", async () => {
    if (!db) throw new Error("test database was not initialized");
    const connector = new StubConfluenceConnector([
      { sequence: 1, item: page("1") },
    ]);
    await ingestScope(db, "acme", scopeId, connector);
    await removeScope(db, "acme", scopeId, "retain");

    const raw = await db.query<{ detached: boolean }>(
      "SELECT scope_id IS NULL AS detached FROM raw_source_items",
    );
    const run = await db.query<{ detached: boolean; status: string }>(
      "SELECT scope_id IS NULL AS detached, status FROM ingestion_runs",
    );
    expect(raw.rows).toEqual([{ detached: true }]);
    expect(run.rows).toEqual([{ detached: true, status: "succeeded" }]);
  });

  it("rejects a connector for a different source without starting a run", async () => {
    if (!db) throw new Error("test database was not initialized");
    const wrong = new StubConfluenceConnector();
    const jiraScope = await createScope(db, {
      tenantId: "acme",
      source: "jira",
      selectorKind: "project",
      selector: { keys: ["PAY"] },
      addedBy: "user-1",
    });
    await expect(ingestScope(db, "acme", jiraScope.id, wrong)).rejects.toThrow(
      "connector stub-confluence cannot ingest jira scope",
    );
    expect((await db.query("SELECT * FROM ingestion_runs")).rowCount).toBe(0);
  });
});
