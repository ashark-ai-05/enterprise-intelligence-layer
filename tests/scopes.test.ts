import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachResourceToScope,
  createScope,
  listScopes,
  removeScope,
  saveScopeCheckpoint,
} from "../src/scopes/service.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

let db: Database | undefined;

beforeEach(async () => {
  db = await testDatabase();
});

afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("scope registry", () => {
  it("creates exact and scheduled collection scopes with narrow defaults", async () => {
    if (!db) throw new Error("test database was not initialized");
    const page = await createScope(db, {
      tenantId: "acme",
      source: "confluence",
      selectorKind: "page",
      selector: { ids: ["12345"] },
      addedBy: "user-1",
    });
    const project = await createScope(db, {
      tenantId: "acme",
      source: "jira",
      selectorKind: "project",
      selector: { keys: ["PAY"] },
      refreshMode: "scheduled",
      schedule: "30 minutes",
      includeChildren: true,
      addedBy: "user-1",
    });

    expect(page).toMatchObject({
      refreshMode: "manual",
      includeChildren: false,
      includeAttachments: true,
      selector: { ids: ["12345"] },
    });
    expect(project.schedule).toBe("30 minutes");
    expect(await listScopes(db, "acme")).toHaveLength(2);
  });

  it("rejects invalid schedule combinations before touching storage", async () => {
    if (!db) throw new Error("test database was not initialized");
    await expect(
      createScope(db, {
        tenantId: "acme",
        source: "jira",
        selectorKind: "project",
        selector: { keys: ["PAY"] },
        refreshMode: "scheduled",
        addedBy: "user-1",
      }),
    ).rejects.toThrow("scheduled scopes require a schedule");
  });

  it("stores an independent checkpoint per scope", async () => {
    if (!db) throw new Error("test database was not initialized");
    const scope = await createScope(db, {
      tenantId: "acme",
      source: "jira",
      selectorKind: "issue",
      selector: { keys: ["PAY-142"] },
      refreshMode: "snapshot",
      addedBy: "user-1",
    });
    await saveScopeCheckpoint(db, "acme", scope.id, {
      updated: "2026-08-11T00:00:00Z",
      page: 4,
    });
    expect((await listScopes(db, "acme"))[0]).toMatchObject({
      cursor: { updated: "2026-08-11T00:00:00Z", page: 4 },
      lastStatus: "ok",
    });
  });

  it("deduplicates one resource discovered through overlapping scopes", async () => {
    if (!db) throw new Error("test database was not initialized");
    const space = await createScope(db, {
      tenantId: "acme",
      source: "confluence",
      selectorKind: "space",
      selector: { keys: ["ARCH"] },
      includeChildren: true,
      addedBy: "user-1",
    });
    const page = await createScope(db, {
      tenantId: "acme",
      source: "confluence",
      selectorKind: "page",
      selector: { ids: ["12345"] },
      addedBy: "user-1",
    });
    const resource = {
      tenantId: "acme",
      source: "confluence",
      sourceObjectId: "12345",
      canonicalUri: "https://example.atlassian.net/wiki/pages/12345",
      title: "Payments architecture",
    };
    const fromSpace = await attachResourceToScope(db, space.id, resource);
    const fromPage = await attachResourceToScope(db, page.id, resource);

    expect(fromPage).toBe(fromSpace);
    const counts = await db.query<{ resources: number; memberships: number }>(`
      SELECT
        (SELECT count(*)::int FROM resources) AS resources,
        (SELECT count(*)::int FROM resource_scopes) AS memberships
    `);
    expect(counts.rows[0]).toEqual({ resources: 1, memberships: 2 });
  });

  it("purges only resources no longer referenced by another scope", async () => {
    if (!db) throw new Error("test database was not initialized");
    const first = await createScope(db, {
      tenantId: "acme",
      source: "confluence",
      selectorKind: "space",
      selector: { keys: ["ARCH"] },
      addedBy: "user-1",
    });
    const second = await createScope(db, {
      tenantId: "acme",
      source: "confluence",
      selectorKind: "page",
      selector: { ids: ["12345"] },
      addedBy: "user-1",
    });
    const resource = {
      tenantId: "acme",
      source: "confluence",
      sourceObjectId: "12345",
      canonicalUri: "https://example.atlassian.net/wiki/pages/12345",
      title: "Payments architecture",
    };
    await attachResourceToScope(db, first.id, resource);
    await attachResourceToScope(db, second.id, resource);

    await removeScope(db, "acme", first.id, "purge");
    expect((await db.query("SELECT id FROM resources")).rowCount).toBe(1);
    await removeScope(db, "acme", second.id, "purge");
    expect((await db.query("SELECT id FROM resources")).rowCount).toBe(0);
  });

  it("retains orphaned resources when a scope is removed without purge", async () => {
    if (!db) throw new Error("test database was not initialized");
    const scope = await createScope(db, {
      tenantId: "acme",
      source: "jira",
      selectorKind: "issue",
      selector: { keys: ["PAY-142"] },
      addedBy: "user-1",
    });
    await attachResourceToScope(db, scope.id, {
      tenantId: "acme",
      source: "jira",
      sourceObjectId: "PAY-142",
      canonicalUri: "https://example.atlassian.net/browse/PAY-142",
      title: "Retry payments safely",
    });

    await removeScope(db, "acme", scope.id, "retain");
    const retained = await db.query<{ orphaned: boolean }>(
      "SELECT orphaned_at IS NOT NULL AS orphaned FROM resources",
    );
    expect(retained.rows[0]?.orphaned).toBe(true);
  });

  it("rejects cross-tenant or cross-source resource attachment", async () => {
    if (!db) throw new Error("test database was not initialized");
    const scope = await createScope(db, {
      tenantId: "acme",
      source: "jira",
      selectorKind: "project",
      selector: { keys: ["PAY"] },
      addedBy: "user-1",
    });
    await expect(
      attachResourceToScope(db, scope.id, {
        tenantId: "other",
        source: "jira",
        sourceObjectId: "PAY-142",
        canonicalUri: "https://example.atlassian.net/browse/PAY-142",
        title: "Retry payments safely",
      }),
    ).rejects.toThrow("resource tenant/source must match its ingestion scope");
  });

  it("does not mutate a scope through the wrong tenant boundary", async () => {
    if (!db) throw new Error("test database was not initialized");
    const scope = await createScope(db, {
      tenantId: "acme",
      source: "jira",
      selectorKind: "project",
      selector: { keys: ["PAY"] },
      addedBy: "user-1",
    });

    await expect(
      saveScopeCheckpoint(db, "other", scope.id, {
        updated: "2026-08-11T00:00:00Z",
      }),
    ).rejects.toThrow(`unknown scope: ${scope.id}`);
    await expect(removeScope(db, "other", scope.id, "purge")).rejects.toThrow(
      `unknown scope: ${scope.id}`,
    );
    expect(await listScopes(db, "acme")).toHaveLength(1);
  });
});
