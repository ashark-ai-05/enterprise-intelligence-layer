import { describe, expect, it } from "vitest";
import {
  attachResourceToScope,
  createScope,
  removeScope,
} from "../src/scopes/service.js";
import { testDatabase } from "./helpers/database.js";

describe("scope removal blast radius", () => {
  it("bounds a purge to the resources that removal orphaned, not every orphan", async () => {
    const db = await testDatabase();

    const a = await createScope(db, {
      tenantId: "t1",
      source: "confluence",
      selectorKind: "space",
      selector: { key: "A" },
      refreshMode: "manual",
      addedBy: "me",
    });
    const b = await createScope(db, {
      tenantId: "t1",
      source: "confluence",
      selectorKind: "space",
      selector: { key: "B" },
      refreshMode: "manual",
      addedBy: "me",
    });

    await attachResourceToScope(db, a.id, {
      tenantId: "t1",
      source: "confluence",
      sourceObjectId: "page-a",
      canonicalUri: "https://x/a",
      title: "A page",
    });
    await attachResourceToScope(db, b.id, {
      tenantId: "t1",
      source: "confluence",
      sourceObjectId: "page-b",
      canonicalUri: "https://x/b",
      title: "B page",
    });

    // Deliberately retain A's resource.
    await removeScope(db, "t1", a.id, "retain");
    let { rows } = await db.query(
      "SELECT source_object_id FROM resources ORDER BY source_object_id",
    );
    expect(rows.map((r: any) => r.source_object_id)).toEqual([
      "page-a",
      "page-b",
    ]);

    // Now purge an unrelated scope.
    await removeScope(db, "t1", b.id, "purge");
    ({ rows } = await db.query(
      "SELECT source_object_id FROM resources ORDER BY source_object_id",
    ));
    await db.close();

    // page-a was explicitly retained and belongs to a different scope.
    expect(rows.map((r: any) => r.source_object_id)).toEqual(["page-a"]);
  });
});
