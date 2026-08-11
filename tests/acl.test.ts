import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  StubConfluenceConnector,
  StubJiraConnector,
} from "../src/connectors/stubs.js";
import type { SourceItem } from "../src/connectors/types.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { createScope } from "../src/scopes/service.js";
import {
  assignResourceContainer,
  ensureContainer,
  listAuthorizedChunks,
  listAuthorizedChunksForSubject,
  mapPrincipal,
  markPrincipalUnmapped,
  replaceContainerAces,
  resolveViewerPrincipals,
} from "../src/security/acl.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

const engineering = { domain: "atlassian", principalId: "engineering" };
const security = { domain: "atlassian", principalId: "security" };

function confluencePage(acl: SourceItem["acl"] = []): SourceItem {
  return {
    sourceObjectId: "page-1",
    sourceVersion: "1",
    canonicalUri: "https://example.atlassian.net/wiki/pages/1",
    title: "Payments architecture",
    body: "# Retry policy\nUse exponential backoff.",
    metadata: { pageId: "1", spaceKey: "ARCH" },
    acl,
    sourceUpdatedAt: "2026-08-11T00:00:00Z",
    deleted: false,
  };
}

let db: Database;
let resourceId: string;
let containerId: string;

beforeEach(async () => {
  db = await testDatabase();
  const scope = await createScope(db, {
    tenantId: "acme",
    source: "confluence",
    selectorKind: "space",
    selector: { keys: ["ARCH"] },
    refreshMode: "manual",
    includeChildren: true,
    addedBy: "operator",
  });
  await ingestScope(
    db,
    "acme",
    scope.id,
    new StubConfluenceConnector([{ sequence: 1, item: confluencePage() }]),
  );
  const resource = await db.query<{ id: string }>("SELECT id FROM resources");
  resourceId = resource.rows[0]?.id ?? "";
  containerId = await ensureContainer(
    db,
    "acme",
    "confluence",
    "ARCH",
    "Architecture",
  );
  await assignResourceContainer(db, "acme", resourceId, containerId);
});

afterEach(async () => {
  await db.close();
});

describe("identity and ACL plane", () => {
  it("inherits container access and fails closed without an allow", async () => {
    expect(await listAuthorizedChunks(db, "acme", [engineering])).toEqual([]);
    await replaceContainerAces(db, "acme", containerId, [
      { ...engineering, effect: "allow" },
    ]);
    const chunks = await listAuthorizedChunks(db, "acme", [engineering]);
    expect(chunks.map(({ stableKey }) => stableKey)).toEqual(["body"]);
  });

  it("applies deny-wins at container and resource levels", async () => {
    await replaceContainerAces(db, "acme", containerId, [
      { ...engineering, effect: "allow" },
      { ...engineering, effect: "deny" },
    ]);
    expect(await listAuthorizedChunks(db, "acme", [engineering])).toEqual([]);

    await replaceContainerAces(db, "acme", containerId, [
      { ...engineering, effect: "allow" },
    ]);
    await db.query(
      `INSERT INTO resource_aces (resource_id, principal_domain, principal_id, effect)
       VALUES ($1, $2, $3, 'deny')`,
      [resourceId, engineering.domain, engineering.principalId],
    );
    expect(await listAuthorizedChunks(db, "acme", [engineering])).toEqual([]);
  });

  it("treats resource allows as a restrictive override", async () => {
    await replaceContainerAces(db, "acme", containerId, [
      { ...engineering, effect: "allow" },
      { ...security, effect: "allow" },
    ]);
    await db.query(
      `INSERT INTO resource_aces (resource_id, principal_domain, principal_id, effect)
       VALUES ($1, $2, $3, 'allow')`,
      [resourceId, security.domain, security.principalId],
    );
    expect(await listAuthorizedChunks(db, "acme", [engineering])).toEqual([]);
    expect(await listAuthorizedChunks(db, "acme", [security])).toHaveLength(1);
  });

  it("maps source principals to an enterprise subject and fails closed when unmapped", async () => {
    await replaceContainerAces(db, "acme", containerId, [
      { ...engineering, effect: "allow" },
    ]);
    await mapPrincipal(db, "acme", "oidc:alice", engineering);
    expect(await resolveViewerPrincipals(db, "acme", "oidc:alice")).toEqual([
      engineering,
    ]);
    expect(
      await listAuthorizedChunksForSubject(db, "acme", "oidc:alice"),
    ).toHaveLength(1);

    await mapPrincipal(db, "acme", "oidc:carol", engineering);
    expect(await resolveViewerPrincipals(db, "acme", "oidc:alice")).toEqual([
      engineering,
    ]);
    expect(await resolveViewerPrincipals(db, "acme", "oidc:carol")).toEqual([
      engineering,
    ]);
    expect(
      await listAuthorizedChunksForSubject(db, "acme", "oidc:carol"),
    ).toHaveLength(1);

    await markPrincipalUnmapped(db, "acme", engineering);
    expect(await resolveViewerPrincipals(db, "acme", "oidc:alice")).toEqual([]);
    expect(await resolveViewerPrincipals(db, "acme", "oidc:carol")).toEqual([]);
    expect(
      await listAuthorizedChunksForSubject(db, "acme", "oidc:alice"),
    ).toEqual([]);
  });

  it("enforces sparse chunk ACL overlays for restricted Jira comments", async () => {
    const jiraScope = await createScope(db, {
      tenantId: "acme",
      source: "jira",
      selectorKind: "project",
      selector: { keys: ["PAY"] },
      refreshMode: "manual",
      addedBy: "operator",
    });
    const issue: SourceItem = {
      sourceObjectId: "PAY-1",
      sourceVersion: "1",
      canonicalUri: "https://example.atlassian.net/browse/PAY-1",
      title: "Payment retry incident",
      body: "Public issue body",
      metadata: {
        issueKey: "PAY-1",
        projectKey: "PAY",
        comments: [
          { id: "c1", body: "Public comment" },
          { id: "c2", body: "Security-only detail", visibility: security },
        ],
      },
      acl: [],
      sourceUpdatedAt: "2026-08-11T00:00:00Z",
      deleted: false,
    };
    await ingestScope(
      db,
      "acme",
      jiraScope.id,
      new StubJiraConnector([{ sequence: 1, item: issue }]),
    );
    const jiraResource = await db.query<{ id: string }>(
      "SELECT id FROM resources WHERE source = 'jira'",
    );
    const jiraContainer = await ensureContainer(
      db,
      "acme",
      "jira",
      "PAY",
      "Payments",
    );
    await assignResourceContainer(
      db,
      "acme",
      jiraResource.rows[0]?.id ?? "",
      jiraContainer,
    );
    await replaceContainerAces(db, "acme", jiraContainer, [
      { ...engineering, effect: "allow" },
      { ...security, effect: "allow" },
    ]);

    const engineeringChunks = await listAuthorizedChunks(
      db,
      "acme",
      [engineering],
      [jiraContainer],
    );
    expect(engineeringChunks.map(({ text }) => text)).not.toContain(
      "Security-only detail",
    );
    const securityChunks = await listAuthorizedChunks(
      db,
      "acme",
      [security],
      [jiraContainer],
    );
    expect(securityChunks.map(({ text }) => text)).toContain(
      "Security-only detail",
    );
  });

  it("does not cross tenant or requested-container boundaries", async () => {
    await replaceContainerAces(db, "acme", containerId, [
      { ...engineering, effect: "allow" },
    ]);
    expect(await listAuthorizedChunks(db, "other", [engineering])).toEqual([]);
    expect(
      await listAuthorizedChunks(
        db,
        "acme",
        [engineering],
        [crypto.randomUUID()],
      ),
    ).toEqual([]);
  });
});
