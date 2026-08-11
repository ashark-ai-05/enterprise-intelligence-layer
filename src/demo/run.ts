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
  StubGitConnector,
  StubJiraConnector,
} from "../connectors/stubs.js";
import {
  generateSyntheticCorpus,
  syntheticCorpusCounts,
  syntheticCorpusPresets,
} from "../corpus/synthetic.js";
import { runDoctor } from "../doctor/checks.js";
import { embedPendingChunks } from "../embeddings/backfill.js";
import { LocalWasmEmbedder } from "../embeddings/local-wasm.js";
import {
  EVAL_TENANT,
  defaultArms,
  evalViewer,
  runEvaluationGate,
  seedEvaluationCorpus,
} from "../eval/corpus-gate.js";
import { formatReport } from "../eval/harness.js";
import { applyDiversityCap, rrf } from "../fusion/rrf.js";
import type { Arm } from "../fusion/rrf.js";
import { ingestScope } from "../ingestion/pipeline.js";
import { reconcileScope } from "../ingestion/reconcile.js";
import { createScope, listScopes } from "../scopes/service.js";
import {
  assignResourceContainer,
  ensureContainer,
  listAuthorizedChunksForSubject,
  mapPrincipal,
  markPrincipalUnmapped,
  replaceContainerAces,
} from "../security/acl.js";
import { InMemoryAuditSink, callTool } from "../serving/tools.js";
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
      // No resource-level ACL override — access is governed entirely by
      // the container ACL set up in the Authorization section below. A
      // non-empty acl here would be a sparse per-resource override (e.g.
      // one page narrower than its space), which none of these need.
      acl: [],
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
      // Same as Confluence: no resource-level override, access comes from
      // the container ACL. Restricted comments still get their own
      // chunk-level override via `visibility` above.
      acl: [],
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

    section("Embeddings — vendored MiniLM model, offline WASM runtime");
    const localEmbedder = new LocalWasmEmbedder();
    const embeddingResult = await embedPendingChunks(db, localEmbedder);
    const vectorCount = await db.query<{ count: string; dimension: number }>(
      `SELECT count(*)::text AS count, max(dimension)::int AS dimension
       FROM chunk_vectors WHERE model_id = $1`,
      [localEmbedder.id],
    );
    console.log(
      `${embeddingResult.embedded} changed chunk(s) embedded locally; ${vectorCount.rows[0]?.count ?? "0"} stored at ${vectorCount.rows[0]?.dimension ?? 0} dimensions`,
    );
    console.log(`model: ${localEmbedder.id}; remote model access: none`);

    section("Publication — atomic catalog, ACL, and lexical generations");
    const publications = await db.query<{
      resources: string;
      published: string;
      projections: string;
    }>(
      `SELECT
        count(DISTINCT r.id)::text AS resources,
        count(DISTINCT g.id)::text AS published,
        count(gp.projection)::text AS projections
       FROM resources r
       LEFT JOIN index_generations g ON g.id = r.published_generation_id
       LEFT JOIN generation_projections gp ON gp.generation_id = g.id
       WHERE r.tenant_id = $1`,
      [TENANT],
    );
    console.log(
      `${publications.rows[0]?.resources ?? "0"} resource(s), ${publications.rows[0]?.published ?? "0"} published manifest(s), ${publications.rows[0]?.projections ?? "0"} ready projections`,
    );
    console.log(
      "incomplete manifests never replace the current published generation",
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

    section(
      "Authorization — mapped/unmapped principals, container ACLs, chunk overrides",
    );
    const confluenceContainerId = await ensureContainer(
      db,
      TENANT,
      "confluence",
      "PAY",
      "PAY space",
    );
    const jiraContainerId = await ensureContainer(
      db,
      TENANT,
      "jira",
      "PAY",
      "PAY project",
    );
    // These fixture ACEs use individual accounts. Shared group principals are
    // supported through the many-to-many mapping table; a real authority
    // connector will populate those memberships later.
    await replaceContainerAces(db, TENANT, confluenceContainerId, [
      { domain: "confluence", principalId: "user:alice", effect: "allow" },
      { domain: "confluence", principalId: "user:carol", effect: "allow" },
    ]);
    await replaceContainerAces(db, TENANT, jiraContainerId, [
      { domain: "jira", principalId: "user:alice", effect: "allow" },
      { domain: "jira", principalId: "user:carol", effect: "allow" },
      { domain: "jira", principalId: "user:eve", effect: "allow" },
    ]);
    const { rows: resourceRows } = await db.query<{
      id: string;
      source: string;
    }>(
      "SELECT id, source FROM resources WHERE tenant_id = $1 AND deleted_at IS NULL",
      [TENANT],
    );
    for (const resource of resourceRows) {
      const containerId =
        resource.source === "confluence"
          ? confluenceContainerId
          : jiraContainerId;
      await assignResourceContainer(db, TENANT, resource.id, containerId);
    }

    await mapPrincipal(db, TENANT, "alice@example.com", {
      domain: "confluence",
      principalId: "user:alice",
    });
    await mapPrincipal(db, TENANT, "alice@example.com", {
      domain: "jira",
      principalId: "user:alice",
    });
    await mapPrincipal(db, TENANT, "carol@example.com", {
      domain: "confluence",
      principalId: "user:carol",
    });
    await mapPrincipal(db, TENANT, "carol@example.com", {
      domain: "jira",
      principalId: "user:carol",
    });
    await mapPrincipal(db, TENANT, "carol@example.com", {
      domain: "jira-role",
      principalId: "Service Desk Team",
    });
    await mapPrincipal(db, TENANT, "eve@example.com", {
      domain: "jira",
      principalId: "user:eve",
    });

    async function accessSummary(subject: string): Promise<string> {
      const chunks = await listAuthorizedChunksForSubject(
        db as Database,
        TENANT,
        subject,
      );
      const restricted = chunks.some((c) => c.stableKey === "comment:c2");
      return `${chunks.length} chunk(s) visible${restricted ? ", including the restricted comment" : " — restricted comment stays hidden"}`;
    }

    console.log(
      `alice (mapped, no Service Desk role):  ${await accessSummary("alice@example.com")}`,
    );
    console.log(
      `carol (mapped + Service Desk role):    ${await accessSummary("carol@example.com")}`,
    );
    console.log(
      `dave  (never mapped — fail closed):    ${await accessSummary("dave@example.com")}`,
    );
    console.log(
      `eve   (mapped, before revocation):     ${await accessSummary("eve@example.com")}`,
    );
    await markPrincipalUnmapped(db, TENANT, {
      domain: "jira",
      principalId: "user:eve",
    });
    console.log(
      `eve   (same principal, after revocation): ${await accessSummary("eve@example.com")}`,
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
      "Synthetic corpus — proving scale, not just the hand-crafted fixture",
    );
    const corpusStress = process.env.EIL_DEMO_CORPUS === "stress";
    const corpusPreset = corpusStress
      ? syntheticCorpusPresets.stress
      : syntheticCorpusPresets.ci;
    const corpus = generateSyntheticCorpus(corpusPreset);
    const corpusCounts = syntheticCorpusCounts(corpus);
    console.log(
      `preset: ${corpusStress ? "stress" : "ci"} (seed ${corpus.seed}) — set EIL_DEMO_CORPUS=stress for ~5,000 objects instead`,
    );
    console.log(
      `generated: ${corpusCounts.confluenceEvents} confluence, ${corpusCounts.jiraEvents} jira, ${corpusCounts.gitEvents} git change events, ` +
        `${corpusCounts.links} cross-source links, ${corpusCounts.relevanceJudgments} relevance judgments, ${corpusCounts.aclCases} adversarial ACL cases`,
    );

    const CORPUS_TENANT = "corpus-demo";
    const corpusConfluenceScope = await createScope(db, {
      tenantId: CORPUS_TENANT,
      source: "confluence",
      selectorKind: "space",
      selector: { keys: ["ENG", "SEC"] },
      refreshMode: "manual",
      addedBy: "demo",
    });
    const corpusJiraScope = await createScope(db, {
      tenantId: CORPUS_TENANT,
      source: "jira",
      selectorKind: "project",
      selector: { keys: ["PAY"] },
      refreshMode: "manual",
      addedBy: "demo",
    });
    const repoIds = Array.from(
      { length: corpusPreset.repositories },
      (_, index) => `service-${index}`,
    );
    const corpusGitScope = await createScope(db, {
      tenantId: CORPUS_TENANT,
      source: "git",
      selectorKind: "repository",
      selector: { repositories: repoIds, refs: ["main"] },
      refreshMode: "manual",
      addedBy: "demo",
    });

    const corpusIngestStart = Date.now();
    const corpusConfluenceCounters = await ingestScope(
      db,
      CORPUS_TENANT,
      corpusConfluenceScope.id,
      new StubConfluenceConnector(corpus.events.confluence),
    );
    const corpusJiraCounters = await ingestScope(
      db,
      CORPUS_TENANT,
      corpusJiraScope.id,
      new StubJiraConnector(corpus.events.jira),
    );
    const corpusGitCounters = await ingestScope(
      db,
      CORPUS_TENANT,
      corpusGitScope.id,
      new StubGitConnector("git", corpus.events.git),
    );
    const corpusIngestMs = Date.now() - corpusIngestStart;
    console.log(
      `ingested in ${corpusIngestMs}ms — confluence: ${JSON.stringify(corpusConfluenceCounters)}`,
    );
    console.log(`jira: ${JSON.stringify(corpusJiraCounters)}`);
    console.log(`git: ${JSON.stringify(corpusGitCounters)}`);

    const corpusChunkTotal = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM resource_chunks rc
       JOIN resources r ON r.id = rc.resource_id
       WHERE r.tenant_id = $1 AND rc.deleted_at IS NULL`,
      [CORPUS_TENANT],
    );
    console.log(
      `structural chunks stored: ${corpusChunkTotal.rows[0]?.count ?? "0"}`,
    );

    // Container ACLs come straight from the corpus's own manifest — not
    // hand-picked, so this exercises whatever the generator actually shipped.
    const corpusContainerIds = new Map<string, string>();
    for (const key of Object.keys(corpus.containerAces)) {
      const [source, sourceContainerId] = key.split(":") as [string, string];
      corpusContainerIds.set(
        key,
        await ensureContainer(
          db,
          CORPUS_TENANT,
          source,
          sourceContainerId,
          key,
        ),
      );
    }
    for (const [key, aces] of Object.entries(corpus.containerAces)) {
      const containerId = corpusContainerIds.get(key);
      if (containerId)
        await replaceContainerAces(db, CORPUS_TENANT, containerId, aces);
    }
    const { rows: corpusResourceRows } = await db.query<{
      id: string;
      source: string;
      metadata: Record<string, unknown> | string;
    }>(
      "SELECT id, source, metadata FROM resources WHERE tenant_id = $1 AND deleted_at IS NULL",
      [CORPUS_TENANT],
    );
    for (const resource of corpusResourceRows) {
      const metadata =
        typeof resource.metadata === "string"
          ? (JSON.parse(resource.metadata) as Record<string, unknown>)
          : resource.metadata;
      const sourceContainerId =
        resource.source === "confluence"
          ? (metadata.spaceKey as string | undefined)
          : resource.source === "jira"
            ? (metadata.projectKey as string | undefined)
            : (metadata.repository as string | undefined);
      const containerId = sourceContainerId
        ? corpusContainerIds.get(`${resource.source}:${sourceContainerId}`)
        : undefined;
      if (containerId)
        await assignResourceContainer(
          db,
          CORPUS_TENANT,
          resource.id,
          containerId,
        );
    }
    console.log(
      `${corpusContainerIds.size} container(s) authorized, ${corpusResourceRows.length} resource(s) assigned`,
    );

    section("Adversarial ACL case — from the corpus manifest, not hand-picked");
    const [aclCase] = corpus.aclCases;
    if (aclCase) {
      const [allowedDomain, allowedPrincipalId] =
        aclCase.allowedPrincipal.split(":") as [string, string];
      const [deniedDomain, deniedPrincipalId] = aclCase.deniedPrincipal.split(
        ":",
      ) as [string, string];
      await mapPrincipal(db, CORPUS_TENANT, "corpus-allowed@example.com", {
        domain: allowedDomain,
        principalId: allowedPrincipalId,
      });
      await mapPrincipal(db, CORPUS_TENANT, "corpus-denied@example.com", {
        domain: deniedDomain,
        principalId: deniedPrincipalId,
      });
      const allowedChunks = await listAuthorizedChunksForSubject(
        db,
        CORPUS_TENANT,
        "corpus-allowed@example.com",
      );
      const deniedChunks = await listAuthorizedChunksForSubject(
        db,
        CORPUS_TENANT,
        "corpus-denied@example.com",
      );
      const sees = (chunks: typeof allowedChunks) =>
        chunks.some((chunk) => chunk.sourceObjectId === aclCase.sourceObjectId);
      console.log(
        `${aclCase.sourceObjectId} (${aclCase.level}-level override): allowedPrincipal sees it = ${sees(allowedChunks)}, deniedPrincipal sees it = ${sees(deniedChunks)}`,
      );
      console.log(
        "(deniedPrincipal otherwise has broad container access — this is a resource/chunk-level override beating that grant, not a missing container ACE)",
      );
    }

    section(
      "Evaluation — retrieval quality, measured against the corpus's own relevance labels",
    );
    const evalSeed = await seedEvaluationCorpus(db, syntheticCorpusPresets.ci);
    const evalReport = await runEvaluationGate(db, evalSeed, undefined, {
      limit: 20,
    });
    console.log(formatReport(evalReport));
    console.log(
      "same arms, same gate CI runs on every PR — this is the number a ranking change has to beat, not a demo-only stat",
    );

    section("MCP tool surface — the same choke point Amp/Copilot will call");
    const mcpAudit = new InMemoryAuditSink();
    const mcpContext = {
      db,
      tenantId: EVAL_TENANT,
      arms: defaultArms(db),
      viewer: evalViewer(evalSeed.containerIds),
      audit: mcpAudit,
    };
    const searchQuery =
      evalSeed.corpus.relevance[0]?.query ?? "payment retries";
    const searchResult = await callTool(
      "search_enterprise",
      { query: searchQuery, limit: 3 },
      mcpContext,
    );
    const parsedSearch = JSON.parse(searchResult.content) as {
      results: { id: string; source: string; title: string }[];
    };
    console.log(
      `search_enterprise("${searchQuery}"): ${parsedSearch.results.length} result(s)`,
    );
    for (const hit of parsedSearch.results) {
      console.log(`  - [${hit.source}] ${hit.id} ${hit.title}`);
    }

    const firstId = parsedSearch.results[0]?.id;
    if (firstId) {
      const evidence = await callTool(
        "get_evidence",
        { id: firstId },
        mcpContext,
      );
      const parsedEvidence = JSON.parse(evidence.content) as {
        found: boolean;
        body?: string;
      };
      console.log(
        `get_evidence("${firstId}"): found=${parsedEvidence.found}, ${parsedEvidence.body?.length ?? 0} byte(s) of body`,
      );
    }

    const missing = await callTool(
      "get_evidence",
      { id: "does-not-exist" },
      mcpContext,
    );
    console.log(
      `get_evidence("does-not-exist"): ${missing.content.replace(/\s+/g, " ")}`,
    );
    console.log(
      "(a forbidden id would return the exact same shape — confirming existence would leak it)",
    );

    const containers = await callTool("list_containers", {}, mcpContext);
    console.log(`list_containers: ${containers.content.replace(/\s+/g, " ")}`);

    const freshness = await callTool("get_freshness", {}, mcpContext);
    console.log(`get_freshness: ${freshness.content.replace(/\s+/g, " ")}`);

    console.log(
      `audit: ${mcpAudit.entries.length} entries recorded (query text and result counts only — never result content)`,
    );

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
    console.log(
      "         principal mapping, container ACLs, deny-wins fail-closed authorization,",
    );
    console.log(
      "         offline WASM embeddings, changed-chunk vectors, rank fusion,",
    );
    console.log(
      "         atomic publication, auditable deletion lifecycle, diversity cap, doctor checks,",
    );
    console.log(
      "         a deterministic synthetic corpus proving the same pipeline holds at scale,",
    );
    console.log(
      "         indexed lexical + graph-expansion retrieval arms, persisted provenance-bearing",
    );
    console.log(
      "         links, durable fenced jobs with retry/DLQ, a measured ranking regression gate,",
    );
    console.log(
      "         and the MCP tool surface (search_enterprise, get_evidence, list_containers,",
    );
    console.log(
      "         get_freshness) — the same choke point `node dist/cli.js serve` exposes over stdio",
    );
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
