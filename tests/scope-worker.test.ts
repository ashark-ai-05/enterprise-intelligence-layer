import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StubConfluenceConnector } from "../src/connectors/stubs.js";
import type {
  ConnectorBatch,
  ConnectorCursor,
  SourceConnector,
  SourceItem,
} from "../src/connectors/types.js";
import { ingestScope } from "../src/ingestion/pipeline.js";
import { claimJob, enqueueJob } from "../src/jobs/queue.js";
import {
  StaticConnectorRegistry,
  enqueueScopeSync,
  runNextScopeJob,
} from "../src/jobs/scope-worker.js";
import { createScope } from "../src/scopes/service.js";
import type { IngestionScope } from "../src/scopes/types.js";
import type { Database } from "../src/storage/database.js";
import { testDatabase } from "./helpers/database.js";

function page(id: string): SourceItem {
  return {
    sourceObjectId: id,
    sourceVersion: "1",
    canonicalUri: `https://example.test/wiki/${id}`,
    title: `Page ${id}`,
    body: `Retry guidance ${id}`,
    metadata: { pageId: id, spaceKey: "ENG" },
    acl: [],
    sourceUpdatedAt: "2026-08-11T00:00:00Z",
    deleted: false,
  };
}

class FailReconcileOnceConnector implements SourceConnector {
  readonly name = "fail-reconcile-once";
  readonly source = "confluence" as const;
  readCalls = 0;
  reconcileCalls = 0;

  constructor(private readonly delegate: StubConfluenceConnector) {}

  async read(
    scope: IngestionScope,
    cursor: ConnectorCursor | null,
  ): Promise<ConnectorBatch> {
    this.readCalls += 1;
    return this.delegate.read(scope, cursor);
  }

  async listCurrentIds(scope: IngestionScope): Promise<string[]> {
    this.reconcileCalls += 1;
    if (this.reconcileCalls === 1) throw new Error("source listing failed");
    return this.delegate.listCurrentIds(scope);
  }
}

let db: Database;
let scope: IngestionScope;

beforeEach(async () => {
  db = await testDatabase();
  scope = await createScope(db, {
    tenantId: "acme",
    source: "confluence",
    selectorKind: "space",
    selector: { keys: ["ENG"] },
    refreshMode: "manual",
    addedBy: "operator",
  });
});

afterEach(async () => {
  await db.close();
});

describe("scope job worker", () => {
  it("runs ingest and reconciliation through the durable queue", async () => {
    const connector = new StubConfluenceConnector([
      { sequence: 1, item: page("CONF-1") },
      { sequence: 2, item: page("CONF-2") },
    ]);
    await enqueueScopeSync(db, "acme", scope.id, "scope:ENG:window:1");

    const result = await runNextScopeJob(
      db,
      "acme",
      "worker-1",
      new StaticConnectorRegistry(new Map([["confluence", connector]])),
    );
    expect(result).toMatchObject({
      status: "completed",
      ingestion: { discovered: 2, created: 2 },
      reconciliation: { indexed: 2, present: 2 },
    });
    expect(
      (await db.query("SELECT 1 FROM resources WHERE deleted_at IS NULL"))
        .rowCount,
    ).toBe(2);
    const job = await db.query<{
      status: string;
      checkpoint: Record<string, unknown> | string;
    }>("SELECT status, checkpoint FROM jobs");
    expect(job.rows[0]?.status).toBe("completed");
    expect(
      typeof job.rows[0]?.checkpoint === "string"
        ? JSON.parse(job.rows[0].checkpoint)
        : job.rows[0]?.checkpoint,
    ).toMatchObject({ phase: "ingested" });
  });

  it("resumes at reconciliation without repeating a committed ingest", async () => {
    const connector = new FailReconcileOnceConnector(
      new StubConfluenceConnector([{ sequence: 1, item: page("CONF-1") }]),
    );
    const registry = new StaticConnectorRegistry(
      new Map([["confluence", connector]]),
    );
    await enqueueScopeSync(db, "acme", scope.id, "scope:ENG:window:retry");

    expect(
      await runNextScopeJob(db, "acme", "worker-1", registry),
    ).toMatchObject({ status: "pending", error: "source listing failed" });
    await db.query(
      "UPDATE jobs SET run_after = now() WHERE tenant_id = 'acme'",
    );
    expect(
      await runNextScopeJob(db, "acme", "worker-2", registry),
    ).toMatchObject({ status: "completed" });
    expect(connector.readCalls).toBe(1);
    expect(connector.reconcileCalls).toBe(2);
    expect((await db.query("SELECT 1 FROM resources")).rowCount).toBe(1);
  });

  it("rejects every ingest write from a worker whose fence was superseded", async () => {
    const connector = new StubConfluenceConnector([
      { sequence: 1, item: page("CONF-1") },
    ]);
    await enqueueScopeSync(db, "acme", scope.id, "scope:ENG:stale");
    const stale = await claimJob(db, "acme", "worker-old", 60, ["scope.sync"]);
    if (!stale) throw new Error("expected stale claim");
    await db.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [stale.id],
    );
    expect(
      await claimJob(db, "acme", "worker-new", 60, ["scope.sync"]),
    ).not.toBeNull();

    await expect(
      ingestScope(db, "acme", scope.id, connector, stale),
    ).rejects.toThrow("stale or expired job lease");
    expect((await db.query("SELECT 1 FROM resources")).rowCount).toBe(0);
  });

  it("does not consume unrelated job types", async () => {
    await enqueueJob(db, {
      tenantId: "acme",
      jobType: "report.generate",
      payload: {},
      idempotencyKey: "report:1",
    });
    expect(
      await runNextScopeJob(
        db,
        "acme",
        "scope-worker",
        new StaticConnectorRegistry(new Map()),
      ),
    ).toBeNull();
    expect(
      await claimJob(db, "acme", "report-worker", 60, ["report.generate"]),
    ).not.toBeNull();
  });
});
