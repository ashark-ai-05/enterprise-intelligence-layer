# ADR-0003 — Every connector implements one Source Feed Contract

**Status**: Proposed · **Date**: 2026-08-11

---

## Context

Six sources today (Confluence, Jira, Bitbucket, files, PDFs, Grafana metadata)
and more later. Written ad hoc, each connector invents its own idea of a cursor,
its own retry policy, its own deletion story — and the platform's freshness
guarantee becomes the weakest connector nobody has audited.

The observable symptom is always the same: "why is this document missing" is
answered differently for every source, and the answer requires reading that
connector's code.

---

## Decision

**One interface, five operations, implemented by every connector. Unsupported
operations are declared, not silently absent.**

```ts
interface SourceFeed {
  listChanges(scope, cursor, limit): Promise<{ items, nextCursor, watermark, complete }>;
  fetchItem(externalId): Promise<RawItem>;
  listAll?(scope): AsyncIterable<{ externalId, version }>;   // deletion detection
  listAcl?(scope, cursor): Promise<{ aces, nextCursor }>;    // permission lane
  listContainers(): Promise<Container[]>;
}
```

---

## Rationale

**`listChanges` returns references, not content.** Fetching bodies to discover
they are unchanged is the dominant waste in naive delta sync. A reference
carrying `version` and `updatedAt` is enough to skip most fetches: on a typical
Confluence day, the difference between 300 fetches and 40,000.

**Scope is a parameter, not configuration.** Per-scope cursors mean one broken
space does not stall an instance, and backfill and live sync can progress
independently over the same source.

**Declared capability beats silent absence.** A connector without `listAll`
cannot detect deletions, and that must be *visible* — surfaced in the freshness
metric as "deletion detection: unsupported" rather than discovered when a
deleted page keeps appearing in results.

**Two separate cursor lanes.** `listChanges` and `listAcl` have different
volumes, different SLAs and different consequences for being late. A content
backfill must never delay a permission revocation
([05](../05-acl-and-security.md) §4).

**`listContainers` is not incidental.** The container set is the ACL unit and
the partitioning unit, and expanding it per user is what keeps ANN viable
([ADR-0007](0007-container-first-acl-prefilter.md)).

---

## Consequences

**Accepted**
- Connectors that map awkwardly onto the contract need adapters. Grafana has no
  meaningful change feed — which is one of the reasons its content is not
  indexed at all ([ADR-0010](0010-what-not-to-index.md)).
- `complete: false` must be handled: a partial window **must not advance the
  cursor**.
- Sources with no version token fall back to `updatedAt`, which is weaker, and
  the overlap window must compensate.

**Enabled**
- One retry, backoff, rate-limit and proxy implementation shared by all
  connectors ([ADR-0009](0009-proxy-and-no-install-runtime.md))
- One ingestion worker with no source-specific branches
- Uniform per-cycle telemetry, so "is ingestion healthy" is one query
- A new source is one file, not a subsystem
- **Existing MCP tools can be wrapped as feeds where they expose list-plus-since
  semantics** — though most are question-shaped rather than feed-shaped, which
  is why they are not the primary transport
  ([ADR-0008](0008-mcp-tools-are-escalation-not-ingestion.md))
