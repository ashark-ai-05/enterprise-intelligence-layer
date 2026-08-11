#!/usr/bin/env node
/**
 * Self-contained demo — `pnpm demo`.
 *
 * Runs entirely on the embedded PGlite profile in a throwaway temp
 * directory: no external database, no network credentials, no admin
 * install. Every step below exercises real, merged code — nothing here
 * is a mock of the platform, only the *source data* (Confluence/Jira
 * fixtures) is stubbed, because live connectors haven't landed yet.
 *
 * This script is meant to be extended, not rewritten, as more of the
 * platform lands: each `section()` below is one capability. When a real
 * connector or the MCP server replaces a fixture, that section's fixture
 * calls get swapped for the real thing — the surrounding scaffolding
 * (temp DB, section headers, roadmap footer) stays the same.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../doctor/checks.js";
import { applyDiversityCap, rrf } from "../fusion/rrf.js";
import type { Arm } from "../fusion/rrf.js";
import {
  attachResourceToScope,
  createScope,
  listScopes,
} from "../scopes/service.js";
import type { Database } from "../storage/database.js";
import { detectCapabilities, openDatabase } from "../storage/database.js";
import { migrate } from "../storage/migrations.js";

const TENANT = "demo";

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

interface DemoHit {
  id: string;
  source: string;
  container: string;
  title: string;
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "eil-demo-"));
  let db: Database | undefined;

  try {
    section("Storage — embedded PGlite, zero setup");
    db = await openDatabase({ dataDirectory: join(dataDir, "catalog") });
    const applied = await migrate(db);
    const capabilities = await detectCapabilities(db);
    console.log(`data directory: ${dataDir}`);
    console.log(
      `migrations applied: ${applied.length ? applied.join(", ") : "(already current)"}`,
    );
    console.log(`capabilities: ${JSON.stringify(capabilities)}`);

    section("Scope registry — explicit allowlist, not whole-instance crawl");
    const confluenceScope = await createScope(db, {
      tenantId: TENANT,
      source: "confluence",
      selectorKind: "space",
      selector: { key: "PAY" },
      refreshMode: "manual",
      addedBy: "demo",
    });
    const jiraScope = await createScope(db, {
      tenantId: TENANT,
      source: "jira",
      selectorKind: "project",
      selector: { key: "PAY" },
      refreshMode: "manual",
      addedBy: "demo",
    });
    const scopes = await listScopes(db, TENANT);
    console.log(
      `scopes registered: ${scopes.map((s) => `${s.source}:${JSON.stringify(s.selector)}`).join(", ")}`,
    );

    section("Attaching fixture resources (stand-in for a real connector)");
    const fixtures: { scopeId: string; hit: DemoHit }[] = [
      {
        scopeId: confluenceScope.id,
        hit: {
          id: "12345",
          source: "confluence",
          container: "PAY",
          title: "Payment Retry Runbook",
        },
      },
      {
        scopeId: confluenceScope.id,
        hit: {
          id: "12399",
          source: "confluence",
          container: "PAY",
          title: "Payment Architecture Overview",
        },
      },
      {
        scopeId: jiraScope.id,
        hit: {
          id: "PAY-142",
          source: "jira",
          container: "PAY",
          title: "Payment retries fail silently under load",
        },
      },
    ];
    for (const { scopeId, hit } of fixtures) {
      await attachResourceToScope(db, scopeId, {
        tenantId: TENANT,
        source: hit.source,
        sourceObjectId: hit.id,
        canonicalUri: `https://example.atlassian.net/${hit.source}/${hit.id}`,
        title: hit.title,
      });
    }
    console.log(`resources attached: ${fixtures.length}`);

    section("Rank fusion — same module that will fuse real search arms");
    const lexicalArm: Arm<DemoHit> = {
      name: "lexical",
      hits: [fixtures[2]?.hit, fixtures[0]?.hit].filter(
        (hit): hit is DemoHit => hit !== undefined,
      ),
    };
    const semanticArm: Arm<DemoHit> = {
      name: "semantic",
      hits: [fixtures[0]?.hit, fixtures[1]?.hit].filter(
        (hit): hit is DemoHit => hit !== undefined,
      ),
    };
    const fused = rrf([lexicalArm, semanticArm]);
    const capped = applyDiversityCap(fused, { maxPerSource: 2 });
    for (const [rank, result] of capped.entries()) {
      console.log(
        `${rank + 1}. [${result.hit.source}] ${result.hit.title} — score ${result.score.toFixed(4)}`,
      );
    }

    section(
      "Doctor — the same environment facts CI and a corp machine both see",
    );
    const report = await runDoctor();
    for (const check of report.checks) {
      const symbol =
        check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "–";
      console.log(`${symbol} ${check.title}: ${check.evidence}`);
    }

    section("Roadmap — what's real above, what's still a fixture");
    console.log(
      "real:    storage (PGlite), scope registry, rank fusion, diversity cap, doctor checks",
    );
    console.log(
      "fixture: Confluence/Jira content above — no live connector has landed yet",
    );
    console.log(
      "next:    swap the fixture block for real connector output as each one merges",
    );
  } finally {
    await db?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error("demo failed:", error);
  process.exitCode = 1;
});
