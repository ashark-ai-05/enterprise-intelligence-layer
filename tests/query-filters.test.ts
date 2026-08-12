import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalGitConnector } from "../src/connectors/git-local.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { publishCoreGeneration } from "../src/publication/generations.js";
import {
  matchesFilters,
  parsePhrase,
  parseSearchFlags,
} from "../src/retrieval/query-filters.js";
import { createScope } from "../src/scopes/service.js";
import {
  assignResourceContainer,
  ensureContainer,
  replaceContainerAces,
} from "../src/security/acl.js";
import { searchCommand } from "../src/serving/cli-commands.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

const TENANT = "local";
let db: Database;

function makeRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), "eil-filters-"));
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

  // Contains the three words, but never adjacent and never in order.
  writeFileSync(
    join(dir, "docs", "scattered.md"),
    "# Notes\n\nThe policy team owns retry budgets. Payment volume is separate.\n",
  );
  // Contains the exact phrase.
  writeFileSync(
    join(dir, "docs", "exact.md"),
    "# Charging\n\nOur payment retry policy allows four attempts.\n",
  );
  writeFileSync(
    join(dir, "src", "charge.ts"),
    "export function chargeCard() { return 1; }\n",
  );

  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

beforeAll(async () => {
  db = await testDatabase();
  const repository = makeRepository();

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
}, 300_000);

afterAll(async () => {
  await db.close();
});

const hasPath = (ids: readonly string[], path: string) =>
  ids.some((id) => id.endsWith(`:${path}`));

describe("parsePhrase", () => {
  it("recognises a fully quoted query", () => {
    expect(parsePhrase('"payment retry policy"')).toEqual({
      phrase: "payment retry policy",
      text: "payment retry policy",
    });
  });

  it("leaves an unquoted query alone", () => {
    expect(parsePhrase("payment retry policy").phrase).toBeNull();
  });

  it("does not treat an inner quote as a phrase", () => {
    expect(parsePhrase('find the "retry" flag').phrase).toBeNull();
  });
});

describe("matchesFilters", () => {
  const hit = { id: "payments:src/charge.ts", source: "git" };

  it("passes everything when no filter is set", () => {
    expect(matchesFilters(hit, {})).toBe(true);
  });

  it("filters by source", () => {
    expect(matchesFilters(hit, { sources: ["git"] })).toBe(true);
    expect(matchesFilters(hit, { sources: ["jira"] })).toBe(false);
  });

  it("filters by id substring, case-insensitively", () => {
    expect(matchesFilters(hit, { path: "src/" })).toBe(true);
    expect(matchesFilters(hit, { path: "SRC/" })).toBe(true);
    expect(matchesFilters(hit, { path: "docs/" })).toBe(false);
  });
});

describe("parseSearchFlags", () => {
  it("defaults sensibly", () => {
    expect(parseSearchFlags([])).toEqual({ limit: 10, json: false });
  });

  it("parses sources, path, limit and json", () => {
    expect(
      parseSearchFlags([
        "--source",
        "git,jira",
        "--path",
        "src/",
        "--limit",
        "5",
        "--json",
      ]),
    ).toEqual({
      sources: ["git", "jira"],
      path: "src/",
      limit: 5,
      json: true,
    });
  });

  it("clamps a nonsensical limit rather than trusting it", () => {
    expect(parseSearchFlags(["--limit", "9999"]).limit).toBe(50);
    expect(parseSearchFlags(["--limit", "-3"]).limit).toBe(10);
    expect(parseSearchFlags(["--limit", "abc"]).limit).toBe(10);
  });
});

describe("quoted phrases are actually enforced", () => {
  it("matches only where the words are adjacent and in order", async () => {
    // Both documents contain payment, retry and policy. Only one has them
    // together. Before this, quoting was detected and then ignored, so both
    // came back and the quotes appeared to do nothing.
    const loose = (
      await searchCommand(db, TENANT, "payment retry policy")
    ).hits.map((hit) => hit.id);
    const exact = (
      await searchCommand(db, TENANT, '"payment retry policy"')
    ).hits.map((hit) => hit.id);

    expect(hasPath(loose, "docs/exact.md")).toBe(true);
    expect(hasPath(loose, "docs/scattered.md")).toBe(true);

    expect(hasPath(exact, "docs/exact.md")).toBe(true);
    expect(hasPath(exact, "docs/scattered.md")).toBe(false);
  }, 300_000);

  it("does not fuzz or prefix-expand a quoted phrase", async () => {
    // Quoting asks for precision; correcting its terms would do the opposite.
    const hits = (await searchCommand(db, TENANT, '"paymnt retry policy"'))
      .hits;
    expect(hits).toEqual([]);
  }, 300_000);
});

describe("filters narrow across sources", () => {
  it("restricts by path", async () => {
    const all = (await searchCommand(db, TENANT, "charge")).hits.map(
      (hit) => hit.id,
    );
    const scoped = (
      await searchCommand(db, TENANT, "charge", 10, { path: "src/" })
    ).hits.map((hit) => hit.id);
    expect(all.length).toBeGreaterThan(0);
    expect(scoped.every((id) => id.includes("src/"))).toBe(true);
  }, 300_000);

  it("restricts by source, and returns nothing for a source with no data", async () => {
    const git = (
      await searchCommand(db, TENANT, "charge", 10, { sources: ["git"] })
    ).hits;
    const jira = (
      await searchCommand(db, TENANT, "charge", 10, { sources: ["jira"] })
    ).hits;
    expect(git.length).toBeGreaterThan(0);
    expect(jira).toEqual([]);
  }, 300_000);
});
