import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubConfluenceConnector } from "../src/connectors/stubs.js";
import type { SourceItem } from "../src/connectors/types.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { reconcileScope } from "../src/ingestion/reconcile.js";
import { createScope } from "../src/scopes/service.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

function page(id: string, deleted = false): SourceItem {
  return {
    sourceObjectId: id,
    sourceVersion: deleted ? "2" : "1",
    canonicalUri: `https://example.atlassian.net/wiki/pages/${id}`,
    title: `Page ${id}`,
    body: `Body ${id}; follow PAY-1.`,
    metadata: { pageId: id, spaceKey: "ARCH" },
    acl: [{ domain: "atlassian", principalId: "engineering", effect: "allow" }],
    sourceUpdatedAt: "2026-08-11T00:00:00Z",
    deleted,
  };
}

let db: Database | undefined;

beforeEach(async () => {
  db = await testDatabase();
});

afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("ID-only bounded reconciliation", () => {
  it("tombstones a resource missing from its only scope", async () => {
    if (!db) throw new Error("test database was not initialized");
    const scope = await createScope(db, {
      tenantId: "acme",
      source: "confluence",
      selectorKind: "space",
      selector: { keys: ["ARCH"] },
      addedBy: "user-1",
    });
    const connector = new StubConfluenceConnector([
      { sequence: 1, item: page("1") },
      { sequence: 2, item: page("2") },
    ]);
    await ingestScope(db, "acme", scope.id, connector);
    connector.append({ sequence: 3, item: page("2", true) });

    expect(await reconcileScope(db, "acme", scope.id, connector)).toEqual({
      indexed: 2,
      present: 1,
      detached: 1,
      tombstoned: 1,
    });
    const resources = await db.query<{
      source_object_id: string;
      deleted: boolean;
    }>(
      `SELECT source_object_id, deleted_at IS NOT NULL AS deleted
       FROM resources ORDER BY source_object_id`,
    );
    expect(resources.rows).toEqual([
      { source_object_id: "1", deleted: false },
      { source_object_id: "2", deleted: true },
    ]);
    const deletedLinks = await db.query(
      "SELECT 1 FROM resource_links WHERE from_source_object_id = '2'",
    );
    expect(deletedLinks.rowCount).toBe(0);
  });

  it("detaches but preserves a resource still covered by another scope", async () => {
    if (!db) throw new Error("test database was not initialized");
    const space = await createScope(db, {
      tenantId: "acme",
      source: "confluence",
      selectorKind: "space",
      selector: { keys: ["ARCH"] },
      addedBy: "user-1",
    });
    const exact = await createScope(db, {
      tenantId: "acme",
      source: "confluence",
      selectorKind: "page",
      selector: { ids: ["2"] },
      addedBy: "user-1",
    });
    const connector = new StubConfluenceConnector([
      { sequence: 1, item: page("1") },
      { sequence: 2, item: page("2") },
    ]);
    await ingestScope(db, "acme", space.id, connector);
    await ingestScope(db, "acme", exact.id, connector);
    connector.append({ sequence: 3, item: page("2", true) });

    expect(await reconcileScope(db, "acme", space.id, connector)).toMatchObject(
      {
        detached: 1,
        tombstoned: 0,
      },
    );
    const resource = await db.query<{ deleted: boolean; memberships: number }>(
      `SELECT r.deleted_at IS NOT NULL AS deleted,
        (SELECT count(*)::int FROM resource_scopes rs WHERE rs.resource_id = r.id) AS memberships
       FROM resources r WHERE source_object_id = '2'`,
    );
    expect(resource.rows[0]).toEqual({ deleted: false, memberships: 1 });
  });
});
