import { describe, expect, it } from "vitest";
import {
  StubConfluenceConnector,
  StubFilesConnector,
  StubGitConnector,
  StubJiraConnector,
} from "../src/connectors/stubs.js";
import type { SourceItem } from "../src/connectors/types.js";
import type { IngestionScope, Source } from "../src/scopes/types.js";

function scope(
  source: Source,
  selectorKind: string,
  selector: Record<string, unknown>,
): IngestionScope {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    tenantId: "acme",
    source,
    selectorKind,
    selector,
    refreshMode: "manual",
    includeChildren: false,
    includeAttachments: true,
    schedule: null,
    enabled: true,
    addedBy: "user-1",
    configVersion: 1,
    cursor: null,
    lastStatus: null,
    deletionPolicy: "retain",
  };
}

function item(
  id: string,
  metadata: Record<string, unknown>,
  deleted = false,
): SourceItem {
  return {
    sourceObjectId: id,
    sourceVersion: "1",
    canonicalUri: `https://example.test/${id}`,
    title: id,
    body: `${id} body`,
    metadata,
    acl: [{ domain: "directory", principalId: "engineering", effect: "allow" }],
    sourceUpdatedAt: "2026-08-11T00:00:00Z",
    deleted,
  };
}

describe("fixture-backed source connectors", () => {
  it("selects exact Confluence pages or bounded spaces", async () => {
    const connector = new StubConfluenceConnector([
      { sequence: 1, item: item("page-1", { pageId: "1", spaceKey: "ARCH" }) },
      { sequence: 2, item: item("page-2", { pageId: "2", spaceKey: "OTHER" }) },
    ]);
    expect(
      (await connector.read(scope("confluence", "page", { ids: ["2"] }), null))
        .items,
    ).toHaveLength(1);
    expect(
      (
        await connector.read(
          scope("confluence", "space", { keys: ["ARCH"] }),
          null,
        )
      ).items[0]?.sourceObjectId,
    ).toBe("page-1");
  });

  it("selects Jira issues or projects", async () => {
    const connector = new StubJiraConnector([
      {
        sequence: 1,
        item: item("PAY-1", { issueKey: "PAY-1", projectKey: "PAY" }),
      },
      {
        sequence: 2,
        item: item("OPS-1", { issueKey: "OPS-1", projectKey: "OPS" }),
      },
    ]);
    expect(
      (await connector.read(scope("jira", "issue", { keys: ["OPS-1"] }), null))
        .items[0]?.sourceObjectId,
    ).toBe("OPS-1");
    expect(
      (await connector.read(scope("jira", "project", { keys: ["PAY"] }), null))
        .items,
    ).toHaveLength(1);
  });

  it("selects repository, ref, and optional monorepo subtree", async () => {
    const connector = new StubGitConnector("bitbucket", [
      {
        sequence: 1,
        item: item("blob-1", {
          repository: "platform",
          ref: "main",
          path: "services/payments/api.ts",
        }),
      },
      {
        sequence: 2,
        item: item("blob-2", {
          repository: "platform",
          ref: "main",
          path: "services/orders/api.ts",
        }),
      },
      {
        sequence: 3,
        item: item("blob-3", {
          repository: "platform",
          ref: "release",
          path: "services/payments/api.ts",
        }),
      },
    ]);
    const batch = await connector.read(
      scope("bitbucket", "repo", {
        repositories: ["platform"],
        refs: ["main"],
        pathPrefix: "services/payments/",
      }),
      null,
    );
    expect(batch.items.map(({ sourceObjectId }) => sourceObjectId)).toEqual([
      "blob-1",
    ]);
  });

  it("selects exact files or bounded directory roots", async () => {
    const connector = new StubFilesConnector([
      { sequence: 1, item: item("file-1", { path: "/notes/payments.md" }) },
      { sequence: 2, item: item("file-2", { path: "/private/hr.md" }) },
    ]);
    expect(
      (
        await connector.read(
          scope("files", "file", { paths: ["/private/hr.md"] }),
          null,
        )
      ).items,
    ).toHaveLength(1);
    expect(
      await connector.listCurrentIds(
        scope("files", "path", { roots: ["/notes"] }),
      ),
    ).toEqual(["file-1"]);
  });

  it("returns only events after the scope cursor and excludes current tombstones", async () => {
    const connector = new StubJiraConnector([
      {
        sequence: 1,
        item: item("PAY-1", { issueKey: "PAY-1", projectKey: "PAY" }),
      },
      {
        sequence: 2,
        item: item("PAY-1", { issueKey: "PAY-1", projectKey: "PAY" }, true),
      },
      {
        sequence: 3,
        item: item("PAY-2", { issueKey: "PAY-2", projectKey: "PAY" }),
      },
    ]);
    const selected = scope("jira", "project", { keys: ["PAY"] });
    expect(
      (await connector.read(selected, { sequence: 2 })).items.map(
        ({ sourceObjectId }) => sourceObjectId,
      ),
    ).toEqual(["PAY-2"]);
    expect(await connector.listCurrentIds(selected)).toEqual(["PAY-2"]);
  });
});
