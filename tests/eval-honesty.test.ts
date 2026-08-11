import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EVAL_TENANT,
  type SeedResult,
  defaultArms,
  evalViewer,
  seedEvaluationCorpus,
  toBaseline,
} from "../src/eval/corpus-gate.js";
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

describe("the generated judgments are link-derived, and that limits what they prove", () => {
  it("relevant sets are exactly the lexical match plus its graph neighbours", () => {
    // Not a criticism of the corpus — it is a faithful capability fixture. But
    // it means recall on it is close to a tautology for graph expansion, and
    // the headline number should be read that way.
    const links = new Map<string, Set<string>>();
    for (const link of seed.corpus.links) {
      const forward = links.get(link.from) ?? new Set<string>();
      forward.add(link.to);
      links.set(link.from, forward);
    }

    let circular = 0;
    for (const judgment of seed.corpus.relevance.slice(0, 20)) {
      const [seedId, ...rest] = judgment.relevantSourceObjectIds;
      const neighbours = links.get(seedId ?? "") ?? new Set<string>();
      if (rest.every((id) => neighbours.has(id))) circular += 1;
    }

    expect(circular).toBe(20);
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
