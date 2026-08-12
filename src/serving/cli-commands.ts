/**
 * Operator commands: define what to index, index it, search it.
 *
 * These exist so the primary use case has a command surface rather than only a
 * library API. Everything here goes through the same code paths the tests and
 * the demo exercise — scopes, the durable queue, the real ingestion pipeline,
 * the ACL-enforcing retrieval stack.
 *
 * One deliberate refusal: `ingest` will **not** silently substitute fixture
 * data when a live connector is missing. Someone who asks to ingest their
 * Confluence space and receives synthetic pages has been actively misled, and
 * would only discover it when search returned documents that do not exist.
 */

import { confluenceConnectorFromEnv } from "../connectors/confluence.js";
import { LocalGitConnector } from "../connectors/git-local.js";
import {
  StubConfluenceConnector,
  StubFilesConnector,
  StubGitConnector,
  StubJiraConnector,
} from "../connectors/stubs.js";
import type { SourceConnector } from "../connectors/types.js";
import {
  type ConnectorRegistry,
  enqueueScopeSync,
  runNextScopeJob,
} from "../jobs/scope-worker.js";
import { DatabaseLinkSource } from "../links/store.js";
import { publishCoreGeneration } from "../publication/generations.js";
import { AuthorizedHitResolver } from "../retrieval/authorized-resolver.js";
import { GraphExpansionArm } from "../retrieval/graph-arm.js";
import { IndexedLexicalArm } from "../retrieval/indexed-arm.js";
import { retrieve } from "../retrieval/pipeline.js";
import type { RetrievalArm, Viewer } from "../retrieval/types.js";
import { createScope, listScopes, removeScope } from "../scopes/service.js";
import type { IngestionScope, Source } from "../scopes/types.js";
import {
  assignResourceContainer,
  ensureContainer,
  replaceContainerAces,
} from "../security/acl.js";
import type { Database } from "../storage/database.js";

/** Tenant for local operator use. One person, one database, one tenant. */
export function resolveTenant(env: NodeJS.ProcessEnv = process.env): string {
  return env.EIL_TENANT ?? "local";
}

/**
 * Selector shapes, per source.
 *
 * Accepting `<source> <kind> <value>` keeps the command honest about what the
 * ingestion layer actually supports, rather than inventing a friendlier
 * vocabulary that would have to be mapped back onto it.
 */
export const SELECTORS: Readonly<Record<Source, readonly string[]>> = {
  confluence: ["space", "page"],
  jira: ["project", "issues"],
  bitbucket: ["repositories"],
  git: ["repositories"],
  files: ["paths"],
};

export function buildSelector(
  kind: string,
  values: readonly string[],
): Record<string, unknown> {
  switch (kind) {
    case "space":
    case "project":
      return { keys: [...values] };
    case "page":
    case "issues":
      return { ids: [...values] };
    case "repositories":
      return { repositories: [...values], refs: ["main"] };
    case "paths":
      return { paths: [...values] };
    default:
      throw new Error(`unknown selector kind: ${kind}`);
  }
}

export interface AddScopeInput {
  readonly source: Source;
  readonly kind: string;
  readonly values: readonly string[];
  readonly schedule?: string | undefined;
  readonly addedBy: string;
}

export async function addScopeCommand(
  db: Database,
  tenantId: string,
  input: AddScopeInput,
): Promise<IngestionScope> {
  const allowed = SELECTORS[input.source];
  if (allowed === undefined) throw new Error(`unknown source: ${input.source}`);
  if (!allowed.includes(input.kind)) {
    throw new Error(
      `${input.source} accepts: ${allowed.join(", ")} — received '${input.kind}'`,
    );
  }
  if (input.values.length === 0)
    throw new Error("at least one selector value is required");

  return createScope(db, {
    tenantId,
    source: input.source,
    selectorKind: input.kind,
    selector: buildSelector(input.kind, input.values),
    refreshMode: input.schedule === undefined ? "manual" : "scheduled",
    ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
    addedBy: input.addedBy,
  });
}

export async function listScopesCommand(
  db: Database,
  tenantId: string,
): Promise<IngestionScope[]> {
  return listScopes(db, tenantId);
}

export async function removeScopeCommand(
  db: Database,
  tenantId: string,
  scopeId: string,
  purge: boolean,
): Promise<void> {
  await removeScope(db, tenantId, scopeId, purge ? "purge" : "retain");
}

/**
 * Resolves connectors, and refuses rather than substitutes.
 *
 * Live source connectors are not implemented yet. Until they are, this throws a
 * message that says so — the alternative is ingesting fixtures under the name
 * of a real space, which is worse than an error because it looks like success.
 */
export class LiveConnectorRegistry implements ConnectorRegistry {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  resolve(scope: IngestionScope): SourceConnector {
    // Git needs no API, credentials or proxy — only a checkout that already
    // exists — so it is live today while the HTTP sources wait on those facts.
    if (scope.source === "git") return new LocalGitConnector();
    if (scope.source === "confluence") {
      return confluenceConnectorFromEnv(this.env);
    }
    throw new Error(
      `No live ${scope.source} connector is implemented yet — this build is fixture-backed.\n  • see the whole pipeline end to end:  pnpm demo\n  • ingest deterministic fixtures:      eil ingest --fixture\nLive connectors are gated on the corporate environment facts from 'node scripts/probe.mjs'.`,
    );
  }
}

/** Deterministic fixture connectors, used only when explicitly requested. */
export class FixtureConnectorRegistry implements ConnectorRegistry {
  resolve(scope: IngestionScope): SourceConnector {
    switch (scope.source) {
      case "confluence":
        return new StubConfluenceConnector([]);
      case "jira":
        return new StubJiraConnector([]);
      case "git":
      case "bitbucket":
        return new StubGitConnector(scope.source, []);
      case "files":
        return new StubFilesConnector([]);
      default:
        throw new Error(`no fixture connector for ${scope.source}`);
    }
  }
}

/** The principal local single-user mode grants. */
export const LOCAL_PRINCIPAL = {
  domain: "local",
  principalId: "owner",
} as const;

/**
 * Make what was just ingested actually findable.
 *
 * Ingestion alone stores resources with no container, no ACEs and no published
 * generation — and retrieval fails closed on all three, so `ingest` followed by
 * `search` returns nothing at all. Correct, and useless.
 *
 * In local single-user mode the answer is simple and honest: one container per
 * source, granted to the person running the command, published. A shared
 * deployment must mirror the source's own permissions instead, which is why
 * this lives in the local CLI rather than in the ingestion pipeline.
 */
export async function publishLocally(
  db: Database,
  tenantId: string,
  source: Source,
): Promise<{ containerId: string; published: number }> {
  const containerId = await ensureContainer(
    db,
    tenantId,
    source,
    `local-${source}`,
    `Local ${source}`,
  );
  await replaceContainerAces(db, tenantId, containerId, [
    { ...LOCAL_PRINCIPAL, effect: "allow" },
  ]);

  const resources = await db.query<{ id: string }>(
    `SELECT id FROM resources
      WHERE tenant_id = $1 AND source = $2 AND deleted_at IS NULL`,
    [tenantId, source],
  );

  let published = 0;
  for (const { id } of resources.rows) {
    await assignResourceContainer(db, tenantId, id, containerId);
    await publishCoreGeneration(db, tenantId, id);
    published += 1;
  }

  return { containerId, published };
}

export interface IngestOutcome {
  readonly scopeId: string;
  readonly status: string;
  readonly ingestion?: Record<string, number> | undefined;
  readonly published?: number | undefined;
  readonly error?: string | undefined;
}

/**
 * Enqueue and drain sync jobs for the given scopes.
 *
 * Goes through the durable queue rather than calling the pipeline directly, so
 * a command-line run exercises the same lease, checkpoint and retry path a
 * scheduled worker would.
 */
export async function ingestCommand(
  db: Database,
  tenantId: string,
  scopes: readonly IngestionScope[],
  connectors: ConnectorRegistry,
  now: () => number = Date.now,
): Promise<IngestOutcome[]> {
  const outcomes: IngestOutcome[] = [];

  for (const scope of scopes) {
    await enqueueScopeSync(db, tenantId, scope.id, `cli:${scope.id}:${now()}`);
    const result = await runNextScopeJob(
      db,
      tenantId,
      `cli-${now()}`,
      connectors,
    );
    // Publish only what succeeded. Publishing after a failed sync would make a
    // partially-ingested scope searchable, which is worse than not searchable.
    const published =
      result?.status === "completed"
        ? (await publishLocally(db, tenantId, scope.source)).published
        : undefined;

    outcomes.push({
      scopeId: scope.id,
      status: result?.status ?? "no-job",
      ingestion: result?.ingestion as Record<string, number> | undefined,
      published,
      error: result?.error,
    });
  }

  return outcomes;
}

/** Every arm available locally: lexical over the index, plus graph expansion. */
export function localArms(db: Database, tenantId: string): RetrievalArm[] {
  const lexical = new IndexedLexicalArm(db, { tenantId });
  return [
    lexical,
    new GraphExpansionArm(
      lexical,
      new DatabaseLinkSource(db, tenantId),
      new AuthorizedHitResolver(db, tenantId),
    ),
  ];
}

/**
 * Viewer for local single-user operation.
 *
 * Sees every container in this database, which is correct for one person
 * running against their own data and **wrong for anything shared** — there the
 * viewer must come from verified request claims.
 */
export async function localViewer(
  db: Database,
  tenantId: string,
): Promise<Viewer> {
  const containers = await db.query<{ id: string }>(
    "SELECT id FROM containers WHERE tenant_id = $1",
    [tenantId],
  );
  const principals = await db.query<{ domain: string; principal_id: string }>(
    "SELECT DISTINCT principal_domain AS domain, principal_id FROM container_aces WHERE effect = 'allow'",
  );
  return {
    principal: "local",
    principals: principals.rows.map(
      (row) => `${row.domain}:${row.principal_id}`,
    ),
    containers: containers.rows.map((row) => row.id),
  };
}

export async function searchCommand(
  db: Database,
  tenantId: string,
  query: string,
  limit = 10,
): Promise<Awaited<ReturnType<typeof retrieve>>> {
  const viewer = await localViewer(db, tenantId);
  return retrieve(localArms(db, tenantId), { text: query, limit }, viewer, {
    limit,
  });
}
