import { describe, expect, it } from "vitest";
import type { ValidatedSourceItem } from "../src/connectors/types.js";
import { normalizerFor } from "../src/normalization/normalizers.js";

function item(
  metadata: Record<string, unknown>,
  body = "fallback body",
): ValidatedSourceItem {
  return {
    sourceObjectId: "item-1",
    sourceVersion: "1",
    canonicalUri: "https://example.test/item-1",
    title: "Item",
    body,
    metadata,
    acl: [],
    sourceUpdatedAt: "2026-08-11T00:00:00Z",
    deleted: false,
  };
}

describe("source-specific structural normalization", () => {
  it("preserves Confluence heading paths and anchors", () => {
    const chunks = normalizerFor("confluence").normalize(
      item({
        sections: [
          {
            anchor: "overview",
            headingPath: ["Payments", "Overview"],
            text: "System overview",
          },
          {
            anchor: "retries",
            headingPath: ["Payments", "Retries"],
            text: "Retry policy",
          },
        ],
      }),
    );
    expect(chunks).toEqual([
      {
        stableKey: "section:overview",
        kind: "section",
        text: "System overview",
        location: { anchor: "overview", headingPath: ["Payments", "Overview"] },
      },
      {
        stableKey: "section:retries",
        kind: "section",
        text: "Retry policy",
        location: { anchor: "retries", headingPath: ["Payments", "Retries"] },
      },
    ]);
  });

  it("keeps Jira comments addressable with sparse visibility ACL overrides", () => {
    const chunks = normalizerFor("jira").normalize(
      item({
        description: "Customer-visible description",
        comments: [
          { id: "10", body: "Public comment", author: "Ada" },
          {
            id: "11",
            body: "Security-only note",
            visibility: {
              domain: "jira-role:PAY",
              principalId: "security-team",
            },
          },
        ],
      }),
    );
    expect(chunks.map(({ stableKey }) => stableKey)).toEqual([
      "description",
      "comment:10",
      "comment:11",
    ]);
    expect(chunks[2]?.aclOverride).toEqual([
      {
        domain: "jira-role:PAY",
        principalId: "security-team",
        effect: "allow",
      },
    ]);
  });

  it("uses code symbols when available and line windows otherwise", () => {
    const symbols = normalizerFor("git").normalize(
      item({
        path: "src/retry.ts",
        symbols: [
          {
            name: "retryPayment",
            kind: "function",
            startLine: 10,
            endLine: 22,
            text: "export function retryPayment() {}",
          },
        ],
      }),
    );
    expect(symbols[0]).toMatchObject({
      stableKey: "symbol:function:retryPayment",
      kind: "symbol",
      location: { path: "src/retry.ts", startLine: 10, endLine: 22 },
    });

    const lines = normalizerFor("bitbucket").normalize(
      item(
        { path: "legacy.txt" },
        Array.from({ length: 205 }, (_, index) => `line ${index + 1}`).join(
          "\n",
        ),
      ),
    );
    expect(lines.map(({ stableKey }) => stableKey)).toEqual([
      "lines:1",
      "lines:201",
    ]);
    expect(lines[1]?.location).toMatchObject({ startLine: 201, endLine: 205 });
  });

  it("preserves document page coordinates", () => {
    const chunks = normalizerFor("files").normalize(
      item({
        pages: [
          {
            pageNumber: 3,
            text: "Evidence on page three",
            boundingBox: [0, 0, 100, 200],
          },
        ],
      }),
    );
    expect(chunks).toEqual([
      {
        stableKey: "page:3",
        kind: "page",
        text: "Evidence on page three",
        location: { pageNumber: 3, boundingBox: [0, 0, 100, 200] },
      },
    ]);
  });
});
