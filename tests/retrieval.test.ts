import { describe, expect, it } from "vitest";
import { classify, weightFor } from "../src/retrieval/classify.js";
import { resolveContainers, retrieve } from "../src/retrieval/pipeline.js";
import {
  CodeLexicalArm,
  type CorpusDocument,
  FailingArm,
  LooseLexicalArm,
  StrictLexicalArm,
  StubSemanticArm,
  tokenizeCode,
} from "../src/retrieval/stub-arms.js";
import type {
  RetrievalArm,
  RetrievalHit,
  RetrievalQuery,
  Viewer,
} from "../src/retrieval/types.js";

const doc = (
  id: string,
  source: string,
  container: string,
  title: string,
  body: string,
): CorpusDocument => ({
  id,
  source,
  container,
  title,
  body,
  url: `https://example.invalid/${id}`,
  syncedAt: "2026-08-11T00:00:00Z",
});

const CORPUS: CorpusDocument[] = [
  doc(
    "c1",
    "confluence",
    "ARCH",
    "Payment retry policy",
    "Payments retry three times with backoff.",
  ),
  doc(
    "c2",
    "confluence",
    "ARCH",
    "Onboarding guide",
    "How to get started on the platform team.",
  ),
  doc(
    "c3",
    "confluence",
    "SEC",
    "Incident response",
    "Restricted runbook for the security team.",
  ),
  doc(
    "j1",
    "jira",
    "PHX",
    "PHX-4471",
    "Retry policy misconfigured in production.",
  ),
  doc(
    "j2",
    "jira",
    "PHX",
    "PHX-4472",
    "Payments dashboard shows retry spikes.",
  ),
  doc(
    "j3",
    "jira",
    "PHX",
    "PHX-4473",
    "Retry backoff needs tuning for payments.",
  ),
  doc("j4", "jira", "PHX", "PHX-4474", "Another retry ticket about payments."),
  doc(
    "j5",
    "jira",
    "PHX",
    "PHX-4475",
    "Yet another payments retry conversation.",
  ),
  doc(
    "b1",
    "bitbucket",
    "PLAT",
    "services/payments/retry.ts",
    "export function retryPayment() {}",
  ),
];

const VIEWER: Viewer = {
  principal: "user:krunal",
  principals: ["user:krunal", "ad:engineering"],
  containers: ["ARCH", "PHX", "PLAT"], // deliberately not SEC
};

const allArms = (
  corpus: readonly CorpusDocument[] = CORPUS,
): RetrievalArm[] => [
  new StrictLexicalArm(corpus),
  new LooseLexicalArm(corpus),
  new CodeLexicalArm(corpus),
  new StubSemanticArm(corpus),
];

describe("classify", () => {
  it("recognises an issue key", () => {
    const result = classify("PHX-4471");
    expect(result.shape).toBe("issue-key");
    expect(result.literal).toBe("PHX-4471");
  });

  it("recognises a path", () => {
    expect(classify("services/payments/retry.ts").shape).toBe("path");
  });

  it("recognises identifiers in several conventions", () => {
    expect(classify("getUserById").shape).toBe("identifier");
    expect(classify("retry_with_backoff").shape).toBe("identifier");
    expect(classify("Payments::retry").shape).toBe("identifier");
  });

  it("recognises a quoted phrase and strips the quotes", () => {
    const result = classify('"exact wording here"');
    expect(result.shape).toBe("quoted-phrase");
    expect(result.literal).toBe("exact wording here");
  });

  it("recognises error strings", () => {
    expect(classify("NullPointerException in checkout").shape).toBe(
      "error-string",
    );
    expect(classify("getting ECONNREFUSED from the gateway").shape).toBe(
      "error-string",
    );
  });

  it("falls back to natural language", () => {
    expect(classify("where do we handle payment retries").shape).toBe(
      "natural-language",
    );
  });

  it("prefers the issue-key reading over the identifier reading", () => {
    // PHX-4471 matches an identifier-ish shape too. Specificity must win.
    expect(classify("PHX-4471").shape).toBe("issue-key");
  });

  it("weights arms without ever removing one", () => {
    // The router changes influence; it must never cut an arm out of the fan-out,
    // because an arm that never ran cannot be shown to have been the wrong call.
    for (const query of [
      "PHX-4471",
      "getUserById",
      "where do we handle retries",
      '"exact"',
    ]) {
      const classification = classify(query);
      for (const arm of [
        "lexical-strict",
        "lexical-loose",
        "code-lexical",
        "semantic",
        "federated",
      ]) {
        expect(weightFor(classification, arm)).toBeGreaterThan(0);
      }
    }
  });

  it("defaults an unlisted arm to neutral weight", () => {
    expect(weightFor(classify("PHX-4471"), "some-future-arm")).toBe(1);
  });

  it("is unaffected by surrounding whitespace", () => {
    expect(classify("   PHX-4471  ").shape).toBe("issue-key");
  });
});

describe("tokenizeCode", () => {
  it("splits camelCase so a search for a part finds the whole", () => {
    expect(tokenizeCode("getUserById")).toEqual(
      expect.arrayContaining(["getuserbyid", "get", "user", "by", "id"]),
    );
  });

  it("splits snake_case, paths and dots", () => {
    expect(tokenizeCode("retry_with_backoff")).toEqual(
      expect.arrayContaining(["retry", "with", "backoff"]),
    );
    expect(tokenizeCode("services/payments/retry.ts")).toEqual(
      expect.arrayContaining(["services", "payments", "retry", "ts"]),
    );
  });
});

describe("resolveContainers", () => {
  it("defaults to everything the viewer can see", () => {
    expect(resolveContainers({ text: "x" }, VIEWER).sort()).toEqual([
      "ARCH",
      "PHX",
      "PLAT",
    ]);
  });

  it("intersects rather than unions — a request cannot widen visibility", () => {
    const resolved = resolveContainers(
      { text: "x", containers: ["ARCH", "SEC"] },
      VIEWER,
    );
    expect(resolved).toEqual(["ARCH"]);
  });

  it("returns nothing when the caller names only containers they cannot see", () => {
    expect(
      resolveContainers({ text: "x", containers: ["SEC"] }, VIEWER),
    ).toEqual([]);
  });
});

describe("retrieve", () => {
  const search = (query: RetrievalQuery, viewer = VIEWER, arms = allArms()) =>
    retrieve(arms, query, viewer, { limit: 10 });

  it("finds documents across sources in one query", async () => {
    const result = await search({ text: "payment retry" });
    const sources = new Set(result.hits.map((hit) => hit.source));
    expect(sources.size).toBeGreaterThan(1);
  });

  it("never returns a container the viewer cannot see", async () => {
    const result = await search({
      text: "incident response restricted runbook",
    });
    expect(result.hits.every((hit) => hit.container !== "SEC")).toBe(true);
  });

  it("returns nothing, and touches no arm, when the viewer can see nothing", async () => {
    const blind: Viewer = {
      principal: "user:new",
      principals: ["user:new"],
      containers: [],
    };
    const result = await search({ text: "payment retry" }, blind);
    expect(result.hits).toEqual([]);
    expect(result.armsRun).toEqual([]);
  });

  it("reports zero ACL rejections when arms behave", async () => {
    // Non-zero means an arm returned something the viewer cannot see. That is a
    // bug in the arm, so it is surfaced rather than silently absorbed.
    const result = await search({ text: "payment retry" });
    expect(result.aclRejected).toBe(0);
  });

  it("catches an arm that ignores the ACL, rather than serving its results", async () => {
    class LeakyArm implements RetrievalArm {
      readonly name = "leaky";
      isAvailable(): boolean {
        return true;
      }
      async search(): Promise<RetrievalHit[]> {
        const { body: _body, ...hit } = CORPUS[2] as CorpusDocument; // the SEC document
        return [hit];
      }
    }
    const result = await retrieve(
      [new LeakyArm()],
      { text: "incident" },
      VIEWER,
    );
    expect(result.hits).toEqual([]);
    expect(result.aclRejected).toBe(1);
  });

  it("degrades when an arm fails instead of failing the query", async () => {
    const arms = [
      ...allArms(),
      new FailingArm("semantic-v2", "model unavailable"),
    ];
    const result = await retrieve(arms, { text: "payment retry" }, VIEWER);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.armsSkipped).toContainEqual({
      arm: "semantic-v2",
      reason: "model unavailable",
    });
  });

  it("skips an unavailable arm and says so", async () => {
    const arms = [
      new StrictLexicalArm(CORPUS),
      new StubSemanticArm(CORPUS, false),
    ];
    const result = await retrieve(arms, { text: "payment retry" }, VIEWER);
    expect(result.armsRun).toEqual(["lexical-strict"]);
    expect(result.armsSkipped).toEqual([
      { arm: "semantic", reason: "unavailable" },
    ]);
  });

  it("stops a chatty source burying the document that answers the question", async () => {
    // Five Jira issues match "payments retry"; only one Confluence page does.
    // Uncapped, the Jira issues take the whole page.
    const result = await retrieve(
      allArms(),
      { text: "payments retry" },
      VIEWER,
      {
        limit: 5,
        maxPerSource: 2,
      },
    );

    const confluenceRank = result.hits.findIndex(
      (hit) => hit.source === "confluence",
    );
    expect(confluenceRank).toBeGreaterThanOrEqual(0);

    // The guarantee is about the chatty source specifically: at most
    // `maxPerSource` Jira issues may be promoted ahead of it. Other sources are
    // free to rank higher on merit.
    const jiraAhead = result.hits
      .slice(0, confluenceRank)
      .filter((hit) => hit.source === "jira");
    expect(jiraAhead.length).toBeLessThanOrEqual(2);
  });

  it("still fills the page when there is nothing diverse left to promote", async () => {
    // The cap demotes rather than discards. A result set genuinely dominated by
    // one source must fill up rather than return short — otherwise capping
    // silently costs the user results they would have wanted.
    const result = await retrieve(
      allArms(),
      { text: "payments retry" },
      VIEWER,
      {
        limit: 5,
        maxPerSource: 2,
      },
    );
    expect(result.hits).toHaveLength(5);
    expect(
      result.hits.filter((hit) => hit.source === "jira").length,
    ).toBeGreaterThan(2);
  });

  it("is deterministic — the same query returns the same order", async () => {
    const first = await search({ text: "payment retry policy" });
    const second = await search({ text: "payment retry policy" });
    expect(first.hits.map((hit) => hit.id)).toEqual(
      second.hits.map((hit) => hit.id),
    );
  });

  it("honours a source filter", async () => {
    const result = await search({ text: "retry", sources: ["jira"] });
    expect(result.hits.every((hit) => hit.source === "jira")).toBe(true);
  });

  it("respects the requested limit", async () => {
    const result = await retrieve(
      allArms(),
      { text: "retry", limit: 2 },
      VIEWER,
    );
    expect(result.hits).toHaveLength(2);
  });

  it("explains which arms contributed to each hit", async () => {
    const result = await search({ text: "payment retry" });
    const top = result.hits[0];
    expect(top?.arms.length).toBeGreaterThan(0);
    expect(top?.arms[0]).toMatchObject({
      arm: expect.any(String),
      rank: expect.any(Number),
    });
  });

  it("ranks a code path above prose for a path-shaped query", async () => {
    const result = await search({ text: "services/payments/retry.ts" });
    expect(result.hits[0]?.id).toBe("b1");
  });

  it("finds an issue by its exact key", async () => {
    const result = await search({ text: "PHX-4471" });
    expect(result.hits[0]?.id).toBe("j1");
  });

  it("returns nothing for a query that matches nothing", async () => {
    const result = await search({ text: "zzzznonexistentterm" });
    expect(result.hits).toEqual([]);
  });

  it("returns nothing for an empty query rather than everything", async () => {
    const result = await search({ text: "   " });
    expect(result.hits).toEqual([]);
  });
});
