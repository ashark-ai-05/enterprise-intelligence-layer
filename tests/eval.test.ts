import { describe, expect, it } from "vitest";
import {
  evaluate,
  formatReport,
  harvestFromLinks,
} from "../src/eval/harness.js";
import {
  checkRegression,
  ndcgAt,
  precisionAt,
  recallAt,
  reciprocalRank,
  score,
} from "../src/eval/metrics.js";
import {
  type CorpusDocument,
  LooseLexicalArm,
  StrictLexicalArm,
} from "../src/retrieval/stub-arms.js";
import type { Viewer } from "../src/retrieval/types.js";

describe("recallAt", () => {
  it("is the fraction of relevant documents found in the top k", () => {
    expect(recallAt(["a", "b", "c"], ["a", "c"], 3)).toBe(1);
    expect(recallAt(["a", "x", "y"], ["a", "c"], 3)).toBe(0.5);
  });

  it("respects the cutoff", () => {
    expect(recallAt(["x", "y", "a"], ["a"], 2)).toBe(0);
    expect(recallAt(["x", "y", "a"], ["a"], 3)).toBe(1);
  });

  it("treats an empty relevant set as trivially satisfied", () => {
    expect(recallAt(["a"], [], 10)).toBe(1);
  });
});

describe("precisionAt", () => {
  it("is the fraction of the top k that is relevant", () => {
    expect(precisionAt(["a", "x"], ["a"], 2)).toBe(0.5);
  });

  it("does not punish a short result list for being short", () => {
    // Only one result returned, and it was right: that is precision 1, not 0.1.
    expect(precisionAt(["a"], ["a"], 10)).toBe(1);
  });

  it("is zero when nothing was returned", () => {
    expect(precisionAt([], ["a"], 10)).toBe(0);
  });
});

describe("reciprocalRank", () => {
  it("rewards finding the answer early", () => {
    expect(reciprocalRank(["a", "b"], ["a"])).toBe(1);
    expect(reciprocalRank(["b", "a"], ["a"])).toBe(0.5);
    expect(reciprocalRank(["b", "c", "a"], ["a"])).toBeCloseTo(1 / 3, 10);
  });

  it("is zero when the answer never appears", () => {
    expect(reciprocalRank(["b", "c"], ["a"])).toBe(0);
  });
});

describe("ndcgAt", () => {
  it("is 1 for a perfect ranking", () => {
    expect(ndcgAt(["a", "b"], ["a", "b"], 2)).toBeCloseTo(1, 10);
  });

  it("penalises burying a relevant result", () => {
    const early = ndcgAt(["a", "x", "y"], ["a"], 3);
    const late = ndcgAt(["x", "y", "a"], ["a"], 3);
    expect(early).toBeGreaterThan(late);
  });

  it("is zero when nothing relevant is retrieved", () => {
    expect(ndcgAt(["x", "y"], ["a"], 2)).toBe(0);
  });
});

describe("score", () => {
  it("aggregates across queries and counts zero-result queries", () => {
    const report = score(
      [
        { query: "found", retrieved: ["a"], relevant: ["a"] },
        { query: "missed", retrieved: [], relevant: ["b"] },
      ],
      10,
    );
    expect(report.queries).toBe(2);
    expect(report.zeroResults).toBe(1);
    expect(report.mrr).toBeCloseTo(0.5, 10);
  });
});

describe("checkRegression", () => {
  const baseline = score(
    [{ query: "q", retrieved: ["a", "b"], relevant: ["a"] }],
    10,
  );

  it("passes an identical run", () => {
    expect(checkRegression(baseline, baseline).passed).toBe(true);
  });

  it("fails when the answer moves down the page", () => {
    const worse = score(
      [{ query: "q", retrieved: ["x", "y", "a"], relevant: ["a"] }],
      10,
    );
    const verdict = checkRegression(baseline, worse);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(" ")).toMatch(/MRR/);
  });

  it("fails when a query stops returning anything", () => {
    const worse = score([{ query: "q", retrieved: [], relevant: ["a"] }], 10);
    expect(checkRegression(baseline, worse).failures.join(" ")).toMatch(
      /zero-result/,
    );
  });

  it("tolerates noise, because a gate that fires on noise gets disabled", () => {
    const baselineTwo = score(
      [
        { query: "a", retrieved: ["1"], relevant: ["1"] },
        { query: "b", retrieved: ["2"], relevant: ["2"] },
      ],
      10,
    );
    // A movement smaller than the tolerance must not trip the gate.
    const nudged = { ...baselineTwo, mrr: baselineTwo.mrr - 0.005 };
    expect(checkRegression(baselineTwo, nudged, 0.01).passed).toBe(true);
  });

  it("passes an improvement", () => {
    const better = score(
      [{ query: "q", retrieved: ["a"], relevant: ["a"] }],
      10,
    );
    expect(checkRegression(baseline, better).passed).toBe(true);
  });
});

describe("harvestFromLinks", () => {
  it("turns a link into a labelled pair", () => {
    // A human decided that page was relevant to that text. That is a label.
    const pairs = harvestFromLinks([
      { sourceText: "payment retries failing", targetId: "confluence:c1" },
    ]);
    expect(pairs).toEqual([
      {
        query: "payment retries failing",
        relevant: ["confluence:c1"],
        origin: "link-graph",
      },
    ]);
  });

  it("merges several links from the same text into one pair", () => {
    const pairs = harvestFromLinks([
      { sourceText: "retry design", targetId: "c1" },
      { sourceText: "retry design", targetId: "c2" },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.relevant).toEqual(["c1", "c2"]);
  });

  it("marks the origin, because harvested labels are weaker than written ones", () => {
    const pairs = harvestFromLinks([{ sourceText: "x", targetId: "y" }]);
    expect(pairs[0]?.origin).toBe("link-graph");
  });

  it("ignores empty source text", () => {
    expect(harvestFromLinks([{ sourceText: "   ", targetId: "y" }])).toEqual(
      [],
    );
  });

  it("is deterministic in output order", () => {
    const edges = [
      { sourceText: "b", targetId: "2" },
      { sourceText: "a", targetId: "1" },
    ];
    expect(harvestFromLinks(edges).map((pair) => pair.query)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("evaluate", () => {
  const corpus: CorpusDocument[] = [
    {
      id: "c1",
      source: "confluence",
      container: "ARCH",
      title: "Payment retry policy",
      body: "Payments retry three times with backoff.",
      url: "u1",
      syncedAt: null,
    },
    {
      id: "c2",
      source: "confluence",
      container: "ARCH",
      title: "Onboarding",
      body: "Getting started.",
      url: "u2",
      syncedAt: null,
    },
  ];
  const viewer: Viewer = {
    principal: "p",
    principals: ["p"],
    containers: ["ARCH"],
  };

  it("scores a golden set through the real pipeline", async () => {
    const report = await evaluate(
      [new StrictLexicalArm(corpus), new LooseLexicalArm(corpus)],
      [{ query: "payment retry", relevant: ["c1"] }],
      viewer,
    );
    expect(report.queries).toBe(1);
    expect(report.recallAtK).toBe(1);
    expect(report.mrr).toBe(1);
  });

  it("records a query that finds nothing as a zero-result", async () => {
    const report = await evaluate(
      [new StrictLexicalArm(corpus)],
      [{ query: "zzzznothing", relevant: ["c1"] }],
      viewer,
    );
    expect(report.zeroResults).toBe(1);
    expect(report.recallAtK).toBe(0);
  });

  it("prints the queries that found nothing — that list is the ingestion backlog", async () => {
    const report = await evaluate(
      [new StrictLexicalArm(corpus)],
      [{ query: "zzzznothing", relevant: ["c1"] }],
      viewer,
    );
    expect(formatReport(report)).toMatch(/found nothing:\n {2}zzzznothing/);
  });
});
