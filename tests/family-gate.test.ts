/**
 * The per-family gate.
 *
 * Replaces a single pooled retrieval number, which could not adjudicate the
 * three different intents it was averaging: an exact identifier lookup, a
 * subject search and a graph traversal scored against one flat relevant list.
 * A scorer right about one is necessarily wrong about another, so the aggregate
 * moved for reasons nobody could attribute.
 *
 * Every family is asserted separately and **no pooled headline metric is
 * produced**. Two families are currently *failing capabilities* and are asserted
 * as such: recording a known-absent capability as a passing test would be the
 * same mistake in a different costume.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syntheticCorpusPresets } from "../src/corpus/synthetic.js";
import {
  type SeedResult,
  runFamilyEvaluation,
  runNavigationEvaluation,
  seedEvaluationCorpus,
} from "../src/eval/corpus-gate.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

let db: Database;
let seed: SeedResult;

beforeAll(async () => {
  db = await testDatabase();
  seed = await seedEvaluationCorpus(db, syntheticCorpusPresets.ci);
}, 180_000);

afterAll(async () => {
  await db.close();
});

/** ci preset, default arms (lexical-strict + graph-expand), k = 10, limit 20. */
const CONFIG = { limit: 20 } as const;

describe("exact_lookup — a confirmed absent capability", () => {
  it("scores zero, and that is recorded as a failure rather than a baseline", async () => {
    const report = await runFamilyEvaluation(db, seed, undefined, {
      ...CONFIG,
      family: "exact_lookup",
    });

    // `classify()` extracts `literal` for an issue key and nothing consumes it,
    // so there is no identifier resolution path; the query falls through to
    // token search. Chunk text also comes from body, section text and comment
    // body -- never title -- so the key is structurally absent from the index.
    //
    // This assertion exists to fail loudly the moment someone implements it.
    // If it starts failing, delete it and write a real threshold.
    expect(report.recallAtK).toBe(0);
    expect(report.queries).toBe(20);
  }, 600_000);
});

describe("subject_search — the production baseline", () => {
  it("holds the recorded ci baseline, with denominators disclosed", async () => {
    const report = await runFamilyEvaluation(db, seed, undefined, {
      ...CONFIG,
      family: "subject_search",
    });

    // ci preset, 310 documents, 31 subjects, 20 of 31 judgments scored,
    // default arms, k = 10, diversity caps disabled. Re-record deliberately
    // when the corpus or arms change; never widen to accommodate a regression.
    expect(report.queries).toBe(20);
    expect(report.recallAtK).toBeGreaterThanOrEqual(0.7);
    expect(report.mrr).toBeGreaterThanOrEqual(0.8);
  }, 600_000);
});

describe("relationship_navigation — works, but nothing exposes it", () => {
  it("reaches every visible neighbour and leaks none, via the anchor path", async () => {
    // Scored through the link source and ACL resolver directly, because
    // scoring it through ordinary search measures whether search can find the
    // anchor -- which it cannot, exact lookup being absent.
    //
    // No MCP tool or CLI verb exposes this. The capability is sound; the
    // product surface is the gap.
    const nav = await runNavigationEvaluation(db, seed, CONFIG);
    expect(nav.coverage).toBe(1);
    expect(nav.complete).toBe(nav.anchors);
    expect(nav.spurious).toBe(0);
    expect(nav.leaked).toBe(0);
  }, 600_000);
});

describe("unanswerable — retrieval-level abstention is absent", () => {
  it("answers every query that has no answer, reported as its own metric", async () => {
    const report = await runFamilyEvaluation(db, seed, undefined, {
      ...CONFIG,
      family: "unanswerable",
    });

    // Ranking metrics are omitted for empty truth rather than reported as
    // perfect: recallAt and ndcgAt both return 1 for an empty relevant set,
    // which is conventional and operationally a hardcoded pass.
    expect(report.recallAtK).toBeUndefined();
    expect(report.ndcgAtK).toBeUndefined();

    // Retrieval returns candidates for all of them. This measures the
    // retriever only -- an agent's willingness to assert a false answer is a
    // separate question this harness does not test.
    expect(report.retrievalAnsweredRate).toBe(1);
  }, 600_000);
});

describe("denied — the boundary that holds", () => {
  it("returns authorized alternatives and never the protected document", async () => {
    const report = await runFamilyEvaluation(db, seed, undefined, {
      ...CONFIG,
      family: "denied",
    });

    // n = 3 at the ci preset, not 20: only every 20th page is restricted and
    // ci has 60. Disclosed rather than left to be discovered -- this row is
    // not comparable to the others.
    expect(report.queries).toBe(3);
    expect(report.leakedQueries).toBe(0);
    expect(report.leakedObjects).toBe(0);
  }, 600_000);
});
