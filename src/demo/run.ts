#!/usr/bin/env node
/**
 * Self-contained demo — `pnpm demo`.
 *
 * Runs entirely on the embedded PGlite profile in a throwaway temp
 * directory: no external database, no network credentials, no admin
 * install. Every step below exercises real, merged code, including real
 * ingestion (StubConfluenceConnector/StubJiraConnector -> ingestScope) —
 * only the *source data itself* is stubbed, because no live Confluence/Jira
 * connector has landed yet.
 *
 * This script is meant to be extended, not rewritten, as more of the
 * platform lands: each `section()` below is one capability. When a live
 * connector or the MCP server replaces a stub, that section's fixture
 * data gets swapped for the real thing — the surrounding scaffolding
 * (temp DB, section headers, roadmap footer) stays the same.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StubEvent } from "../connectors/stubs.js";
import {
  StubConfluenceConnector,
  StubJiraConnector,
} from "../connectors/stubs.js";
import { runDoctor } from "../doctor/checks.js";
import { applyDiversityCap, rrf } from "../fusion/rrf.js";
import type { Arm } from "../fusion/rrf.js";
import { ingestScope } from "../ingestion/pipeline.js";
import { reconcileScope } from "../ingestion/reconcile.js";
import { createScope, listScopes } from "../scopes/service.js";
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

function confluenceEvent(
  sequence: number,
  pageId: string,
  spaceKey: string,
  title: string,
  body: string,
): StubEvent {
  return {
    sequence,
    item: {
      sourceObjectId: pageId,
      sourceVersion: "1",
      canonicalUri: `https://example.atlassian.net/wiki/spaces/${spaceKey}/pages/${pageId}`,
      title,
      body,
      metadata: { pageId, spaceKey },
      acl: [
        {
          domain: "confluence",
          principalId: `space:${spaceKey}:read`,
          effect: "allow",
        },
      ],
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
      deleted: false,
    },
  };
}

interface JiraComment {
  id: string;
  body: string;
  author?: string;
  /** Presence of visibility is what triggers a chunk-level ACL overlay. */
  visibility?: { domain: string; principalId: string };
}

function jiraEvent(
  sequence: number,
  issueKey: string,
  projectKey: string,
  title: string,
  body: string,
  comments: JiraComment[] = [],
): StubEvent {
  return {
    sequence,
    item: {
      sourceObjectId: issueKey,
      sourceVersion: "1",
      canonicalUri: `https://example.atlassian.net/browse/${issueKey}`,
      title,
      body,
      metadata: { issueKey, projectKey, comments },
      acl: [
        {
          domain: "jira",
          principalId: `project:${projectKey}:read`,
          effect: "allow",
        },
      ],
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
      deleted: false,
    },
  };
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
      selector: { keys: ["PAY"] },
      refreshMode: "manual",
      addedBy: "demo",
    });
    const jiraScope = await createScope(db, {
      tenantId: TENANT,
      source: "jira",
      selectorKind: "project",
      selector: { keys: ["PAY"] },
      refreshMode: "manual",
      addedBy: "demo",
    });
    const scopes = await listScopes(db, TENANT);
    console.log(
      `scopes registered: ${scopes.map((s) => `${s.source}:${JSON.stringify(s.selector)}`).join(", ")}`,
    );

    section("Ingestion — real pipeline, stub connectors as the source");
    const confluenceConnector = new StubConfluenceConnector([
      confluenceEvent(
        1,
        "12345",
        "PAY",
        "Payment Retry Runbook",
        "How to handle payment retries",
      ),
      confluenceEvent(
        2,
        "12399",
        "PAY",
        "Payment Architecture Overview",
        "System design for payments",
      ),
    ]);
    const jiraConnector = new StubJiraConnector([
      jiraEvent(
        1,
        "PAY-142",
        "PAY",
        "Payment retries fail silently under load",
        "Retries dropped after 3 attempts",
        [
          { id: "c1", body: "Reproduced on staging.", author: "alice" },
          {
            id: "c2",
            body: "Root cause is a support-only detail — do not surface to the reporter.",
            author: "bob",
            visibility: {
              domain: "jira-role",
              principalId: "Service Desk Team",
            },
          },
        ],
      ),
    ]);
    const confluenceCounters = await ingestScope(
      db,
      TENANT,
      confluenceScope.id,
      confluenceConnector,
    );
    const jiraCounters = await ingestScope(
      db,
      TENANT,
      jiraScope.id,
      jiraConnector,
    );
    console.log(`confluence: ${JSON.stringify(confluenceCounters)}`);
    console.log(`jira: ${JSON.stringify(jiraCounters)}`);

    section("Structural chunks — real normalizer output, stored per resource");
    const chunkSummary = await db.query<{
      source: string;
      kind: string;
      count: string;
    }>(
      `SELECT r.source, rc.kind, count(*)::text AS count
       FROM resource_chunks rc
       JOIN resources r ON r.id = rc.resource_id
       WHERE r.tenant_id = $1 AND rc.deleted_at IS NULL
       GROUP BY r.source, rc.kind
       ORDER BY r.source, rc.kind`,
      [TENANT],
    );
    for (const row of chunkSummary.rows) {
      console.log(`${row.source}: ${row.count} ${row.kind} chunk(s)`);
    }
    const overlayCount = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM chunk_aces ca
       JOIN resource_chunks rc ON rc.id = ca.chunk_id
       JOIN resources r ON r.id = rc.resource_id
       WHERE r.tenant_id = $1`,
      [TENANT],
    );
    console.log(
      `chunk-level ACL overlays: ${overlayCount.rows[0]?.count ?? "0"} (the restricted Jira comment above, not inherited from the issue)`,
    );

    section("Reconciliation — a source-side deletion, detected by ID diff");
    const confluenceConnectorAfterDeletion = new StubConfluenceConnector([
      confluenceEvent(
        1,
        "12345",
        "PAY",
        "Payment Retry Runbook",
        "How to handle payment retries",
      ),
      // "Payment Architecture Overview" (12399) is gone — simulates the
      // source deleting or moving it out of scope between polls.
    ]);
    const reconciliation = await reconcileScope(
      db,
      TENANT,
      confluenceScope.id,
      confluenceConnectorAfterDeletion,
    );
    console.log(`reconciliation: ${JSON.stringify(reconciliation)}`);
    const remainingChunks = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM resource_chunks rc
       JOIN resources r ON r.id = rc.resource_id
       WHERE r.tenant_id = $1 AND r.source = 'confluence' AND rc.deleted_at IS NULL`,
      [TENANT],
    );
    console.log(
      `confluence chunks remaining after reconciliation: ${remainingChunks.rows[0]?.count ?? "0"} (tombstoned, not deleted — recoverable until a real purge)`,
    );

    section("Rank fusion — same module that will fuse real search arms");
    const { rows } = await db.query<{
      source: string;
      title: string;
      metadata: Record<string, unknown> | string;
    }>(
      "SELECT source, title, metadata FROM resources WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY source, title",
      [TENANT],
    );
    const hits: DemoHit[] = rows.map((row) => {
      const metadata =
        typeof row.metadata === "string"
          ? (JSON.parse(row.metadata) as Record<string, unknown>)
          : row.metadata;
      const container =
        (metadata.spaceKey as string | undefined) ??
        (metadata.projectKey as string | undefined) ??
        "unknown";
      const id = (metadata.pageId ?? metadata.issueKey) as string;
      return { id, source: row.source, container, title: row.title };
    });
    const jiraHits = hits.filter((h) => h.source === "jira");
    const confluenceHits = hits.filter((h) => h.source === "confluence");
    const lexicalArm: Arm<DemoHit> = {
      name: "lexical",
      hits: [...jiraHits, ...confluenceHits],
    };
    const semanticArm: Arm<DemoHit> = {
      name: "semantic",
      hits: [...confluenceHits],
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

    section("Roadmap — what's real above, what's still stubbed");
    console.log(
      "real:    storage (PGlite), scope registry, ingestion pipeline (hashing/ACL/checkpoints),",
    );
    console.log(
      "         structural chunking, chunk-level ACL overlays, ID-diff reconciliation,",
    );
    console.log("         rank fusion, diversity cap, doctor checks");
    console.log(
      "stub:    Confluence/Jira source data above — no live connector has landed yet",
    );
    console.log(
      "next:    swap StubConfluenceConnector/StubJiraConnector for the real connectors as each one merges",
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
