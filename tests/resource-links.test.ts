import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubConfluenceConnector } from "../src/connectors/stubs.js";
import type { SourceItem } from "../src/connectors/types.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { extractResourceLinks } from "../src/links/extract.js";
import {
  DatabaseLinkSource,
  replaceResourceLinks,
} from "../src/links/store.js";
import { createScope } from "../src/scopes/service.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

function page(overrides: Partial<SourceItem> = {}): SourceItem {
  return {
    sourceObjectId: "CONF-1",
    sourceVersion: "1",
    canonicalUri: "https://example.test/wiki/CONF-1",
    title: "Retry runbook",
    body: "Follow PAY-1 and service-0/src/module-0.ts during recovery.",
    metadata: { pageId: "CONF-1", spaceKey: "ENG" },
    links: [
      {
        source: "jira",
        sourceObjectId: "PAY-2",
        type: "tested-by",
      },
    ],
    acl: [],
    sourceUpdatedAt: "2026-08-11T00:00:00Z",
    deleted: false,
    ...overrides,
  };
}

let db: Database;
let scopeId: string;

beforeEach(async () => {
  db = await testDatabase();
  const scope = await createScope(db, {
    tenantId: "acme",
    source: "confluence",
    selectorKind: "space",
    selector: { keys: ["ENG"] },
    refreshMode: "manual",
    addedBy: "operator",
  });
  scopeId = scope.id;
});

afterEach(async () => {
  await db.close();
});

describe("resource links", () => {
  it("persists explicit and deterministic links with provenance", async () => {
    await ingestScope(
      db,
      "acme",
      scopeId,
      new StubConfluenceConnector([{ sequence: 1, item: page() }]),
    );
    const rows = await db.query<{
      to_source_object_id: string;
      origin: string;
      confidence: number;
    }>(
      `SELECT to_source_object_id, origin, confidence
       FROM resource_links ORDER BY to_source_object_id`,
    );
    expect(rows.rows).toEqual([
      {
        to_source_object_id: "PAY-1",
        origin: "deterministic-extracted",
        confidence: 0.95,
      },
      {
        to_source_object_id: "PAY-2",
        origin: "source-explicit",
        confidence: 1,
      },
      {
        to_source_object_id: "service-0:src/module-0.ts",
        origin: "deterministic-extracted",
        confidence: 0.95,
      },
    ]);
  });

  it("walks persisted links in both directions without granting access", async () => {
    await ingestScope(
      db,
      "acme",
      scopeId,
      new StubConfluenceConnector([{ sequence: 1, item: page() }]),
    );
    const source = new DatabaseLinkSource(db, "acme");
    expect(await source.neighbours(["CONF-1"])).toContainEqual({
      from: "CONF-1",
      to: "PAY-1",
      type: "documents",
    });
    expect(await source.neighbours(["PAY-1"])).toEqual([
      { from: "PAY-1", to: "CONF-1", type: "documents" },
    ]);
    expect(
      await new DatabaseLinkSource(db, "other").neighbours(["CONF-1"]),
    ).toEqual([]);
  });

  it("replaces stale links on update and removes outbound links on delete", async () => {
    await ingestScope(
      db,
      "acme",
      scopeId,
      new StubConfluenceConnector([
        { sequence: 1, item: page() },
        {
          sequence: 2,
          item: page({
            sourceVersion: "2",
            body: "No remaining references.",
            links: [],
            sourceUpdatedAt: "2026-08-11T01:00:00Z",
          }),
        },
      ]),
    );
    expect((await db.query("SELECT 1 FROM resource_links")).rowCount).toBe(0);

    await ingestScope(
      db,
      "acme",
      scopeId,
      new StubConfluenceConnector([
        {
          sequence: 3,
          item: page({
            sourceVersion: "3",
            sourceUpdatedAt: "2026-08-11T02:00:00Z",
          }),
        },
        {
          sequence: 4,
          item: page({
            sourceVersion: "4",
            deleted: true,
            sourceUpdatedAt: "2026-08-11T03:00:00Z",
          }),
        },
      ]),
    );
    expect((await db.query("SELECT 1 FROM resource_links")).rowCount).toBe(0);
  });

  it("rejects a cross-tenant link mutation", async () => {
    const item = page();
    await ingestScope(
      db,
      "acme",
      scopeId,
      new StubConfluenceConnector([{ sequence: 1, item }]),
    );
    const resource = await db.query<{ id: string }>("SELECT id FROM resources");
    const validated = {
      ...item,
      links: item.links ?? [],
      deleted: false,
    };
    await expect(
      replaceResourceLinks(
        db,
        "other",
        resource.rows[0]?.id ?? "",
        "confluence",
        "CONF-1",
        "1",
        extractResourceLinks("confluence", validated),
      ),
    ).rejects.toThrow("resource link origin must match the tenant and source");
  });
});
