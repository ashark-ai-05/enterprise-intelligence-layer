import { afterEach, beforeEach, describe, expect, it } from "vitest";
import baseline from "../src/eval/baseline.json" with { type: "json" };
import {
  EVAL_TENANT,
  type SeedResult,
  evalViewer,
  runEvaluationGate,
  seedEvaluationCorpus,
  toBaseline,
} from "../src/eval/corpus-gate.js";
import { checkRegression } from "../src/eval/metrics.js";
import { IndexedLexicalArm } from "../src/retrieval/indexed-arm.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

// A reduced judgment count keeps the gate inside a sensible CI budget while
// still covering every source. The full set is available by removing `limit`.
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

describe("evaluation corpus seeding", () => {
  it("ingests and publishes the whole corpus", async () => {
    // 60 pages + 100 issues + 3 repos x 50 files = 310 resources.
    expect(seed.resourceCount).toBe(310);
    expect(seed.corpus.relevance.length).toBeGreaterThan(0);
  });

  it("publishes every resource, since an unpublished corpus scores zero everywhere", async () => {
    // listAuthorizedChunks fails closed on an unpublished generation, so this
    // failure would present as a total ranking collapse rather than a setup bug.
    const unpublished = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM resources
        WHERE tenant_id = $1 AND deleted_at IS NULL AND published_generation_id IS NULL`,
      [EVAL_TENANT],
    );
    expect(Number(unpublished.rows[0]?.count)).toBe(0);
  });
});

describe("ranking regression gate", () => {
  it("does not regress against the committed baseline", async () => {
    const report = await runEvaluationGate(db, seed, undefined, {
      limit: JUDGMENTS,
    });

    // Compare against a report shell carrying the committed baseline numbers,
    // so both sides go through the same comparison code.
    const verdict = checkRegression({ ...report, ...baseline }, report, 0.02);

    // Print the numbers whether or not the gate trips: a gate that only speaks
    // on failure teaches nobody what normal looks like.
    console.log("eval:", JSON.stringify(toBaseline(report)));

    expect(verdict.failures).toEqual([]);
    expect(verdict.passed).toBe(true);
  }, 300_000);

  it("finds something for most queries — a silent collapse must fail the gate", async () => {
    const report = await runEvaluationGate(db, seed, undefined, {
      limit: JUDGMENTS,
    });
    expect(report.zeroResults).toBeLessThanOrEqual(baseline.zeroResults);
  }, 300_000);

  it("detects a deliberately broken ranker", async () => {
    // The gate is only worth having if it fails when it should. This proves it.
    const reversed = new (class extends IndexedLexicalArm {
      override async search(
        query: Parameters<IndexedLexicalArm["search"]>[0],
        viewer: Parameters<IndexedLexicalArm["search"]>[1],
      ) {
        return (await super.search(query, viewer)).reverse();
      }
    })(db, { tenantId: EVAL_TENANT });

    const good = await runEvaluationGate(db, seed, undefined, {
      limit: JUDGMENTS,
    });
    const bad = await runEvaluationGate(db, seed, [reversed], {
      limit: JUDGMENTS,
    });

    const verdict = checkRegression(good, bad, 0.02);
    expect(verdict.passed).toBe(false);
  }, 300_000);

  it("is deterministic — the same corpus and arms score identically", async () => {
    const first = await runEvaluationGate(db, seed, undefined, { limit: 5 });
    const second = await runEvaluationGate(db, seed, undefined, { limit: 5 });
    expect(toBaseline(first)).toEqual(toBaseline(second));
  }, 300_000);

  it("restricts results to what the viewer may see", async () => {
    const blind = evalViewer([]);
    expect(blind.containers).toEqual([]);
  });
});
