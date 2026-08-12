import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalGitConnector } from "../src/connectors/git-local.js";
import { embedPendingChunks } from "../src/embeddings/backfill.js";
import { LocalWasmEmbedder } from "../src/embeddings/local-wasm.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { publishCoreGeneration } from "../src/publication/generations.js";
import {
  FuzzyLexicalArm,
  correctTerm,
  trigramSimilarity,
} from "../src/retrieval/fuzzy-arm.js";
import { IndexedLexicalArm } from "../src/retrieval/indexed-arm.js";
import { retrieve } from "../src/retrieval/pipeline.js";
import { SemanticArm, cosine } from "../src/retrieval/semantic-arm.js";
import type { RetrievalArm, Viewer } from "../src/retrieval/types.js";
import { createScope } from "../src/scopes/service.js";
import {
  assignResourceContainer,
  ensureContainer,
  replaceContainerAces,
} from "../src/security/acl.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

const TENANT = "local";
let db: Database;
let viewer: Viewer;
let embedder: LocalWasmEmbedder;

/**
 * A repository of genuinely distinguishable prose and code.
 *
 * The generated corpus templates every wiki page from one sentence, so no page
 * can be told apart from its peers and prose relevance is unmeasurable on it.
 * These documents each have their own vocabulary, which is what makes a
 * semantic or fuzzy result mean something.
 */
function makeRealisticRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), "eil-real-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      stdio: "pipe",
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@e.invalid");
  git("config", "user.name", "T");

  mkdirSync(join(dir, "docs"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });

  writeFileSync(
    join(dir, "docs", "payments.md"),
    "# Charging customers\n\nWhen a card is declined we wait, then attempt the charge again. " +
      "The delay doubles each time and a small random offset stops every client " +
      "reconnecting simultaneously. After the fourth attempt we give up and raise an alert.\n",
  );
  writeFileSync(
    join(dir, "docs", "onboarding.md"),
    "# Joining the team\n\nRequest laptop provisioning, then ask your manager for " +
      "directory group membership. Accounts are created within two working days.\n",
  );
  writeFileSync(
    join(dir, "docs", "storage.md"),
    "# Where records live\n\nCatalogue rows are held in Postgres. Large binary " +
      "attachments go to object storage and are referenced by digest.\n",
  );
  writeFileSync(
    join(dir, "src", "charge.ts"),
    "export function attemptCharge(tries: number): string {\n" +
      '  return tries > 4 ? "abandoned" : "again";\n}\n',
  );

  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

beforeAll(async () => {
  db = await testDatabase();
  embedder = new LocalWasmEmbedder();

  const repository = makeRealisticRepository();
  const scope = await createScope(db, {
    tenantId: TENANT,
    source: "git",
    selectorKind: "repositories",
    selector: { repositories: [repository], refs: ["main"] },
    refreshMode: "manual",
    addedBy: "test",
  });
  await ingestScope(db, TENANT, scope.id, new LocalGitConnector());

  const container = await ensureContainer(
    db,
    TENANT,
    "git",
    "local-git",
    "Local",
  );
  await replaceContainerAces(db, TENANT, container, [
    { domain: "local", principalId: "owner", effect: "allow" },
  ]);
  const resources = await db.query<{ id: string }>(
    "SELECT id FROM resources WHERE tenant_id = $1 AND deleted_at IS NULL",
    [TENANT],
  );
  for (const { id } of resources.rows) {
    await assignResourceContainer(db, TENANT, id, container);
    await publishCoreGeneration(db, TENANT, id);
  }

  await embedPendingChunks(db, embedder);

  viewer = {
    principal: "local",
    principals: ["local:owner"],
    containers: [container],
  };
}, 600_000);

afterAll(async () => {
  await db.close();
});

const lexical = () => new IndexedLexicalArm(db, { tenantId: TENANT });
const fuzzy = () => new FuzzyLexicalArm(db, { tenantId: TENANT });
const semantic = () => new SemanticArm(db, embedder, { tenantId: TENANT });

/** Ids are `<repo>:<path>`; tests care about the path. */
function hasPath(ids: readonly string[], path: string): boolean {
  return ids.some((id) => id.endsWith(`:${path}`));
}

async function idsFor(arms: RetrievalArm[], text: string): Promise<string[]> {
  const result = await retrieve(arms, { text, limit: 10 }, viewer, {
    limit: 10,
    maxPerSource: 10,
    maxPerContainer: 10,
  });
  return result.hits.map((hit) => hit.id);
}

describe("trigram similarity", () => {
  it("scores identical words 1 and unrelated words near 0", () => {
    expect(trigramSimilarity("retry", "retry")).toBe(1);
    expect(trigramSimilarity("retry", "onboarding")).toBeLessThan(0.1);
  });

  it("scores a single-character typo highly", () => {
    expect(trigramSimilarity("retrry", "retry")).toBeGreaterThan(0.25);
    // A transposition scores lowest of the common typo classes, and still
    // clears the threshold by a wide margin over unrelated words.
    expect(trigramSimilarity("postgers", "postgres")).toBeGreaterThan(0.25);
    expect(trigramSimilarity("charge", "storage")).toBeLessThan(0.1);
  });
});

describe("correctTerm", () => {
  const vocabulary = ["postgres", "provisioning", "attempt", "declined"];

  it("corrects a misspelling to the corpus term", () => {
    expect(correctTerm("postgers", vocabulary, 0.25, 3)[0]?.corrected).toBe(
      "postgres",
    );
  });

  it("leaves a term that already exists alone", () => {
    // Correcting a word that is present would turn a precise query into a
    // fuzzy one.
    expect(correctTerm("postgres", vocabulary, 0.25, 3)).toEqual([]);
  });

  it("offers nothing for a word with no near neighbour", () => {
    expect(correctTerm("zzzzquux", vocabulary, 0.25, 3)).toEqual([]);
  });
});

describe("cosine", () => {
  it("is 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
});

describe("partial words", () => {
  it("finds a document from a prefix that no exact search would match", async () => {
    // "provis" is not a word in any document; "provisioning" is.
    expect(await idsFor([lexical()], "provis")).toEqual([]);
    expect(
      hasPath(await idsFor([fuzzy()], "provis"), "docs/onboarding.md"),
    ).toBe(true);
  }, 120_000);
});

describe("misspelt words", () => {
  it("finds a document despite a typo the exact arm cannot match", async () => {
    expect(await idsFor([lexical()], "postgers")).toEqual([]);
    expect(
      hasPath(await idsFor([fuzzy()], "postgers"), "docs/storage.md"),
    ).toBe(true);
  }, 120_000);

  it("still finds the right document when the query is spelt correctly", async () => {
    expect(
      hasPath(await idsFor([fuzzy()], "postgres"), "docs/storage.md"),
    ).toBe(true);
  }, 120_000);
});

describe("semantic retrieval", () => {
  it("finds a document that shares no words with the query", async () => {
    // The payments document never says "retry", "backoff" or "jitter" — it says
    // "attempt the charge again", "the delay doubles", "a small random offset".
    // This is precisely the case lexical retrieval cannot serve.
    const query = "retry backoff jitter";
    const lexicalIds = await idsFor([lexical()], query);
    const semanticIds = await idsFor([semantic()], query);

    console.log("lexical :", JSON.stringify(lexicalIds));
    console.log("semantic:", JSON.stringify(semanticIds));

    expect(hasPath(lexicalIds, "docs/payments.md")).toBe(false);
    expect(hasPath(semanticIds, "docs/payments.md")).toBe(true);
  }, 300_000);

  it("reports itself unavailable when nothing has been embedded", async () => {
    // Otherwise every query pays for an embedding and returns nothing, which
    // reads as "semantic search is broken" rather than "nothing is embedded".
    const empty = await testDatabase();
    const arm = new SemanticArm(empty, embedder, { tenantId: TENANT });
    expect(await arm.search({ text: "anything" }, viewer)).toEqual([]);
    expect(arm.isAvailable()).toBe(false);
    await empty.close();
  }, 300_000);

  it("never returns a chunk the viewer cannot see", async () => {
    const blind: Viewer = {
      principal: "nobody",
      principals: [],
      containers: viewer.containers,
    };
    expect(
      await semantic().search({ text: "charging customers" }, blind),
    ).toEqual([]);
  }, 120_000);
});

describe("all arms together", () => {
  it("answers a natural-language question no exact arm can", async () => {
    const ids = await idsFor(
      [lexical(), fuzzy(), semantic()],
      "how do we handle failed card payments",
    );
    console.log("fused:", JSON.stringify(ids));
    expect(hasPath(ids, "docs/payments.md")).toBe(true);
  }, 300_000);

  it("does not let fuzzy or semantic displace an exact match", async () => {
    // "attemptCharge" is an exact identifier in one file. Adding recall-oriented
    // arms must not push it off the top.
    const exact = await idsFor([lexical()], "attemptCharge");
    const all = await idsFor([lexical(), fuzzy(), semantic()], "attemptCharge");
    expect(exact[0]).toMatch(/:src\/charge\.ts$/);
    expect(all[0]).toMatch(/:src\/charge\.ts$/);
  }, 300_000);
});
