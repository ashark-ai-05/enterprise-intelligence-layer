import { describe, expect, it } from "vitest";
import {
  AmbiguousObjectIdError,
  resolveExactObject,
} from "../src/retrieval/object-surfaces.js";
import type { Database, QueryResult } from "../src/storage/database.js";

const viewer = {
  principal: "test",
  principals: ["enterprise:everyone"],
  containers: ["00000000-0000-0000-0000-000000000001"],
};

function collisionDatabase(): Database {
  return {
    profile: "embedded",
    async query<Row extends Record<string, unknown>>(
      text: string,
    ): Promise<QueryResult<Row>> {
      if (text.includes("FROM resource_chunks")) {
        return {
          rows: ["jira", "git"].map((source, index) => ({
            chunk_id: `chunk-${index}`,
            resource_id: `resource-${index}`,
            source,
            source_object_id: "SHARED-1",
            container_id: viewer.containers[0] as string,
            stable_key: "body",
            kind: "body",
            text: `${source} body`,
            location: {},
          })) as unknown as Row[],
          rowCount: 2,
        };
      }
      return {
        rows: [
          { title: "Shared", canonical_uri: "https://example.test/shared" },
        ] as unknown as Row[],
        rowCount: 1,
      };
    },
    async executeScript() {},
    async close() {},
  };
}

describe("source-qualified exact object resolution", () => {
  it("rejects an ambiguous unqualified id", async () => {
    await expect(
      resolveExactObject(collisionDatabase(), "tenant", viewer, "SHARED-1"),
    ).rejects.toBeInstanceOf(AmbiguousObjectIdError);
  });

  it("resolves the requested source when ids collide", async () => {
    const result = await resolveExactObject(
      collisionDatabase(),
      "tenant",
      viewer,
      "SHARED-1",
      "git",
    );
    expect(result.found).toBe(true);
    expect(result.source).toBe("git");
    expect(result.hit?.source).toBe("git");
  });
});
