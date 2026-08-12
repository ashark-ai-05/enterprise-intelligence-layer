import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EVAL_TENANT,
  type SeedResult,
  defaultArms,
  evalViewer,
  seedEvaluationCorpus,
  toBaseline,
} from "../src/eval/corpus-gate.js";
import {
  subjectMembers,
  syntheticCorpusPresets,
} from "../src/corpus/synthetic.js";
import { deriveIndependentJudgments } from "../src/eval/independent-judgments.js";
import { score } from "../src/eval/metrics.js";
import { IndexedLexicalArm } from "../src/retrieval/indexed-arm.js";
import { retrieve } from "../src/retrieval/pipeline.js";
import type { RetrievalArm } from "../src/retrieval/types.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

let db: Database;
let seed: SeedResult;

beforeAll(async () => {
  db = await testDatabase();
  seed = await seedEvaluationCorpus(db);
}, 180_000);

afterAll(async () => {
  await db.close();
});

async function scoreJudgments(
  arms: readonly RetrievalArm[],
  pairs: Awaited<ReturnType<typeof deriveIndependentJudgments>>,
) {
  const viewer = evalViewer(seed.containerIds);
  const results = [];
  for (const pair of pairs) {
    const result = await retrieve(
      arms,
      { text: pair.query, limit: 10 },
      viewer,
      {
        limit: 10,
        maxPerSource: 10,
        maxPerContainer: 10,
      },
    );
    results.push({
      query: pair.query,
      retrieved: result.hits.map((hit) => hit.id),
      relevant: pair.relevant,
    });
  }
  return score(results, 10);
}

describe("judgment truth is derived independently of the capability it tests", () => {
  // This suite used to assert the opposite: that every relevant set was a seed
  // plus its graph neighbours, so recall was close to a tautology for graph
  // expansion. That was true and it was the defect — one query carried three
  // intents and the aggregate could not attribute a change to any of them.
  // The families now separate them, and these are the guards that keep them
  // separated.

  // Built at test time, not describe time: `seed` is populated in beforeAll.
  const forwardLinks = (): Map<string, Set<string>> => {
    const links = new Map<string, Set<string>>();
    for (const link of seed.corpus.links) {
      const forward = links.get(link.from) ?? new Set<string>();
      forward.add(link.to);
      links.set(link.from, forward);
    }
    return links;
  };

  it("subject_search truth is independent of planLinks, not merely of the query", () => {
    // The earlier version of this guard only checked the query carried no
    // identifier, which does not establish anything about the truth. The truth
    // was in fact [issue, pageFor(issue), codeFor(issue)] -- selected by the
    // same planLinks() that builds the graph edges, so it stayed circular.
    //
    // This asserts the real property: subject truth equals subjectMembers(),
    // which consults only each object's own key, and therefore cannot change
    // when link planning changes.
    const subject = seed.corpus.relevance
      .filter((judgment) => judgment.family === "subject_search")
      .slice(0, 20);
    expect(subject.length).toBeGreaterThan(0);

    for (const judgment of subject) {
      expect(judgment.query).not.toMatch(/PAY-|CONF-|module-/);
      expect([...judgment.relevantSourceObjectIds].sort()).toEqual(
        [...subjectMembers(syntheticCorpusPresets.ci, judgment.query)].sort(),
      );
    }
  });

  it("denied truth names a forbidden object, not an empty answer", () => {
    const denied = seed.corpus.relevance.filter(
      (judgment) => judgment.family === "denied",
    );
    expect(denied.length).toBeGreaterThan(0);
    for (const judgment of denied) {
      // An answer exists; it is simply not this viewer's. Leakage is the
      // metric, so a forbidden object must be named and authorized
      // alternatives must remain available.
      expect(judgment.forbidden?.length ?? 0).toBeGreaterThan(0);
      expect(judgment.relevantSourceObjectIds.length).toBeGreaterThan(0);
      for (const id of judgment.forbidden ?? []) {
        expect(judgment.relevantSourceObjectIds).not.toContain(id);
      }
    }
  });

  it("relationship_navigation truth IS the link graph, deliberately and only there", () => {
    const navigation = seed.corpus.relevance
      .filter((judgment) => judgment.family === "relationship_navigation")
      .slice(0, 20);
    expect(navigation.length).toBeGreaterThan(0);

    for (const judgment of navigation) {
      const neighbours = forwardLinks().get(judgment.anchor ?? "") ?? new Set<string>();
      // Legitimate here: reaching an anchor's neighbours is the task being
      // scored, not a stand-in for content relevance.
      expect(judgment.relevantSourceObjectIds.length).toBeGreaterThan(0);
      for (const id of judgment.relevantSourceObjectIds) {
        expect(neighbours.has(id)).toBe(true);
      }
    }
  });

  it("unanswerable absence is proven against the documents, not just labelled", () => {
    // Asserting `relevantSourceObjectIds: []` only checks the label agrees with
    // itself. This checks the corpus: no generated document anywhere carries
    // the constructed subject, so the empty truth is a fact about the estate
    // rather than a claim about the fixture.
    const unanswerable = seed.corpus.relevance.filter(
      (judgment) => judgment.family === "unanswerable",
    );
    expect(unanswerable.length).toBeGreaterThan(0);

    const documents = [
      ...seed.corpus.events.confluence,
      ...seed.corpus.events.jira,
      ...seed.corpus.events.git,
    ].map((event) => JSON.stringify(event.item));

    for (const judgment of unanswerable) {
      expect(judgment.relevantSourceObjectIds).toEqual([]);
      const subject = judgment.query.replace(" rollback procedure", "");
      expect(documents.some((text) => text.includes(subject))).toBe(false);
    }
  });

  it("every (family, query) pair is unique, so no subject is silently overweighted", () => {
    // subject_search was previously emitted once per Jira issue. Many issues
    // hash to the same subject, so identical query/truth pairs repeated and
    // each subject's weight became a property of the hash rather than of
    // retrieval.
    const seen = new Set<string>();
    for (const judgment of seed.corpus.relevance) {
      const key = `${judgment.family}\u0000${judgment.query}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("relationship truth excludes protected neighbours, which move to forbidden", () => {
    // Same defect class as the subject_search leak, in planLinks() rather than
    // subjectMembers(): the link plan picks pages without an ACL filter, so a
    // restricted page could be labelled a relevant neighbour. The edge is kept
    // — real estates link incidents to protected postmortems — but the
    // protected neighbour is never "relevant", or a fail-closed system could
    // not score perfectly and the benchmark would reward leaking it.
    const navigation = seed.corpus.relevance.filter(
      (judgment) => judgment.family === "relationship_navigation",
    );
    const withProtected = navigation.filter(
      (judgment) => (judgment.forbidden ?? []).length > 0,
    );
    expect(withProtected.length).toBeGreaterThan(0);

    for (const judgment of navigation) {
      for (const id of judgment.forbidden ?? []) {
        expect(judgment.relevantSourceObjectIds).not.toContain(id);
      }
    }
  });

  it("navigation truth accounts for every neighbour, not just the ones it names", () => {
    // Soundness was already guarded: every relevant item is a real neighbour.
    // This is completeness, which is the half that can fail silently. If a
    // fixture omitted an edge from *both* relevant and forbidden, the harness
    // would still report coverage 1.000 — `expected` would simply be smaller.
    // The spurious count catches an omitted *visible* neighbour, but never an
    // omitted *protected* one, because the resolver correctly filters it out
    // before the harness ever sees it.
    const neighboursOf = new Map<string, Set<string>>();
    for (const link of seed.corpus.links) {
      const forward = neighboursOf.get(link.from) ?? new Set<string>();
      forward.add(link.to);
      neighboursOf.set(link.from, forward);
    }

    const navigation = seed.corpus.relevance.filter(
      (judgment) => judgment.family === "relationship_navigation",
    );
    expect(navigation.length).toBeGreaterThan(0);

    for (const judgment of navigation) {
      expect(judgment.anchor).toBeDefined();
      const anchor = judgment.anchor as string;
      const expected = [...(neighboursOf.get(anchor) ?? new Set<string>())].sort();
      const accounted = [
        ...judgment.relevantSourceObjectIds,
        ...(judgment.forbidden ?? []),
      ].sort();

      // relevant union forbidden == the anchor's complete neighbour set
      expect(accounted).toEqual(expected);
      // ...and the two never overlap
      for (const id of judgment.forbidden ?? []) {
        expect(judgment.relevantSourceObjectIds).not.toContain(id);
      }
    }
  });

  it("no family ever labels a forbidden object relevant", () => {
    // A document the viewer may not see must never be labelled relevant:
    // perfect recall would then be unreachable for a correctly fail-closed
    // system, and the benchmark would be rewarding leakage.
    const forbidden = new Set(
      seed.corpus.relevance.flatMap((judgment) => judgment.forbidden ?? []),
    );
    expect(forbidden.size).toBeGreaterThan(0);
    // Every family, not just subject_search — the same leak appeared twice in
    // two different functions, so the guard is written once against all of
    // them rather than per family.
    for (const judgment of seed.corpus.relevance) {
      for (const id of judgment.relevantSourceObjectIds) {
        expect(forbidden.has(id)).toBe(false);
      }
    }
  });
});

describe("independent judgments — one target, no link to walk", () => {
  it("keeps only judgments whose query actually discriminates", async () => {
    // Without this filter the derivation produced unanswerable queries: every
    // generated wiki page shares the sentence "uses bounded retries and
    // observable failure modes", so a query built from it matches sixty
    // documents while the judgment names one. Scoring that measures which
    // arbitrary document sorted first — and it *looks* like a retrieval result.
    const pairs = await deriveIndependentJudgments(db, EVAL_TENANT, {
      perSource: 10,
    });
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) expect(pair.relevant).toHaveLength(1);
  }, 120_000);

  it("shows the corpus cannot measure prose relevance at all", async () => {
    // The finding that matters more than any score here: not one Confluence
    // page yields a discriminating query, because their bodies are templated
    // and differ only by a topic word that lives in the title. The corpus is a
    // good capability, ACL and pipeline fixture; it is not a relevance fixture.
    //
    // When the generator gains distinguishable prose this assertion fails, and
    // it should — that is the signal that prose relevance became measurable.
    const pairs = await deriveIndependentJudgments(db, EVAL_TENANT, {
      perSource: 10,
    });
    const confluence = pairs.filter((pair) =>
      pair.relevant[0]?.startsWith("CONF"),
    );
    const code = pairs.filter((pair) => pair.relevant[0]?.includes("service-"));

    expect(confluence).toHaveLength(0);
    expect(code.length).toBeGreaterThan(0);
  }, 120_000);

  it("measures retrieval where graph expansion has nothing to contribute", async () => {
    const pairs = await deriveIndependentJudgments(db, EVAL_TENANT, {
      perSource: 10,
    });

    const lexicalOnly = await scoreJudgments(
      [new IndexedLexicalArm(db, { tenantId: EVAL_TENANT })],
      pairs,
    );
    const full = await scoreJudgments(defaultArms(db), pairs);

    console.log(
      "independent, lexical only:",
      JSON.stringify(toBaseline(lexicalOnly)),
    );
    console.log("independent, all arms:   ", JSON.stringify(toBaseline(full)));
    console.log("judgments:", pairs.length);

    // These are unique symbol names, so a perfect score is expected and is a
    // narrow claim: identifier search works. It is not evidence about prose.
    expect(full.recallAtK).toBe(1);
  }, 600_000);

  it("adding graph expansion does not displace a directly-matched target", async () => {
    // Expansion is corroborating evidence and is weighted below every
    // direct-match arm for exactly this reason: RRF consumes rank, so an
    // unweighted expansion arm lets a rank-1 neighbour outrank a rank-5 text
    // match. This is the guard on that.
    const pairs = await deriveIndependentJudgments(db, EVAL_TENANT, {
      perSource: 10,
    });
    const lexicalOnly = await scoreJudgments(
      [new IndexedLexicalArm(db, { tenantId: EVAL_TENANT })],
      pairs,
    );
    const full = await scoreJudgments(defaultArms(db), pairs);

    expect(full.recallAtK).toBeGreaterThanOrEqual(lexicalOnly.recallAtK);
    expect(full.mrr).toBeGreaterThanOrEqual(lexicalOnly.mrr - 0.02);
  }, 600_000);
});
