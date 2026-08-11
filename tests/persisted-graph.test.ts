import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_TENANT,
  type SeedResult,
  runEvaluationGate,
  seedEvaluationCorpus,
  toBaseline,
} from "../src/eval/corpus-gate.js";
import { DatabaseLinkSource } from "../src/links/store.js";
import { AuthorizedHitResolver } from "../src/retrieval/authorized-resolver.js";
import {
  GraphExpansionArm,
  InMemoryLinkSource,
} from "../src/retrieval/graph-arm.js";
import { IndexedLexicalArm } from "../src/retrieval/indexed-arm.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

const JUDGMENTS = 20;

let db: Database;
let seed: SeedResult;

beforeEach(async () => {
  db = await testDatabase();
  seed = await seedEvaluationCorpus(db);
}, 180_000);

afterEach(async () => {
  await db.close();
});

const lexical = () => new IndexedLexicalArm(db, { tenantId: EVAL_TENANT });

const persistedGraph = () =>
  new GraphExpansionArm(
    lexical(),
    new DatabaseLinkSource(db, EVAL_TENANT),
    new AuthorizedHitResolver(db, EVAL_TENANT),
  );

describe("persisted link store", () => {
  it("extracts links during ordinary ingestion", async () => {
    const result = await db.query<{ count: string }>(
      "SELECT count(*) AS count FROM resource_links WHERE tenant_id = $1",
      [EVAL_TENANT],
    );
    expect(Number(result.rows[0]?.count)).toBeGreaterThan(0);
  });

  it("walks persisted links bidirectionally", async () => {
    const source = new DatabaseLinkSource(db, EVAL_TENANT);
    const forward = await source.neighbours(["PAY-1"]);
    expect(forward.length).toBeGreaterThan(0);

    // Every neighbour reached from PAY-1 must reach PAY-1 back: direction
    // encodes semantics, not reachability.
    for (const link of forward) {
      const back = await source.neighbours([link.to]);
      expect(back.map((edge) => edge.to)).toContain("PAY-1");
    }
  });

  it("records provenance, so an inferred edge can never pass as source-authored", async () => {
    const result = await db.query<{ origin: string }>(
      "SELECT DISTINCT origin FROM resource_links WHERE tenant_id = $1",
      [EVAL_TENANT],
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const { origin } of result.rows) {
      expect(["source-explicit", "deterministic-extracted"]).toContain(origin);
    }
  });
});

describe("persisted graph expansion", () => {
  it("reproduces the recall the in-memory proof measured", async () => {
    // The proof used links handed over by the corpus generator. This uses links
    // the ingestion pipeline extracted for itself. If extraction misses edges,
    // the persisted capability is worth less than the proof claimed — which is
    // exactly the thing a baseline must not overstate.
    const fromCorpus = new GraphExpansionArm(
      lexical(),
      new InMemoryLinkSource(seed.corpus.links),
      new AuthorizedHitResolver(db, EVAL_TENANT),
    );

    const proof = await runEvaluationGate(db, seed, [lexical(), fromCorpus], {
      limit: JUDGMENTS,
    });
    const persisted = await runEvaluationGate(
      db,
      seed,
      [lexical(), persistedGraph()],
      { limit: JUDGMENTS },
    );

    console.log("corpus links:   ", JSON.stringify(toBaseline(proof)));
    console.log("persisted links:", JSON.stringify(toBaseline(persisted)));

    expect(persisted.recallAtK).toBeGreaterThanOrEqual(proof.recallAtK - 0.02);
  }, 600_000);

  it("beats lexical alone", async () => {
    const before = await runEvaluationGate(db, seed, [lexical()], {
      limit: JUDGMENTS,
    });
    const after = await runEvaluationGate(
      db,
      seed,
      [lexical(), persistedGraph()],
      { limit: JUDGMENTS },
    );
    expect(after.recallAtK).toBeGreaterThan(before.recallAtK);
  }, 600_000);

  it("does not bury the answer it already had", async () => {
    const before = await runEvaluationGate(db, seed, [lexical()], {
      limit: JUDGMENTS,
    });
    const after = await runEvaluationGate(
      db,
      seed,
      [lexical(), persistedGraph()],
      { limit: JUDGMENTS },
    );
    expect(after.mrr).toBeGreaterThanOrEqual(before.mrr - 0.02);
  }, 600_000);

  it("still refuses a neighbour the viewer may not see", async () => {
    // A link is reachability, never permission — and that must remain true now
    // that the edges come from the database rather than a fixture.
    const blind = {
      principal: "nobody",
      principals: [],
      containers: seed.containerIds,
    };
    expect(
      await persistedGraph().search(
        { text: "payment retries incident 1" },
        blind,
      ),
    ).toEqual([]);
  }, 300_000);
});
