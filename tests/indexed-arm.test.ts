import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubConfluenceConnector } from "../src/connectors/stubs.js";
import type { SourceItem } from "../src/connectors/types.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { publishCoreGeneration } from "../src/publication/generations.js";
import { IndexedLexicalArm } from "../src/retrieval/indexed-arm.js";
import { retrieve } from "../src/retrieval/pipeline.js";
import type { Viewer } from "../src/retrieval/types.js";
import { createScope } from "../src/scopes/service.js";
import {
  assignResourceContainer,
  ensureContainer,
  mapPrincipal,
  replaceContainerAces,
} from "../src/security/acl.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

const engineering = { domain: "confluence", principalId: "group:engineering" };
const security = { domain: "confluence", principalId: "group:security" };

const page = (id: string, title: string, body: string): SourceItem => ({
  sourceObjectId: id,
  sourceVersion: "1",
  canonicalUri: `https://mock.atlassian.test/wiki/pages/${id}`,
  title,
  body,
  metadata: { pageId: id, spaceKey: "ARCH" },
  acl: [],
  sourceUpdatedAt: "2026-08-11T00:00:00Z",
  deleted: false,
});

let db: Database;
let archContainer: string;
let secContainer: string;

/** Viewer whose principals resolve to the engineering group. */
const viewer: Viewer = {
  principal: "oidc:alice",
  principals: ["confluence:group:engineering"],
  containers: [],
};

async function resourceIdFor(sourceObjectId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    "SELECT id FROM resources WHERE source_object_id = $1",
    [sourceObjectId],
  );
  return result.rows[0]?.id ?? "";
}

beforeEach(async () => {
  db = await testDatabase();

  const scope = await createScope(db, {
    tenantId: "acme",
    source: "confluence",
    selectorKind: "space",
    selector: { keys: ["ARCH"] },
    refreshMode: "manual",
    addedBy: "test",
  });

  await ingestScope(
    db,
    "acme",
    scope.id,
    new StubConfluenceConnector([
      {
        sequence: 1,
        item: page(
          "page-1",
          "Payment retry policy",
          "Payments retry three times with backoff.",
        ),
      },
      {
        sequence: 2,
        item: page(
          "page-2",
          "Onboarding guide",
          "How to get started on the platform team.",
        ),
      },
      {
        sequence: 3,
        item: page(
          "page-3",
          "Incident response",
          "Restricted runbook for the security team.",
        ),
      },
    ]),
  );

  archContainer = await ensureContainer(
    db,
    "acme",
    "confluence",
    "ARCH",
    "Architecture",
  );
  secContainer = await ensureContainer(
    db,
    "acme",
    "confluence",
    "SEC",
    "Security",
  );

  await assignResourceContainer(
    db,
    "acme",
    await resourceIdFor("page-1"),
    archContainer,
  );
  await assignResourceContainer(
    db,
    "acme",
    await resourceIdFor("page-2"),
    archContainer,
  );
  await assignResourceContainer(
    db,
    "acme",
    await resourceIdFor("page-3"),
    secContainer,
  );

  await replaceContainerAces(db, "acme", archContainer, [
    { ...engineering, effect: "allow" },
  ]);
  await replaceContainerAces(db, "acme", secContainer, [
    { ...security, effect: "allow" },
  ]);

  for (const id of ["page-1", "page-2", "page-3"]) {
    await publishCoreGeneration(db, "acme", await resourceIdFor(id));
  }

  await mapPrincipal(db, "acme", "oidc:alice", engineering);
});

afterEach(async () => {
  await db.close();
});

const arm = () => new IndexedLexicalArm(db, { tenantId: "acme" });

describe("IndexedLexicalArm", () => {
  it("finds an indexed document by its text", async () => {
    const hits = await arm().search({ text: "payment retry" }, viewer);
    expect(hits.map((hit) => hit.id)).toContain("page-1");
  });

  it("never returns a container the viewer has no allow for", async () => {
    // page-3 lives in SEC; the viewer is only in engineering.
    const hits = await arm().search(
      { text: "restricted runbook security" },
      viewer,
    );
    expect(hits.map((hit) => hit.id)).not.toContain("page-3");
  });

  it("returns nothing for a viewer with no principals — fail closed", async () => {
    const stranger: Viewer = {
      principal: "oidc:dave",
      principals: [],
      containers: [],
    };
    expect(await arm().search({ text: "payment retry" }, stranger)).toEqual([]);
  });

  it("returns one hit per resource, not one per matching chunk", async () => {
    // A page with several matching sections must not bury every other document.
    const hits = await arm().search({ text: "payments retry backoff" }, viewer);
    const ids = hits.map((hit) => hit.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries a snippet from the chunk that actually matched", async () => {
    const [hit] = await arm().search({ text: "payment retry" }, viewer);
    expect(hit?.snippet).toMatch(/retry/i);
  });

  it("honours a source filter", async () => {
    expect(
      await arm().search({ text: "payment retry", sources: ["jira"] }, viewer),
    ).toEqual([]);
    expect(
      (
        await arm().search(
          { text: "payment retry", sources: ["confluence"] },
          viewer,
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it("returns nothing for an empty query rather than everything", async () => {
    expect(await arm().search({ text: "   " }, viewer)).toEqual([]);
  });

  it("is deterministic across repeated identical queries", async () => {
    const first = await arm().search({ text: "payment retry policy" }, viewer);
    const second = await arm().search({ text: "payment retry policy" }, viewer);
    expect(first.map((hit) => hit.id)).toEqual(second.map((hit) => hit.id));
  });
});

describe("publication gating", () => {
  it("hides a resource whose publication has been revoked", async () => {
    // Publication is what makes a version searchable. A revoked generation means
    // the projections no longer agree, and serving it would serve a half-written
    // or de-authorised version.
    const before = await arm().search({ text: "payment retry" }, viewer);
    expect(before.map((hit) => hit.id)).toContain("page-1");

    await db.query(
      "UPDATE resources SET published_generation_id = NULL WHERE source_object_id = 'page-1'",
    );

    const after = await arm().search({ text: "payment retry" }, viewer);
    expect(after.map((hit) => hit.id)).not.toContain("page-1");
  });
});

describe("indexed arm inside the retrieval pipeline", () => {
  // Container ids are generated uuids, so they are read from `archContainer`
  // inside each test rather than captured when the module loads.
  it("fuses through the pipeline and applies the container gate", async () => {
    const result = await retrieve(
      [arm()],
      { text: "payment retry" },
      { ...viewer, containers: [archContainer] },
    );
    expect(result.hits.map((hit) => hit.id)).toContain("page-1");
    expect(result.aclRejected).toBe(0);
    expect(result.aclDrift).toBe(0);
  });

  it("returns nothing when the viewer can see no containers", async () => {
    const result = await retrieve(
      [arm()],
      { text: "payment retry" },
      { ...viewer, containers: [] },
    );
    expect(result.hits).toEqual([]);
  });
});
