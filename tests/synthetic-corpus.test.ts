import { describe, expect, it } from "vitest";
import {
  generateSyntheticCorpus,
  syntheticCorpusCounts,
  syntheticCorpusPresets,
} from "../src/corpus/synthetic.js";

describe("synthetic enterprise corpus", () => {
  it("is deterministic and sizeable at the CI preset", () => {
    const first = generateSyntheticCorpus(syntheticCorpusPresets.ci);
    const second = generateSyntheticCorpus(syntheticCorpusPresets.ci);
    expect(first).toEqual(second);
    expect(syntheticCorpusCounts(first)).toEqual({
      confluenceEvents: 61,
      jiraEvents: 102,
      gitEvents: 154,
      links: 200,
      // 100 issues x three families (exact_lookup, subject_search,
      // relationship_navigation), plus 20 unanswerable cases whose truth is
      // absence, plus 3 denied cases -- one per restricted page, and the ci
      // preset has 60 pages with every 20th restricted.
      relevanceJudgments: 323,
      aclCases: 2,
    });
  });

  it("creates cross-source links whose endpoints exist", () => {
    const corpus = generateSyntheticCorpus(syntheticCorpusPresets.ci);
    const ids = new Set(
      Object.values(corpus.events)
        .flat()
        .map(({ item }) => item.sourceObjectId),
    );
    for (const link of corpus.links) {
      expect(ids.has(link.from)).toBe(true);
      expect(ids.has(link.to)).toBe(true);
    }
    for (const judgment of corpus.relevance) {
      expect(judgment.relevantSourceObjectIds.every((id) => ids.has(id))).toBe(
        true,
      );
    }
  });

  it("includes resource and chunk permission adversarial cases", () => {
    const corpus = generateSyntheticCorpus(syntheticCorpusPresets.ci);
    expect(corpus.aclCases.map(({ level }) => level).sort()).toEqual([
      "chunk",
      "resource",
    ]);
    const restrictedPage = corpus.events.confluence.find(
      ({ item }) => item.sourceObjectId === "CONF-1",
    );
    const restrictedIssue = corpus.events.jira.find(
      ({ item }) => item.sourceObjectId === "PAY-1",
    );
    expect(restrictedPage?.item.acl).toHaveLength(1);
    expect(restrictedIssue?.item.metadata.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          visibility: {
            domain: "jira-role",
            principalId: "service-desk-internal",
          },
        }),
      ]),
    );
  });

  it("generates the large preset without storing a checked-in data dump", () => {
    const corpus = generateSyntheticCorpus(syntheticCorpusPresets.stress);
    const counts = syntheticCorpusCounts(corpus);
    expect(counts.confluenceEvents).toBeGreaterThan(1_000);
    expect(counts.jiraEvents).toBeGreaterThan(2_000);
    expect(counts.gitEvents).toBeGreaterThan(2_000);
    expect(counts.links).toBe(4_000);
  });

  it("rejects invalid sizes", () => {
    expect(() =>
      generateSyntheticCorpus({
        ...syntheticCorpusPresets.ci,
        jiraIssues: 0,
      }),
    ).toThrow("jiraIssues must be a positive integer");
  });
});
