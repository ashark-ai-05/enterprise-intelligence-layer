import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEntry } from "../../src/serving/tools.js";
import { CanonicalEventAuditSink } from "../../src/telemetry/canonical-event-sink.js";

// Mirrors the constraints enterprise-ai-observability's canonicalEventSchema
// enforces (src/contracts/events.ts), since this sink cannot import that
// package (private, no exports map). A change here that would fail that
// schema should fail one of these tests first.
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

function assertDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a defined value");
  return value;
}

function searchEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    principal: "user-1",
    tool: "search_enterprise",
    query: "payment retry policy",
    resultCount: 3,
    armsSkipped: [],
    aclRejected: 0,
    aclDrift: 0,
    ...overrides,
  };
}

/** Tools like list_containers/get_freshness call audit.record with no `query` key at all. */
function queryFreeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    principal: "user-1",
    tool: "list_containers",
    resultCount: 5,
    armsSkipped: [],
    aclRejected: 0,
    aclDrift: 0,
    ...overrides,
  };
}

describe("CanonicalEventAuditSink", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "eil-telemetry-"));
    path = join(dir, "nested", "events.ndjson");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function readEvents(): Promise<Record<string, unknown>[]> {
    const raw = await readFile(path, "utf8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it("creates parent directories that do not exist yet", async () => {
    const sink = new CanonicalEventAuditSink({ path, tenantId: "tenant-a" });
    await sink.record(searchEntry());

    const events = await readEvents();
    expect(events[0]).toBeDefined();
  });

  it("never carries raw query text, only a digest", async () => {
    const sink = new CanonicalEventAuditSink({ path, tenantId: "tenant-a" });
    const rawQuery = "payment retry policy for region us-east";
    await sink.record(searchEntry({ query: rawQuery }));

    const event = assertDefined((await readEvents())[0]);
    expect(JSON.stringify(event)).not.toContain(rawQuery);
    expect(
      (event.vendor as { attributes: { query_digest: string } }).attributes
        .query_digest,
    ).toMatch(DIGEST_RE);
  });

  it("omits query_digest entirely when the entry has no query", async () => {
    const sink = new CanonicalEventAuditSink({ path, tenantId: "tenant-a" });
    await sink.record(queryFreeEntry());

    const event = assertDefined((await readEvents())[0]);
    const attributes = (event.vendor as { attributes: Record<string, unknown> })
      .attributes;
    expect("query_digest" in attributes).toBe(false);
  });

  it("declares metadata_only consistently and never includes content", async () => {
    const sink = new CanonicalEventAuditSink({ path, tenantId: "tenant-a" });
    await sink.record(searchEntry());

    const event = assertDefined((await readEvents())[0]);
    const capture = event.capture as { mode: string; contentIncluded: boolean };
    expect(capture.mode).toBe("metadata_only");
    expect(capture.contentIncluded).toBe(false);
  });

  it("maps retrieval tools to operation retrieval and others to tool_call", async () => {
    const sink = new CanonicalEventAuditSink({ path, tenantId: "tenant-a" });
    await sink.record(searchEntry({ tool: "search_enterprise" }));
    await sink.record(searchEntry({ tool: "get_evidence", query: "CONF-1" }));
    await sink.record(queryFreeEntry({ tool: "list_containers" }));
    await sink.record(queryFreeEntry({ tool: "get_freshness" }));

    const events = await readEvents();
    expect(events.map((event) => event.operation)).toEqual([
      "retrieval",
      "retrieval",
      "tool_call",
      "tool_call",
    ]);
  });

  it("produces digests and an idempotency key matching the contract's format", async () => {
    const sink = new CanonicalEventAuditSink({ path, tenantId: "tenant-a" });
    await sink.record(searchEntry());

    const event = assertDefined((await readEvents())[0]);
    expect(event.idempotencyKey).toMatch(DIGEST_RE);
    expect(event.revisionDigest).toMatch(DIGEST_RE);
    expect(event.source).toEqual({
      kind: "eil",
      provider: "enterprise-intelligence-layer",
    });
  });

  it("keeps runId and traceId stable across calls but gives each a fresh spanId", async () => {
    const sink = new CanonicalEventAuditSink({ path, tenantId: "tenant-a" });
    await sink.record(searchEntry());
    await sink.record(searchEntry());

    const events = await readEvents();
    const firstTrace = assertDefined(events[0]).trace as {
      runId: string;
      traceId: string;
      spanId: string;
    };
    const secondTrace = assertDefined(events[1]).trace as {
      runId: string;
      traceId: string;
      spanId: string;
    };

    expect(secondTrace.runId).toBe(firstTrace.runId);
    expect(secondTrace.traceId).toBe(firstTrace.traceId);
    expect(secondTrace.spanId).not.toBe(firstTrace.spanId);
  });

  it("omits workflow entirely rather than fabricate correlation it does not have", async () => {
    const sink = new CanonicalEventAuditSink({ path, tenantId: "tenant-a" });
    await sink.record(searchEntry());

    const event = assertDefined((await readEvents())[0]);
    expect("workflow" in event).toBe(false);
  });

  it("appends rather than overwrites across multiple sink instances", async () => {
    const first = new CanonicalEventAuditSink({ path, tenantId: "tenant-a" });
    await first.record(searchEntry());
    const second = new CanonicalEventAuditSink({ path, tenantId: "tenant-a" });
    await second.record(searchEntry());

    const events = await readEvents();
    expect(events).toHaveLength(2);
  });
});
