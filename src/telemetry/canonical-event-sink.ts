/**
 * Converts EIL's `AuditEntry` into an `enterprise-ai-observability` canonical
 * event and appends it as NDJSON.
 *
 * Hand-built rather than importing the contract: that package is private with
 * no `exports` map, so there is no cross-repo import path today (open
 * question in enterprise-ai-observability/docs/DEMO_PLAN.md — "one repo or
 * two?"). Field names and enum values are kept in lockstep by hand with
 * `enterprise-ai-observability/src/contracts/events.ts`; `canonical-event-sink.test.ts`
 * pins the constraints that schema enforces (digest format, metadata_only
 * agreement, required-field presence) so drift between the two repos surfaces
 * as a failing test here rather than a runtime rejection on the other side.
 *
 * Redaction: `metadata_only` is only checked for internal agreement between
 * `capture.mode` and `capture.contentIncluded` on the observability side —
 * nothing there inspects `vendor.attributes`, and its event store is
 * append-only. EIL's own `AuditEntry.query` is raw user text, so it is
 * digested here, never carried as plaintext, before it leaves this process.
 *
 * Workflow correlation: `AuditEntry` and the MCP JSON-RPC surface it comes
 * from (`src/serving/mcp-stdio.ts`) carry no propagated workflowId/attemptId
 * from the calling agent — there is no mechanism today for a caller to pass
 * one. Emitted events therefore omit `workflow` entirely rather than
 * fabricate a correlation EIL cannot see. `runId`/`traceId` are stable for
 * the lifetime of one sink instance (one `eil serve` session), so calls
 * within a session still group together even without cross-system linkage.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEntry, AuditSink } from "../serving/tools.js";

const SCHEMA_VERSION = 1;
const PROVIDER = "enterprise-intelligence-layer";

const RETRIEVAL_TOOLS = new Set(["search_enterprise", "get_evidence"]);

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export interface CanonicalEventSinkOptions {
  /** NDJSON output path. Parent directories are created on first write. */
  readonly path: string;
  readonly tenantId: string;
}

export class CanonicalEventAuditSink implements AuditSink {
  private readonly runId = randomUUID();
  private readonly traceId = randomUUID();
  private dirEnsured = false;

  constructor(private readonly options: CanonicalEventSinkOptions) {}

  async record(entry: AuditEntry): Promise<void> {
    const observedAt = new Date().toISOString();
    const sourceEventId = `eil:${entry.tool}:${randomUUID()}`;
    const revisionDigest = digest(JSON.stringify(entry));
    // Matches enterprise-ai-observability's deriveIdempotencyKey (src/ingest/normalize.ts):
    // JSON.stringify the tuple rather than joining with a delimiter, so there is no
    // separator character to collide with (or, as an earlier version of this file
    // discovered, to end up as a literal control byte).
    const idempotencyKey = digest(
      JSON.stringify([
        this.options.tenantId,
        "eil",
        PROVIDER,
        sourceEventId,
        revisionDigest,
      ]),
    );

    const vendorAttributes: Record<string, string | number | boolean> = {
      tool: entry.tool,
      result_count: entry.resultCount,
      arms_skipped: entry.armsSkipped.length,
      ...(entry.aclRejected === undefined
        ? {}
        : { acl_rejected: entry.aclRejected }),
      acl_drift: entry.aclDrift,
    };
    if (entry.query !== undefined) {
      // Never carry raw query text into an append-only, metadata_only event.
      vendorAttributes.query_digest = digest(entry.query);
    }

    const event = {
      schemaVersion: SCHEMA_VERSION,
      eventId: randomUUID(),
      idempotencyKey,
      revisionDigest,
      sourceEventId,
      tenantId: this.options.tenantId,
      source: { kind: "eil", provider: PROVIDER },
      identity: { principalId: entry.principal, actorType: "unknown" as const },
      trace: { runId: this.runId, traceId: this.traceId, spanId: randomUUID() },
      timing: { observedAt, receivedAt: observedAt },
      operation: RETRIEVAL_TOOLS.has(entry.tool) ? "retrieval" : "tool_call",
      status: "succeeded" as const,
      capture: {
        mode: "metadata_only" as const,
        contentIncluded: false,
        redaction: "source" as const,
        policyVersion: "eil-audit-v1",
      },
      attributes: {},
      vendor: { namespace: "eil.v1", attributes: vendorAttributes },
    };

    await this.ensureDir();
    await appendFile(this.options.path, `${JSON.stringify(event)}\n`, "utf8");
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(dirname(this.options.path), { recursive: true });
    this.dirEnsured = true;
  }
}
