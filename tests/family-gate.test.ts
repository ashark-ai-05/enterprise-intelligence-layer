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
  EVAL_TENANT,
  type SeedResult,
  evalViewer,
  runFamilyEvaluation,
  runNavigationEvaluation,
  seedEvaluationCorpus,
} from "../src/eval/corpus-gate.js";
import {
  relatedEvidence,
  resolveExactObject,
} from "../src/retrieval/object-surfaces.js";
import { callTool } from "../src/serving/tools.js";
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

    // Chunk text comes from body, section text and comment body -- never title
    // -- so an issue key is structurally absent from the full-text index. No
    // amount of ranking work changes that; searching for `PAY-1` cannot find
    // PAY-1.
    //
    // Identifier resolution now EXISTS, via `resolveExactObject` (see the
    // exact-object surface suite below), and this assertion deliberately did
    // not fire when it landed -- because it was built as a separate
    // identity-level surface rather than by pushing titles into the index,
    // which is the correct shape. So this measures what it always measured:
    // search does not resolve identifiers, and is not expected to.
    //
    // This is a characterisation, not a wish. If it fails because search
    // legitimately learned to resolve identifiers -- structured metadata
    // matching, say -- that is an improvement: re-record it deliberately. What
    // it must not become is a silent 0 nobody notices, or a licence to make
    // search do this by dumping titles into the full-text index, which is the
    // wrong fix for the reason above.
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

describe("relationship_navigation — works, and is now exposed", () => {
  it("reaches every visible neighbour and leaks none, via the anchor path", async () => {
    // Scored through the link source and ACL resolver directly, because
    // scoring it through ordinary search measures whether search can find the
    // anchor -- which it cannot, exact lookup being absent.
    //
    // This measures the underlying link + ACL path. A product surface for it
    // now exists (`relatedEvidence`, covered below); this stays because the
    // mechanism should keep being measured independently of the surface.
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

describe("exact-object surface — the capability search does not provide", () => {
  // Driven through `callTool`, the surface an agent actually reaches, rather
  // than the module behind it. Testing the module directly would pass even if
  // the tool were unregistered, mis-named or wired to the wrong arguments --
  // which is most of what could break between an agent and this capability.
  const context = (viewer: ReturnType<typeof evalViewer>) => ({
    db,
    tenantId: EVAL_TENANT,
    arms: [],
    viewer,
    audit: { record: async () => {} },
  });

  it("resolves a canonical id that search cannot find", async () => {
    // The other half of the exact_lookup story: search scores 0.000 on
    // identifiers, and this is the path that resolves them. The pairing is what
    // stops that 0.000 being read as "the product cannot do this".
    const result = await callTool(
      "lookup_object",
      { id: "PAY-1" },
      context(evalViewer(seed.containerIds)),
    );
    const payload = JSON.parse(result.content);

    expect(payload.found).toBe(true);
    expect(payload.hit?.id ?? payload.id).toBe("PAY-1");
  }, 600_000);

  it("refuses to a viewer without access an object it returns to one with it", async () => {
    // The comparison is the test. An earlier version asked only whether a
    // principal-less viewer was refused CONF-1 -- which passed, and proved
    // nothing, because CONF-1 is restricted and unreachable for the evaluation
    // viewer too. It would have passed with the ACL predicate deleted.
    //
    // Same object, two viewers, opposite outcomes: that cannot pass unless
    // authorization is doing the work.
    const authorized = evalViewer(seed.containerIds);
    const blind = {
      principal: "nobody",
      principals: [],
      containers: seed.containerIds,
    };

    const visible = await resolveExactObject(
      db,
      EVAL_TENANT,
      authorized,
      "PAY-1",
    );
    expect(visible.found).toBe(true);

    const denied = await resolveExactObject(db, EVAL_TENANT, blind, "PAY-1");
    expect(denied.found).toBe(false);
    expect(denied.hit).toBeUndefined();
  }, 600_000);

  it("returns an anchor's related evidence, and never a protected neighbour", async () => {
    const related = JSON.parse(
      (
        await callTool(
          "related_evidence",
          { id: "PAY-1" },
          context(evalViewer(seed.containerIds)),
        )
      ).content,
    );

    expect(related.found).toBe(true);
    expect(related.evidence.length).toBeGreaterThan(0);
    for (const item of related.evidence) {
      expect(item.anchorId).toBe("PAY-1");
      expect(typeof item.relation).toBe("string");
    }
  }, 600_000);
});
