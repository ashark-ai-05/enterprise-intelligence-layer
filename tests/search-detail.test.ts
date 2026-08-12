import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalGitConnector } from "../src/connectors/git-local.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { publishCoreGeneration } from "../src/publication/generations.js";
import { decorateHits, resourceDetails } from "../src/retrieval/decorate.js";
import { createScope } from "../src/scopes/service.js";
import {
  assignResourceContainer,
  ensureContainer,
  replaceContainerAces,
} from "../src/security/acl.js";
import {
  localArms,
  localViewer,
  searchCommand,
} from "../src/serving/cli-commands.js";
import {
  InMemoryAuditSink,
  type ToolContext,
  callTool,
} from "../src/serving/tools.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

const TENANT = "local";
let db: Database;
let repository: string;

function makeRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), "eil-detail-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      stdio: "pipe",
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@e.invalid");
  git("config", "user.name", "T");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(
    join(dir, "docs", "payments.md"),
    "# Charging customers\n\nWhen a card is declined we wait, then attempt the charge again.\n",
  );
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

beforeAll(async () => {
  db = await testDatabase();
  repository = makeRepository();

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

describe("resourceDetails", () => {
  it("returns nothing for an empty request rather than querying", async () => {
    expect(await resourceDetails(db, TENANT, [])).toEqual(new Map());
  });

  it("looks up the human title and canonical uri", async () => {
    const ids = await db.query<{ source_object_id: string }>(
      "SELECT source_object_id FROM resources WHERE tenant_id = $1",
      [TENANT],
    );
    const details = await resourceDetails(
      db,
      TENANT,
      ids.rows.map((row) => row.source_object_id),
    );
    const [first] = [...details.values()];
    expect(first?.title).toBeTruthy();
    expect(first?.canonicalUri).toMatch(/^file:\/\//);
  });
});

describe("decorateHits", () => {
  it("leaves a hit alone when its resource is gone", async () => {
    // A resource deleted between ranking and decoration should degrade to a
    // usable result, not an empty one.
    const [hit] = await decorateHits(db, TENANT, [
      {
        id: "does-not-exist",
        source: "git",
        container: "c",
        title: "fallback",
        url: "eil://git/does-not-exist",
      },
    ]);
    expect(hit?.title).toBe("fallback");
  });
});

describe("search results carry usable detail", () => {
  it("gives a human title, not a chunk key", async () => {
    // Before this, every result's title was the chunk's stable key — values
    // like `lines:1` or `body` — which named nothing.
    const result = await searchCommand(db, TENANT, "charge");
    const [hit] = result.hits;
    expect(hit).toBeDefined();
    expect(hit?.title).not.toMatch(/^lines:/);
    expect(hit?.title).not.toBe("body");
    expect(hit?.title).toContain("payments.md");
  }, 120_000);

  it("gives the canonical location, not an internal identifier", async () => {
    const result = await searchCommand(db, TENANT, "charge");
    expect(result.hits[0]?.url).toMatch(/^file:\/\//);
    expect(result.hits[0]?.url).not.toMatch(/^eil:\/\//);
  }, 120_000);

  it("carries a snippet of the matching text", async () => {
    const result = await searchCommand(db, TENANT, "declined");
    expect(result.hits[0]?.snippet ?? "").toMatch(/declined/i);
  }, 120_000);
});

describe("the MCP tool and the CLI answer the same question the same way", () => {
  it("returns the same documents through both surfaces", async () => {
    // They did not. `serve` read the evaluation tenant while ingestion wrote to
    // the local one, so the CLI found documents and the MCP tool — the surface
    // Amp, Copilot and Claude Code connect to — returned an empty list for the
    // identical query, from one database.
    const viewer = await localViewer(db, TENANT);
    const context: ToolContext = {
      db,
      tenantId: TENANT,
      arms: localArms(db, TENANT),
      viewer,
      audit: new InMemoryAuditSink(),
    };

    const viaCli = (await searchCommand(db, TENANT, "charge")).hits.map(
      (hit) => hit.id,
    );
    const payload = JSON.parse(
      (await callTool("search_enterprise", { query: "charge" }, context))
        .content,
    ) as {
      results: { id: string; title: string; url: string }[];
    };

    expect(viaCli.length).toBeGreaterThan(0);
    expect(payload.results.map((entry) => entry.id)).toEqual(viaCli);
  }, 300_000);

  it("gives an agent a title and a real location to act on", async () => {
    const context: ToolContext = {
      db,
      tenantId: TENANT,
      arms: localArms(db, TENANT),
      viewer: await localViewer(db, TENANT),
      audit: new InMemoryAuditSink(),
    };
    const payload = JSON.parse(
      (await callTool("search_enterprise", { query: "charge" }, context))
        .content,
    ) as {
      results: { title: string; url: string; snippet?: string }[];
    };
    const [first] = payload.results;
    expect(first?.title).toContain("payments.md");
    expect(first?.url).toMatch(/^file:\/\//);
    expect(first?.snippet ?? "").not.toBe("");
  }, 300_000);
});
