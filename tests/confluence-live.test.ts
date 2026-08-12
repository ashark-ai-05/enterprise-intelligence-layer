import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfluenceConnector,
  confluenceConnectorFromEnv,
} from "../src/connectors/confluence.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { createScope } from "../src/scopes/service.js";
import { searchCommand } from "../src/serving/cli-commands.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

function page(id = "123", version = 7) {
  return {
    id,
    title: "Payment Retry Runbook",
    type: "page",
    body: {
      storage: {
        value:
          "<h2>Retry policy</h2><p>Retry payment calls three times &amp; alert.</p>",
      },
    },
    version: { number: version, when: "2026-08-12T00:00:00.000Z" },
    space: { key: "PAY", name: "Payments" },
    restrictions: {
      read: {
        restrictions: {
          user: { results: [] },
          group: { results: [] },
        },
      },
    },
    _links: {
      base: "https://wiki.example.test",
      webui: `/spaces/PAY/pages/${id}`,
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

describe("live Confluence connector", () => {
  it("fetches an exact page with offline normalization and personal ACLs", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        response(page()),
    );
    const connector = new ConfluenceConnector({
      baseUrl: "https://wiki.example.test",
      token: "secret-token",
      email: "agent@example.test",
      principal: "agent@example.test",
      fetch: fetcher as typeof fetch,
    });
    const scope = await createScope(db, {
      tenantId: "local",
      source: "confluence",
      selectorKind: "page",
      selector: { ids: ["123"] },
      refreshMode: "manual",
      addedBy: "test",
    });

    expect(await ingestScope(db, "local", scope.id, connector)).toMatchObject({
      discovered: 1,
      created: 1,
    });
    const request = fetcher.mock.calls[0]?.[1];
    if (!request) throw new Error("expected Confluence request options");
    expect((request.headers as Record<string, string>).Authorization).toMatch(
      /^Basic /,
    );
    const stored = await db.query<{
      body: string;
      source_version: string;
      container_id: string | null;
    }>("SELECT body, source_version, container_id FROM resources");
    expect(stored.rows[0]).toMatchObject({
      body: "Retry policy\nRetry payment calls three times & alert.",
      source_version: "7",
    });
    expect(stored.rows[0]?.container_id).not.toBeNull();
    expect(
      (await searchCommand(db, "local", "payment retry")).hits[0],
    ).toMatchObject({
      id: "123",
      source: "confluence",
    });
  });

  it("paginates a selected space and uses the cursor as a delta boundary", async () => {
    const seen: URL[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      seen.push(url);
      const start = Number(url.searchParams.get("start") ?? 0);
      return response({
        results: start === 0 ? [page("1")] : [page("2")],
        _links: start === 0 ? { next: "/next" } : {},
      });
    });
    const connector = new ConfluenceConnector({
      baseUrl: "https://wiki.example.test",
      token: "token",
      principal: "account-1",
      fetch: fetcher as typeof fetch,
      pageSize: 1,
    });
    const scope = await createScope(db, {
      tenantId: "local",
      source: "confluence",
      selectorKind: "space",
      selector: { keys: ["PAY"] },
      refreshMode: "manual",
      addedBy: "test",
    });
    const batch = await connector.read(scope, {
      sequence: Date.parse("2026-08-11T23:00:00.000Z"),
    });
    expect(batch.items.map((item) => item.sourceObjectId)).toEqual(["1", "2"]);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.searchParams.get("cql")).toContain("lastmodified >=");
  });

  it.each([403, 404])(
    "treats an inaccessible exact page (%s) as absent during reconciliation",
    async (status) => {
      const connector = new ConfluenceConnector({
        baseUrl: "https://wiki.example.test",
        token: "token",
        principal: "account-1",
        fetch: vi.fn(async () => response({}, status)) as typeof fetch,
      });
      const scope = await createScope(db, {
        tenantId: "local",
        source: "confluence",
        selectorKind: "page",
        selector: { ids: ["deleted"] },
        refreshMode: "manual",
        addedBy: "test",
      });
      expect(await connector.listCurrentIds(scope)).toEqual([]);
    },
  );

  it("requires an explicit personal principal and credential", () => {
    expect(() =>
      confluenceConnectorFromEnv({
        EIL_CONFLUENCE_URL: "https://wiki.example.test",
      }),
    ).toThrow("EIL_CONFLUENCE_TOKEN");
  });
});
