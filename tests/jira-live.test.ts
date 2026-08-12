import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraConnector, jiraConnectorFromEnv } from "../src/connectors/jira.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { createScope } from "../src/scopes/service.js";
import { searchCommand } from "../src/serving/cli-commands.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

function issue(key = "PAY-4471", updated = "2026-08-12T00:00:00.000Z") {
  return {
    id: "10042",
    key,
    fields: {
      summary: "Retries exhausted on gateway timeout",
      description: "Retry payment calls three times and alert on exhaustion.",
      updated,
      created: "2026-08-01T00:00:00.000Z",
      project: { key: "PAY", name: "Payments" },
      comment: {
        comments: [
          {
            id: "9001",
            body: "Confirmed on staging.",
            author: { displayName: "Ada Lovelace" },
            created: "2026-08-11T00:00:00.000Z",
            visibility: { type: "role", value: "Administrators" },
          },
        ],
      },
    },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let db: Database;
beforeEach(async () => {
  db = await testDatabase();
});
afterEach(async () => {
  await db.close();
});

describe("live Jira connector", () => {
  it("fetches an exact issue with comment ACL overrides and personal ACLs", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        response(issue()),
    );
    const connector = new JiraConnector({
      baseUrl: "https://issues.example.test",
      token: "secret-token",
      email: "agent@example.test",
      principal: "agent@example.test",
      fetch: fetcher as typeof fetch,
    });
    const scope = await createScope(db, {
      tenantId: "local",
      source: "jira",
      selectorKind: "issues",
      selector: { ids: ["PAY-4471"] },
      refreshMode: "manual",
      addedBy: "test",
    });

    expect(await ingestScope(db, "local", scope.id, connector)).toMatchObject({
      discovered: 1,
      created: 1,
    });
    const request = fetcher.mock.calls[0]?.[1];
    if (!request) throw new Error("expected Jira request options");
    expect((request.headers as Record<string, string>).Authorization).toMatch(
      /^Basic /,
    );
    const stored = await db.query<{
      body: string;
      container_id: string | null;
    }>("SELECT body, container_id FROM resources");
    expect(stored.rows[0]).toMatchObject({
      body: "Retry payment calls three times and alert on exhaustion.",
    });
    expect(stored.rows[0]?.container_id).not.toBeNull();
    expect(
      (await searchCommand(db, "local", "retry payment calls")).hits[0],
    ).toMatchObject({
      id: "PAY-4471",
      source: "jira",
    });
  });

  it("searches a selected project by JQL and uses the cursor as a delta boundary", async () => {
    const seen: URL[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      seen.push(url);
      const startAt = Number(url.searchParams.get("startAt") ?? 0);
      return response({
        issues: startAt === 0 ? [issue("PAY-1")] : [issue("PAY-2")],
        startAt,
        maxResults: 1,
        total: 2,
      });
    });
    const connector = new JiraConnector({
      baseUrl: "https://issues.example.test",
      token: "token",
      principal: "account-1",
      fetch: fetcher as typeof fetch,
      pageSize: 1,
    });
    const scope = await createScope(db, {
      tenantId: "local",
      source: "jira",
      selectorKind: "project",
      selector: { keys: ["PAY"] },
      refreshMode: "manual",
      addedBy: "test",
    });
    const batch = await connector.read(scope, {
      sequence: Date.parse("2026-08-11T23:00:00.000Z"),
    });
    expect(batch.items.map((item) => item.sourceObjectId)).toEqual([
      "PAY-1",
      "PAY-2",
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.searchParams.get("jql")).toContain("updated >=");
  });

  it.each([403, 404])(
    "treats an inaccessible exact issue (%s) as absent during reconciliation",
    async (status) => {
      const connector = new JiraConnector({
        baseUrl: "https://issues.example.test",
        token: "token",
        principal: "account-1",
        fetch: vi.fn(async () => response({}, status)) as typeof fetch,
      });
      const scope = await createScope(db, {
        tenantId: "local",
        source: "jira",
        selectorKind: "issues",
        selector: { ids: ["deleted"] },
        refreshMode: "manual",
        addedBy: "test",
      });
      expect(await connector.listCurrentIds(scope)).toEqual([]);
    },
  );

  it("requires an explicit personal principal and credential", () => {
    expect(() =>
      jiraConnectorFromEnv({
        EIL_JIRA_URL: "https://issues.example.test",
      }),
    ).toThrow("EIL_JIRA_TOKEN");
  });

  it("degrades an Atlassian Document Format description to text instead of [object Object]", async () => {
    // This connector calls REST API v2, which returns plain strings on every
    // Jira edition — this exercises the defensive fallback for a v3-shaped
    // (ADF) payload, not the primary path.
    const adfIssue = {
      ...issue(),
      fields: {
        ...issue().fields,
        description: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Retry payment calls" }],
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: "three times and alert." }],
            },
          ],
        },
      },
    };
    const connector = new JiraConnector({
      baseUrl: "https://issues.example.test",
      token: "token",
      principal: "account-1",
      fetch: vi.fn(async () => response(adfIssue)) as typeof fetch,
    });
    const scope = await createScope(db, {
      tenantId: "local",
      source: "jira",
      selectorKind: "issues",
      selector: { ids: ["PAY-4471"] },
      refreshMode: "manual",
      addedBy: "test",
    });
    await ingestScope(db, "local", scope.id, connector);
    const stored = await db.query<{ body: string }>(
      "SELECT body FROM resources",
    );
    expect(stored.rows[0]?.body).not.toContain("[object Object]");
    expect(stored.rows[0]?.body).toContain("Retry payment calls");
    expect(stored.rows[0]?.body).toContain("three times and alert.");
  });
});
